/**
 * One exam attempt's world, run as a child process (in bwrap without network on the build machine): the local exam
 * site + the browser MCP server under test (dist/server.js of THIS tree, fresh temp profile, telemetry off, no secrets
 * in its environment) + an MCP client. Talks JSON lines with the trusted driver on stdin / stdout:
 *
 *   {id, op:"open", patch}        → {site:{main,other}, instructions, tools}
 *   {id, op:"call", name, args}   → {content:[{type:"text",text}|{type:"image",data,mimeType}], isError}
 *   {id, op:"ledger"}             → the site's ledger (what really happened on the website)
 *   {id, op:"close"}
 *
 * The driver keeps the model key and the holdout passphrase; this process only sees the site patch and the tool calls.
 * Judge layer (the gate always runs the base tree's copy of claude/eval/**).
 */
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { connect, startServer } from '../../harness.mjs';
import { startSite } from '../site/fixture-site.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MAX_IMAGE = 1_500_000;
const CALL_TIMEOUT = 90_000;

let site = null;
let server = null;
let client = null;

const reply = (id, ok, body) => process.stdout.write(`${JSON.stringify(ok ? { id, ok, result: body } : { id, ok, error: String(body).slice(0, 2000) })}\n`);

async function open(patch) {
  site = await startSite(patch ?? null);
  server = await startServer({ root: ROOT, log: (...a) => process.stderr.write(`${a.join(' ')}\n`) });
  client = await connect(server.base);
  const { tools } = await client.listTools();
  return {
    site: { main: site.main, other: site.other },
    instructions: client.getInstructions?.() ?? '',
    tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations, _meta: t._meta })),
  };
}

async function call(name, args) {
  let r;
  try {
    r = await client.callTool({ name, arguments: args ?? {} }, undefined, { timeout: CALL_TIMEOUT });
  } catch (e) {
    return { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
  const raw = r._meta?.['localmcp/result'];
  const content = [];
  for (const c of r.content ?? []) {
    if (c.type === 'text') content.push({ type: 'text', text: String(c.text ?? '') });
    else if (c.type === 'image' && typeof c.data === 'string') {
      content.push(c.data.length <= MAX_IMAGE ? { type: 'image', data: c.data, mimeType: c.mimeType ?? 'image/png' } : { type: 'text', text: '[image omitted by the exam client: over 1.5 MB]' });
    } else content.push({ type: 'text', text: `[${c.type} content]` });
  }
  return { content, isError: r.isError === true || raw?.success === false };
}

async function close() {
  try { await client?.close(); } catch { /* noop */ }
  try { if (server) await server.stop(); } catch { /* noop */ }
  try { await site?.close(); } catch { /* noop */ }
}

const rl = readline.createInterface({ input: process.stdin });
let queue = Promise.resolve();
rl.on('line', (line) => {
  queue = queue.then(async () => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    try {
      if (msg.op === 'open') reply(msg.id, true, await open(msg.patch));
      else if (msg.op === 'call') reply(msg.id, true, await call(String(msg.name), msg.args));
      else if (msg.op === 'ledger') reply(msg.id, true, site ? site.ledger() : null);
      else if (msg.op === 'close') { await close(); reply(msg.id, true, null); process.exit(0); }
      else reply(msg.id, false, 'unknown op');
    } catch (e) {
      reply(msg.id, false, e instanceof Error ? e.message : String(e));
    }
  });
});
rl.on('close', () => { void close().then(() => process.exit(0)); });
