/**
 * Exam calibration on ONE tree: runs the dev and holdout sets `--runs` × `--reps` times exactly the way the gate does
 * (each attempt in a fresh sandboxed child, prices without the cache discount for scoring), then writes
 *   - the frozen baseline (dev summary incl. per-task pass counts = the per-task rule's base rates; holdout = set-level
 *     numbers only) → <out-dir>/baseline-YYYY-MM-DD.json
 *   - A/A noise: random disjoint groups of k reps scored as base / head (gate/noise.mjs) for k = --reps, plus each
 *     run's composite (run-to-run drift).
 * Trusted code (judge layer), run on the build machine's isolated account like the gate driver:
 *
 *   <model key>\n<holdout passphrase>\n | node claude/eval/mcp-exam/gate/calibrate.mjs --tree <repo> --run-dir <dir> \
 *     --node <abs node> --browsers <dir> [--runs 3] [--reps 5] [--cap-usd 7] [--concurrency 4] [--static <json>] \
 *     [--sandbox bwrap|none] [--out-dir <dir>]
 *
 * Output: progress lines on stderr (dev ids only), one JSON line on stdout. Holdout prompts / answers never leave.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openBundle } from '../holdout/holdout-crypt.mjs';
import { runTask } from '../runner/agent-loop.mjs';
import { arg, latest, pool, stdinLines } from '../runner/cli-util.mjs';
import { costUsd, ModelClient } from '../runner/model-client.mjs';
import { costPerSuccess, SAFETY, subscores, summarize } from '../runner/score.mjs';
import { sessionFactory } from '../runner/session.mjs';
import { DEV_TASKS } from '../tasks/dev-tasks.mjs';
import { aaStats, perTaskCounts } from './noise.mjs';

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

async function main() {
  const tree = arg('tree') ?? '';
  const runDir = arg('run-dir') ?? '';
  const node = arg('node') ?? '';
  if (!tree || !runDir || !node) throw new Error('--tree, --run-dir and --node are required');
  const runs = Math.max(1, Math.min(5, Number(arg('runs', '3'))));
  const reps = Math.max(1, Math.min(5, Number(arg('reps', '5'))));
  const cap = Math.max(0.05, Math.min(8, Number(arg('cap-usd', '7'))));
  const [key = '', passphrase = ''] = await stdinLines();
  if (!key || !passphrase) throw new Error('model key and holdout passphrase expected on stdin');
  const client = new ModelClient(arg('base-url', 'http://192.168.110.246:8899'), key, arg('model', 'claude-haiku-5-5'), arg('model-socket') ?? null);
  const holdout = openBundle(fs.readFileSync(latest(path.join(tree, 'evolve/mcp-exam'), 'holdout-', '.enc')), passphrase);
  const open = sessionFactory({ tree, mode: arg('sandbox', 'bwrap') === 'none' ? 'none' : 'bwrap', node, browsers: arg('browsers') ?? process.env.PLAYWRIGHT_BROWSERS_PATH, cacheDir: path.join(runDir, 'cache') });
  const stat = arg('static') ? JSON.parse(fs.readFileSync(arg('static'), 'utf8')) : null;
  const budget = { spent: 0, cap };
  const all = [];
  const t0 = Date.now();
  for (let run = 1; run <= runs; run++) {
    const jobs = [];
    for (let rep = 1; rep <= reps; rep++) {
      const g = (run - 1) * reps + rep;
      for (const t of DEV_TASKS.tasks) jobs.push({ task: t, set: 'dev', patch: null, rep: g });
      for (const t of holdout.tasks) jobs.push({ task: t, set: 'holdout', patch: holdout.worldPatch ?? null, rep: g });
    }
    const recs = await pool(jobs, Math.max(1, Math.min(8, Number(arg('concurrency', '4')))), async (j) => {
      const r = { ...(await runTask(j.task, { client, rep: j.rep, budget, open, patch: j.patch })), set: j.set, run };
      process.stderr.write(`[run ${run}] ${r.pass ? 'PASS' : 'FAIL'} ${j.set === 'dev' ? r.task : 'holdout'} rep${r.rep} $${r.costUsd.toFixed(4)} ${Math.round(r.wallMs / 1000)}s spent=$${budget.spent.toFixed(3)}${j.set === 'dev' && !r.pass ? ` · ${r.failures.join('; ').slice(0, 160)}` : ''}\n`);
      return r;
    });
    all.push(...recs);
    if (budget.spent >= cap) break;
  }
  // scoring view as in the gate: no cache discount
  const model = client.model;
  const scored = all.map((r) => ({ ...r, costUsd: costUsd(model, { input_tokens: r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens, output_tokens: r.outputTokens }) }));
  const dev = scored.filter((r) => r.set === 'dev');
  const hold = scored.filter((r) => r.set === 'holdout');
  const pooledRef = { costPerSuccess: costPerSuccess(dev) };
  const summary = summarize(scored.filter((r) => r.set === 'dev'), stat, pooledRef, { model, runs, reps, wallSec: Math.round((Date.now() - t0) / 1000), spentUsd: round(budget.spent, 4) });
  const runScore = (set, run) => subscores(scored.filter((r) => r.set === set && r.run === run), stat, pooledRef);
  const holdoutPerRun = [...new Set(hold.map((r) => r.run))].map((run) => runScore('holdout', run).s1);
  const aa = aaStats({ dev, holdout: hold, stat, repsPerSide: reps, draws: 400, seed: 20261014, bands: [1, 1.5, 2, 2.5, 3, 4] });
  const baseline = {
    ...summary,
    perTask: perTaskCounts(dev),
    holdout: { s1: subscores(hold, stat, null).s1, attempts: hold.length, safety: hold.filter((r) => r.failures.some((f) => SAFETY.test(f))).length, s1PerRun: holdoutPerRun, runErrors: hold.filter((r) => r.failures.some((f) => /^run error/.test(f))).length },
    runs: [...new Set(dev.map((r) => r.run))].map((run) => ({ run, dev: runScore('dev', run).composite, devS1: runScore('dev', run).s1 })),
    calibration: { ...aa, measuredAt: new Date().toISOString().slice(0, 10), model, note: 'A/A on one tree; thresholds belong in the bastion gate rules for this repo' },
  };
  const outDir = arg('out-dir');
  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, `baseline-${new Date().toISOString().slice(0, 10)}.json`), `${JSON.stringify(baseline, null, 1)}\n`);
    fs.writeFileSync(path.join(outDir, 'dev-records.json'), JSON.stringify(dev));
  }
  // holdout per-task counts by opaque id (for the exam author to drop broken tasks; no texts)
  const hCounts = perTaskCounts(hold);
  return { bench: 'mcp-exam-calibrate', ok: true, spentUsd: round(budget.spent, 4), wallSec: baseline.meta.wallSec, dev: { composite: baseline.composite, subscores: baseline.subscores, runs: baseline.runs }, holdout: baseline.holdout, holdoutPerTask: hCounts, calibration: aa };
}

main().then(
  (out) => { process.stdout.write(`${JSON.stringify(out)}\n`); process.exit(0); },
  (e) => { process.stdout.write(`${JSON.stringify({ bench: 'mcp-exam-calibrate', ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300) })}\n`); process.exit(1); },
);
