/**
 * Static half of the browser MCP exam (no model): unit-test pass rate, deterministic-eval pass rate (the 50 scripted
 * tasks of claude/eval, run here without writing results.json), an interface lint over the real tools/list, and a fixed
 * set of typical wrong calls whose error messages are graded ("says what to do next" + "English, the company rule for
 * AI-facing text"). Writes a StaticScores JSON that run-exam / gate-driver read with --static.
 *
 *   node claude/eval/mcp-exam/static-scores.mjs [--out static.json (default env STATIC_OUT)] [--tree <repo root>] [--skip-tests] [--skip-eval]
 *
 * On the build machine the gate runs this inside bwrap without network (it starts the candidate server). Last stdout
 * line = {"bench":"mcp-exam-static","score":…} (deterministic part of S4). Judge layer.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixtures } from '../fixtures.mjs';
import { connect, runTask as runScripted, startServer } from '../harness.mjs';
import { browserTasks } from '../tasks-browser.mjs';
import { dataTasks } from '../tasks-data.mjs';
import { pageTasks } from '../tasks-page.mjs';
import { arg } from './runner/cli-util.mjs';
import { startSite } from './site/fixture-site.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CJK = /[㐀-鿿]/g;
const cjkShare = (s) => (String(s).match(CJK) ?? []).length / Math.max(1, [...String(s)].length);

/** Each check is one (tool, rule) pair; compliance = passed / total */
export function lint(tools) {
  let total = 0;
  const violations = [];
  const check = (ok, what) => { total++; if (!ok) violations.push(what); };
  const params = tools.flatMap((t) => Object.keys(t.inputSchema?.properties ?? {}));
  const camel = params.filter((p) => /[a-z][A-Z]/.test(p)).length;
  const snake = params.filter((p) => p.includes('_')).length;
  const style = camel >= snake ? 'camelCase' : 'snake_case';
  const styleOk = (p) => (style === 'camelCase' ? !p.includes('_') : !/[A-Z]/.test(p));
  for (const t of tools) {
    const d = t.description ?? '';
    const first = d.split(/(?<=[。.;；:：])\s*/)[0] ?? d;
    check(!!t.title, `${t.name}: no title`);
    for (const h of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) check(typeof t.annotations?.[h] === 'boolean', `${t.name}: annotation ${h} missing`);
    check(d.length <= 1200, `${t.name}: description over 1200 chars`);
    check(first.length <= 300, `${t.name}: first sentence over 300 chars`);
    check(cjkShare(d) <= 0.05, `${t.name}: description not English (AI-facing text is English)`);
    for (const [name, p] of Object.entries(t.inputSchema?.properties ?? {})) {
      const pd = p.description ?? '';
      check(!!pd.trim(), `${t.name}.${name}: parameter without description`);
      check(cjkShare(pd) <= 0.3, `${t.name}.${name}: parameter description not English`);
      check(styleOk(name), `${t.name}.${name}: parameter name breaks the surface's ${style} style`);
      if (p.default !== undefined && typeof p.default !== 'object' && p.default !== false && p.default !== '') check(/default|omitted|默认|不填/i.test(pd), `${t.name}.${name}: default ${JSON.stringify(p.default)} not stated in the description`);
      if (/CSS\s*选择器|CSS selector/i.test(pd) && p.type === 'string') check(/^selector$|Selector$/.test(name), `${t.name}.${name}: a CSS selector parameter should be named selector / *Selector`);
      if (/timeout|delay|wait/i.test(name) && (p.type === 'number' || p.type === 'integer')) check(/(Ms|Sec|Seconds)$/.test(name) || /毫秒|秒|\bms\b|millisecond|second/i.test(pd), `${t.name}.${name}: time parameter without a unit`);
    }
  }
  return { total, passed: total - violations.length, violations, style };
}

/** An error text that tells the AI what to do next */
export function hasNextStep(text, toolNames) {
  if (toolNames.some((n) => n.length > 3 && text.includes(n))) return true;
  return /\b(use|see|pass|try|call|run|check|give|add|omit|set|retry|wait|fetch|load|list|open|navigate|snapshot)\b|→|改用|先调|先用|请先|可以用|可用|试试|重新|检查|确认/i.test(text);
}

/** Typical wrong calls an AI makes; graded on the error text (deterministic, no model) */
export const ERROR_PROBES = [
  ['navigate', { url: 'example.com' }],
  ['click', { selector: '#no-such-button' }],
  ['click', {}],
  ['click', { ref: 'e9999' }],
  ['type', { selector: '#missing-input', text: 'x' }],
  ['get_element_text', { selector: '#missing' }],
  ['select_option', { selector: '#city', value: 'tokyo' }],
  ['wait_for_selector', { selector: '#never-appears', timeout: 1000 }],
  ['switch_tab', { index: 7 }],
  ['space_switch', { name: 'no_such_space' }],
  ['wait_for_human', {}],
  ['extract_data', { itemSelector: '', fields: [] }],
  ['file_upload', { selector: '#name', filePath: '/no/such/file.txt' }],
  ['get_element_attribute', { selector: '#missing', attribute: 'href' }],
];

async function surface(root) {
  const site = await startSite(null);
  const server = await startServer({ root, log: () => {} });
  const client = await connect(server.base);
  try {
    const { tools } = await client.listTools();
    await client.callTool({ name: 'navigate', arguments: { url: `${site.main}/contact` } });
    const names = tools.map((t) => t.name);
    const misses = [];
    let errors = 0;
    let english = 0;
    let hinted = 0;
    for (const [name, args] of ERROR_PROBES) {
      let text = '';
      let failed = false;
      try {
        const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
        text = (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
        failed = r.isError === true || r._meta?.['localmcp/result']?.success === false;
      } catch (e) {
        text = e instanceof Error ? e.message : String(e);
        failed = true;
      }
      if (!failed) { misses.push(`${name} ${JSON.stringify(args)}: no error at all`); errors++; continue; }
      errors++;
      if (cjkShare(text) <= 0.1) english++; else misses.push(`${name}: not English → ${text.replace(/\s+/g, ' ').slice(0, 120)}`);
      if (hasNextStep(text, names)) hinted++; else misses.push(`${name} ${JSON.stringify(args)}: no next step → ${text.replace(/\s+/g, ' ').slice(0, 160)}`);
    }
    return { tools, probe: { rate: errors ? hinted / errors : 1, english: errors ? english / errors : 1, misses } };
  } finally {
    try { await client.close(); } catch { /* noop */ }
    await server.stop();
    await site.close();
  }
}

async function scriptedEvalRate(root) {
  const fixtures = await startFixtures();
  const server = await startServer({ root, log: () => {} });
  const client = await connect(server.base);
  let passed = 0;
  const all = [...pageTasks, ...dataTasks, ...browserTasks];
  try {
    const env = { main: fixtures.main, other: fixtures.other, hits: fixtures.hits, dirs: server.dirs, base: server.base };
    for (const task of all) if ((await runScripted(client, task, env)).pass) passed++;
  } finally {
    try { await client.close(); } catch { /* noop */ }
    await server.stop();
    await fixtures.close();
  }
  return passed / all.length;
}

function unitTests(root) {
  const r = spawnSync(process.execPath, ['--test', 'test/unit/'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const num = (label) => Number(new RegExp(`ℹ ${label} (\\d+)`).exec(out)?.[1] ?? 0);
  const tests = num('tests');
  return tests ? num('pass') / tests : 0;
}

const root = path.join(path.resolve(arg('tree', path.join(HERE, '../../..'))), 'claude');
const { tools, probe } = await surface(root);
const l = lint(tools);
const result = {
  testPassRate: process.argv.includes('--skip-tests') ? 1 : unitTests(root),
  evalPassRate: process.argv.includes('--skip-eval') ? 1 : await scriptedEvalRate(root),
  lintCompliance: Math.round((l.passed / l.total) * 10000) / 10000,
  catalog: { tools: tools.length, descriptionChars: tools.reduce((n, t) => n + (t.description ?? '').length + JSON.stringify(t.inputSchema ?? {}).length, 0), paramStyle: l.style },
  lintViolations: l.violations,
  errorHintRate: Math.round(((probe.rate + probe.english) / 2) * 1000) / 1000,
  errorHintMisses: probe.misses,
};
const out = arg('out') ?? process.env.STATIC_OUT;
if (out) fs.writeFileSync(out, JSON.stringify(result, null, 1));
console.log(JSON.stringify({ ...result, lintViolations: `${l.violations.length} of ${l.total} checks`, firstViolations: l.violations.slice(0, 40) }, null, 1));
console.log(JSON.stringify({ bench: 'mcp-exam-static', score: Math.round(100 * ((2 * result.lintCompliance + result.errorHintRate) / 3) * 100) / 100 }));
process.exit(0);
