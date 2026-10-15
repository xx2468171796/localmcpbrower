/**
 * Exam scoring: four sub-scores (0–100, higher = better) and one weighted composite — same shape and weights as the
 * bastion's MCP exam, so the bastion gate can read both.
 *   S1 first-try correctness = pass rate of single attempts (each rep is an independent first try)
 *   S2 efficiency            = 100 × geometric mean over tasks of (reference cost per success / current cost per success),
 *                              ratio clamped to [0.25, 4]; a task without success counts 3× its mean cost
 *   S3 quality (bugs/tests)  = 100 × unit-test pass rate × (0.6 + 0.4 × deterministic-eval pass rate) − 5 per distinct
 *                              tool crash seen in the exam
 *   S4 interface             = 100 × (0.5 × static lint compliance + 0.25 × error-probe quality + 0.25 × (1 − 5 × parameter
 *                              error rate in the exam))
 * Composite = 0.40 S1 + 0.25 S2 + 0.15 S3 + 0.20 S4 (weights renormalised over the sub-scores present). Judge layer.
 */
import { SAFETY } from '../tasks/task-spec.mjs';

export { SAFETY };
export const WEIGHTS = { s1: 0.4, s2: 0.25, s3: 0.15, s4: 0.2 };

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

export function costPerSuccess(records) {
  const out = {};
  const by = new Map();
  for (const r of records) by.set(r.task, [...(by.get(r.task) ?? []), r]);
  for (const [task, rs] of by) {
    const passes = rs.filter((r) => r.pass).length;
    const cost = rs.reduce((n, r) => n + r.costUsd, 0);
    out[task] = passes ? cost / passes : (cost / rs.length) * 3;
  }
  return out;
}

export function subscores(records, stat, reference) {
  const s1 = 100 * mean(records.map((r) => (r.pass ? 1 : 0)));
  const cps = costPerSuccess(records);
  const ratios = Object.entries(cps)
    .filter(([task]) => reference?.costPerSuccess?.[task] !== undefined)
    .map(([task, c]) => Math.min(4, Math.max(0.25, reference.costPerSuccess[task] / Math.max(c, 1e-9))));
  const s2 = reference && ratios.length ? 100 * Math.exp(mean(ratios.map(Math.log))) : 100;
  const calls = records.flatMap((r) => r.calls);
  const crashes = new Set(calls.filter((c) => c.crash).map((c) => `${c.name}:${(c.errorText ?? '').slice(0, 60)}`)).size;
  const s3 = stat ? 100 * stat.testPassRate * (0.6 + 0.4 * stat.evalPassRate) - 5 * crashes : null;
  const paramRate = calls.length ? calls.filter((c) => c.paramError).length / calls.length : 0;
  const s4 = stat ? 100 * (0.5 * stat.lintCompliance + 0.25 * stat.errorHintRate + 0.25 * Math.max(0, 1 - 5 * paramRate)) : null;
  const parts = [[s1, WEIGHTS.s1], [s2, WEIGHTS.s2], [s3, WEIGHTS.s3], [s4, WEIGHTS.s4]].filter((p) => p[0] !== null);
  const composite = parts.reduce((n, [v, w]) => n + v * w, 0) / parts.reduce((n, [, w]) => n + w, 0);
  return { s1: round(s1), s2: round(s2), s3: s3 === null ? null : round(s3), s4: s4 === null ? null : round(s4), composite: round(composite, 2), crashes, paramRate: round(paramRate, 4) };
}

/** Per-task table + means for the public (dev) set; holdout appears only as set-level numbers */
export function summarize(records, stat, reference, meta) {
  const sets = [...new Set(records.map((r) => r.set))];
  const perSet = Object.fromEntries(sets.map((s) => [s, subscores(records.filter((r) => r.set === s), stat, reference)]));
  const main = perSet.dev ?? perSet[sets[0]];
  const dev = records.filter((x) => x.set === 'dev');
  const by = new Map();
  for (const r of dev) by.set(r.task, [...(by.get(r.task) ?? []), r]);
  const table = [...by].map(([task, rs]) => ({
    task,
    pass: `${rs.filter((r) => r.pass).length}/${rs.length}`,
    calls: round(mean(rs.map((r) => r.toolCalls))),
    searches: round(mean(rs.map((r) => r.searchCalls))),
    tokens: Math.round(mean(rs.map((r) => r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.outputTokens))),
    usd: round(mean(rs.map((r) => r.costUsd)), 5),
    sec: round(mean(rs.map((r) => r.wallMs)) / 1000),
    fail: [...new Set(rs.flatMap((r) => r.failures))].join(' | ').slice(0, 200),
  }));
  const reps = [...new Set(dev.map((r) => r.rep))].sort((a, b) => a - b).map((rep) => round(100 * mean(dev.filter((r) => r.rep === rep).map((r) => (r.pass ? 1 : 0)))));
  const sum = (f) => dev.reduce((n, r) => n + f(r), 0);
  return {
    meta,
    composite: main?.composite ?? 0,
    subscores: main ? { s1: main.s1, s2: main.s2, s3: main.s3, s4: main.s4 } : null,
    perSet,
    passRate: main?.s1 ?? 0,
    safety: Object.fromEntries(sets.map((set) => [set, records.filter((r) => r.set === set && r.failures.some((f) => SAFETY.test(f))).length])),
    safetyByTask: Object.fromEntries([...by].map(([t, rs]) => [`dev:${t}`, rs.filter((r) => r.failures.some((f) => SAFETY.test(f))).length]).filter(([, n]) => n)),
    passRateByRep: reps,
    tasks: by.size,
    means: dev.length ? {
      toolCalls: round(mean(dev.map((r) => r.toolCalls)), 2),
      searchCalls: round(mean(dev.map((r) => r.searchCalls)), 2),
      turns: round(mean(dev.map((r) => r.turns)), 2),
      inputTokens: Math.round(mean(dev.map((r) => r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens))),
      outputTokens: Math.round(mean(dev.map((r) => r.outputTokens))),
      resultChars: Math.round(mean(dev.map((r) => r.resultChars))),
      costUsd: round(mean(dev.map((r) => r.costUsd)), 5),
      wallSec: round(mean(dev.map((r) => r.wallMs)) / 1000, 1),
      toolErrorRate: round(sum((r) => r.toolErrors) / Math.max(1, sum((r) => r.toolCalls)), 4),
      paramErrors: sum((r) => r.paramErrors),
      unloadedCalls: sum((r) => r.unloadedCalls),
      runErrors: dev.filter((r) => r.failures.some((f) => /^run error/.test(f))).length,
    } : null,
    costPerSuccess: costPerSuccess(dev),
    table,
  };
}

/** Holdout rows keep numbers only: no prompts, answers, arguments or failure texts */
export function scrub(r) {
  return { ...r, answer: '', failures: r.failures.map((f) => (SAFETY.test(f) ? 'safety' : /^run error/.test(f) ? 'run error' : 'fail')), calls: r.calls.map((c) => ({ name: c.name, isError: c.isError, paramError: c.paramError, crash: c.crash, chars: c.chars, images: c.images })) };
}
