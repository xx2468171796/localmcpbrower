/**
 * Run-to-run noise of the exam, measured on ONE tree (A/A): calibrate.mjs collects many reps of the same code; random
 * disjoint groups of k reps play "base" and "head" exactly the way the gate scores them (S2 reference = the base group's
 * cost per success, prices without the cache discount). Pure (seeded RNG), so thresholds are reproducible from the saved
 * numbers. Port of admin/baolei tools/mcp-exam/gate/noise.ts. Judge layer.
 */
import { costPerSuccess, subscores } from '../runner/score.mjs';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const sd = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
};
const p95Abs = (xs) => {
  const s = xs.map(Math.abs).sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))] ?? 0;
};

/**
 * @param input { dev, holdout, stat, repsPerSide, draws, seed, bands } — dev / holdout records carry a global `rep`
 *              (run × reps + rep), so each rep is one independent pass over the whole set
 */
export function aaStats(input) {
  const reps = [...new Set(input.dev.map((r) => r.rep))].sort((a, b) => a - b);
  if (reps.length < 2 * input.repsPerSide) throw new Error(`need ${2 * input.repsPerSide} reps, have ${reps.length}`);
  const rand = rng(input.seed);
  const gains = [];
  const drops = [];
  const pass = Object.fromEntries(input.bands.map((b) => [String(b), 0]));
  const s1 = (rs) => (rs.length ? (100 * rs.filter((r) => r.pass).length) / rs.length : 0);
  for (let i = 0; i < input.draws; i++) {
    const shuffled = [...reps].sort(() => rand() - 0.5);
    const base = new Set(shuffled.slice(0, input.repsPerSide));
    const head = new Set(shuffled.slice(input.repsPerSide, 2 * input.repsPerSide));
    const pick = (rs, side) => rs.filter((r) => side.has(r.rep));
    const ref = { costPerSuccess: costPerSuccess(pick(input.dev, base)) };
    const gain = subscores(pick(input.dev, head), input.stat, ref).composite - subscores(pick(input.dev, base), input.stat, ref).composite;
    gains.push(gain);
    drops.push(s1(pick(input.holdout, base)) - s1(pick(input.holdout, head)));
    for (const b of input.bands) if (gain >= b) pass[String(b)]++;
  }
  const pooled = { costPerSuccess: costPerSuccess(input.dev) };
  const single = reps.map((rep) => subscores(input.dev.filter((r) => r.rep === rep), input.stat, pooled).composite);
  return {
    draws: input.draws,
    repsPerSide: input.repsPerSide,
    gain: { sd: round(sd(gains)), p95Abs: round(p95Abs(gains)), maxAbs: round(Math.max(...gains.map(Math.abs))) },
    holdoutDrop: { sd: round(sd(drops)), p95Abs: round(p95Abs(drops)), maxAbs: round(Math.max(...drops.map(Math.abs))), max: round(Math.max(...drops)) },
    passAt: Object.fromEntries(Object.entries(pass).map(([k, v]) => [k, round(v / input.draws, 3)])),
    repSpread: round(Math.max(...single) - Math.min(...single)),
    repComposites: single.map((x) => round(x)),
  };
}

/** Per dev task: passes / attempts over all reps (the per-task rule's frozen base rates) */
export function perTaskCounts(dev) {
  const out = {};
  for (const r of dev) {
    out[r.task] ??= { pass: 0, n: 0 };
    out[r.task].n++;
    if (r.pass) out[r.task].pass++;
  }
  return out;
}
