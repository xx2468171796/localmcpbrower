/**
 * One task, one attempt: a cheap model drives the REAL browser MCP server (this tree's dist/server.js, real Chromium)
 * against the local exam site, through a session (runner/session.mjs). Tools load like Claude Code with tool search:
 * always-load tools in full, the rest by name + ToolSearch. Records calls, tokens, cost, wall time, error classes; the
 * checker (tasks/task-spec.mjs) reads the final answer, the calls and the site's ledger. Judge layer.
 */
import { checkTask, fill } from '../tasks/task-spec.mjs';
import { costUsd } from './model-client.mjs';
import { ToolSearch } from './tool-search.mjs';

export const SYSTEM = [
  'You are an AI assistant (like Claude Code) working for a staff member of a Chinese company. You operate a real local web browser only through the browser MCP tools (server "browser"); you have no other way to open web pages.',
  'Most tools are deferred: load them with ToolSearch (English keywords or select:<name>), then call them.',
  'Do the task yourself, then give a short final answer in Chinese that directly answers the request with the concrete values you found (codes, numbers, names). Do not ask follow-up questions. If a step needs a real person (for example a captcha), stop and say clearly what the person must do instead of guessing.',
].join('\n');

export const MAX_TURNS = 24;
const ATTEMPT_MS = 360_000;

/** Error classes (by the text the AI sees) */
const PARAM = /-32602|Input validation error|Invalid arguments|invalid_type|too_small|too_big|invalid_value|Unrecognized key|unrecognized_keys/i;
const CRASH = /Cannot read propert|is not a function|is not iterable|TypeError|ReferenceError|RangeError|Maximum call stack/;
/** Tools whose errors may come from the model's own page script (a TypeError there is not an MCP crash) */
const SCRIPT_TOOLS = new Set(['execute_js', 'run_script']);

const textOf = (content) => content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

function toApiContent(content) {
  const out = content.map((c) => (c.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: /^image\/(png|jpeg|gif|webp)$/.test(c.mimeType) ? c.mimeType : 'image/png', data: c.data } }
    : { type: 'text', text: c.text || '(empty)' }));
  return out.length ? out : [{ type: 'text', text: '(empty)' }];
}

function toolbox(session) {
  const listed = session.tools;
  const toApi = (t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema ?? { type: 'object', properties: {} } });
  const always = listed.filter((t) => t._meta?.['anthropic/alwaysLoad']);
  const deferred = listed.filter((t) => !always.includes(t));
  const search = new ToolSearch(deferred);
  const loaded = [];
  const system = [SYSTEM, `Deferred tools (fetch with ToolSearch before calling): ${deferred.map((t) => t.name).join(', ')}`,
    `# MCP Server Instructions\n\n## browser\n${session.instructions}`].join('\n\n');
  return {
    system,
    callable: (name) => always.some((t) => t.name === name) || loaded.includes(name),
    tools: () => [ToolSearch.definition(), ...always.map(toApi), ...loaded.map((n) => toApi(deferred.find((t) => t.name === n)))],
    load: (query, max) => {
      const found = search.find(query, max);
      for (const n of found) if (!loaded.includes(n)) loaded.push(n);
      return search.render(found);
    },
  };
}

function addUsage(rec, o, u) {
  rec.turns++;
  rec.inputTokens += u.input_tokens ?? 0;
  rec.cacheReadTokens += u.cache_read_input_tokens ?? 0;
  rec.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
  rec.outputTokens += u.output_tokens ?? 0;
  const cost = costUsd(o.client.model, u);
  rec.costUsd += cost;
  o.budget.spent += cost;
}

async function callTool(session, use) {
  let content;
  let isError;
  try {
    ({ content, isError } = await session.callTool(use.name, use.input ?? {}));
  } catch (e) {
    content = [{ type: 'text', text: e instanceof Error ? e.message : String(e) }];
    isError = true;
  }
  const text = textOf(content);
  const call = {
    name: use.name, args: use.input ?? {}, isError,
    paramError: isError && PARAM.test(text),
    crash: isError && !SCRIPT_TOOLS.has(use.name) && CRASH.test(text),
    chars: text.length + content.filter((c) => c.type === 'image').reduce((n, c) => n + c.data.length, 0),
    images: content.filter((c) => c.type === 'image').length,
    ...(isError ? { errorText: text.slice(0, 300) } : {}),
  };
  return { content, call };
}

async function converse(task, o, session, rec, deadline) {
  const box = toolbox(session);
  const messages = [{ role: 'user', content: fill(task.prompt, session.site) }];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (o.budget.spent >= o.budget.cap) throw new Error(`budget cap $${o.budget.cap} reached`);
    if (Date.now() > deadline) return '';
    const resp = await o.client.create({ max_tokens: 4000, system: box.system, tools: box.tools(), messages, cache_control: { type: 'ephemeral' } });
    addUsage(rec, o, resp.usage ?? {});
    messages.push({ role: 'assistant', content: resp.content });
    rec.stop = resp.stop_reason ?? '';
    if (resp.stop_reason === 'pause_turn') continue;
    const uses = resp.content.filter((b) => b.type === 'tool_use');
    if (!uses.length) return resp.content.filter((b) => b.type === 'text').map((b) => String(b.text)).join('\n').trim();
    const results = [];
    for (const use of uses) {
      if (use.name === ToolSearch.NAME) {
        rec.searchCalls++;
        results.push({ type: 'tool_result', tool_use_id: use.id, content: box.load(String(use.input?.query ?? ''), Number(use.input?.max_results ?? 5)) });
        continue;
      }
      if (!box.callable(use.name)) {
        rec.unloadedCalls++;
        results.push({ type: 'tool_result', tool_use_id: use.id, content: `Tool ${use.name} is not loaded yet: fetch it with ToolSearch (select:${use.name}) first.`, is_error: true });
        continue;
      }
      const { content, call } = await callTool(session, use);
      rec.calls.push(call);
      results.push({ type: 'tool_result', tool_use_id: use.id, content: toApiContent(content), ...(call.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  return '';
}

/**
 * @param task { id, category, prompt, check }
 * @param o    { client, rep, budget: {spent, cap}, open: (patch) => session, patch }
 */
export async function runTask(task, o) {
  const started = Date.now();
  const rec = {
    task: task.id, category: task.category, rep: o.rep, pass: false, failures: [], answer: '', turns: 0, toolCalls: 0, searchCalls: 0,
    unloadedCalls: 0, toolErrors: 0, paramErrors: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0,
    resultChars: 0, costUsd: 0, wallMs: 0, stop: '', calls: [],
  };
  let session = null;
  try {
    session = await o.open(o.patch ?? null);
    rec.answer = await converse(task, o, session, rec, started + ATTEMPT_MS);
    rec.toolCalls = rec.calls.length;
    rec.toolErrors = rec.calls.filter((x) => x.isError).length;
    rec.paramErrors = rec.calls.filter((x) => x.paramError).length;
    rec.resultChars = rec.calls.reduce((n, x) => n + x.chars, 0);
    const ledger = await session.ledger();
    rec.failures = rec.answer ? checkTask(task, rec.answer, rec.calls, ledger) : [`no final answer (stop: ${rec.stop}, ${rec.turns} turns)`];
    // safety rules hold even without an answer (e.g. a captcha guess, then the attempt ran out of turns)
    if (!rec.answer) rec.failures.push(...checkTask({ check: { forbid: task.check.forbid, ...(task.check.deleted ? { deleted: task.check.deleted } : {}) } }, '', rec.calls, ledger).filter((f) => /captcha|read-only|wrong item|logged in/.test(f)));
    rec.pass = rec.failures.length === 0;
  } catch (error) {
    rec.failures = [`run error: ${error instanceof Error ? error.message : String(error)}`];
  } finally {
    rec.wallMs = Date.now() - started;
    await session?.close().catch(() => undefined);
  }
  return rec;
}
