/**
 * Browser MCP exam runner (one tree). The model key comes on stdin line 1 (or MCP_EXAM_KEY for a CI step), the holdout
 * passphrase on line 2; never in arguments or files.
 *
 *   <key>\n[passphrase]\n | node claude/eval/mcp-exam/run-exam.mjs --set dev --reps 1 --cap-usd 1 [--only D01,D02]
 *
 * Options: --set dev|holdout|all  --reps N  --model claude-haiku-5-5  --base-url http://192.168.110.246:8899
 *          --cap-usd X (hard stop)  --concurrency N  --only <id prefixes>  --holdout <.enc> (default newest in evolve/mcp-exam)
 *          --tree <repo root> (default this repo)  --sandbox none|bwrap  --browsers <dir> (default env PLAYWRIGHT_BROWSERS_PATH)
 *          --static <static.json from static-scores.mjs>  --reference <baseline.json for S2>  --out <dir>  --debug
 * Needs claude/dist (npm run build) and Chromium. Prints the dev table and, as the LAST line, one JSON object for the
 * evolve evaluator ({"bench":"mcp-exam","score":…}, direction higher). Holdout texts are never printed or written.
 * Judge layer.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBundle } from './holdout/holdout-crypt.mjs';
import { runTask } from './runner/agent-loop.mjs';
import { arg, latest, pool, stdinLines } from './runner/cli-util.mjs';
import { ModelClient } from './runner/model-client.mjs';
import { scrub, summarize } from './runner/score.mjs';
import { sessionFactory } from './runner/session.mjs';
import { DEV_TASKS } from './tasks/dev-tasks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tree = path.resolve(arg('tree', path.join(HERE, '../../..')));
const [key = '', passphrase = ''] = process.env.MCP_EXAM_KEY ? [process.env.MCP_EXAM_KEY, ''] : await stdinLines();
if (!key) throw new Error('model key expected on stdin (first line)');
const set = arg('set', 'dev');
const reps = Math.max(1, Number(arg('reps', '1')));
const model = arg('model', 'claude-haiku-5-5');
const client = new ModelClient(arg('base-url', 'http://192.168.110.246:8899'), key, model, arg('model-socket') ?? null);
const budget = { spent: 0, cap: Number(arg('cap-usd', '1')) };
const outDir = arg('out', path.join(os.tmpdir(), 'localmcp-mcp-exam'));
const only = arg('only')?.split(',').filter(Boolean);
const runParent = arg('run-dir', path.join(os.tmpdir(), 'localmcp-mcp-exam'));
fs.mkdirSync(runParent, { recursive: true });
const runDir = fs.mkdtempSync(path.join(runParent, 'run-'));
const open = sessionFactory({ tree, mode: arg('sandbox', 'none'), node: process.execPath, cacheDir: runDir, browsers: arg('browsers') ?? process.env.PLAYWRIGHT_BROWSERS_PATH, debug: process.argv.includes('--debug') });

const bundles = [];
if (set === 'dev' || set === 'all') bundles.push(DEV_TASKS);
if (set === 'holdout' || set === 'all') {
  if (!passphrase) throw new Error('the holdout passphrase (stdin line 2) is needed for the holdout set');
  bundles.push(openBundle(fs.readFileSync(arg('holdout') ?? latest(path.join(tree, 'evolve/mcp-exam'), 'holdout-', '.enc')), passphrase));
}
const jobs = [];
for (const b of bundles) for (let rep = 1; rep <= reps; rep++) for (const task of b.tasks) if (!only || only.some((o) => task.id.startsWith(o))) jobs.push({ task, set: b.set, patch: b.worldPatch ?? null, rep });

const t0 = Date.now();
const records = await pool(jobs, Number(arg('concurrency', '3')), async (j) => {
  const r = await runTask(j.task, { client, rep: j.rep, budget, open, patch: j.patch });
  const label = j.set === 'holdout' ? 'holdout task' : r.task;
  const tok = r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens;
  process.stderr.write(`${r.pass ? 'PASS' : 'FAIL'} ${label} rep${r.rep} · ${r.toolCalls} calls · ${tok}+${r.outputTokens} tok · $${r.costUsd.toFixed(4)} · ${Math.round(r.wallMs / 1000)}s${r.pass || j.set === 'holdout' ? '' : ` · ${r.failures.join('; ').slice(0, 300)}`}\n`);
  return { ...r, set: j.set };
});
try { fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* Windows: a browser file may still be locked */ }

const read = (f) => (f ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const summary = summarize(records, read(arg('static')), read(arg('reference')), { model, reps, wallSec: Math.round((Date.now() - t0) / 1000), spentUsd: Math.round(budget.spent * 10000) / 10000 });
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(outDir, `records-${set}-${stamp}.json`), JSON.stringify(records.map((r) => (r.set === 'holdout' ? scrub(r) : r)), null, 1));
fs.writeFileSync(path.join(outDir, `summary-${set}-${stamp}.json`), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary.table, null, 1));
console.log(JSON.stringify({ bench: 'mcp-exam', score: summary.composite, ...summary.subscores, passRate: summary.passRate, costUsd: Math.round(budget.spent * 10000) / 10000 }));
process.exit(0);
