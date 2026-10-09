/**
 * 考卷成绩的汇总与「和基线比」(纯函数,单测见 test/eval-compare.test.mjs)。
 *
 * 放行规则(和 .ankotti/evolve.json 的 gates 同口径):
 *   - 基线里通过的题现在没过 → 不放行(回归);
 *   - 基线里有、这次没跑的题 → 不放行(考卷被删 / 被跳过);
 *   - 通过率比基线低 5 个百分点以上 → 不放行;
 *   - 工具报错率(非预期失败的调用 / 全部调用)比基线高 3 个百分点以上 → 不放行;
 *   - 输出字节(token 代理)或耗时明显变差只出警告:耗时受机器负载影响,不拿来卡。
 * 这个文件属于裁判层(.ankotti/evolve.json protected),AI 改进流程不得修改。
 */

export const GATES = { passRateWorseByPp: 5, toolErrorRateWorseByPp: 3, bytesWarnRatio: 1.5, msWarnRatio: 2, msWarnFloor: 1000 };

const pct = (n, d) => (d === 0 ? 0 : Math.round((n / d) * 10000) / 100);

export function summarize(tasks) {
  const passed = tasks.filter((t) => t.pass).length;
  const calls = tasks.reduce((s, t) => s + t.calls, 0);
  const toolErrors = tasks.reduce((s, t) => s + t.toolErrors, 0);
  const sorted = tasks.map((t) => t.ms).sort((a, b) => a - b);
  return {
    tasks: tasks.length,
    passed,
    passRate: pct(passed, tasks.length),
    calls,
    toolErrors,
    toolErrorRate: pct(toolErrors, calls),
    totalMs: tasks.reduce((s, t) => s + t.ms, 0),
    p50Ms: sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0,
    totalBytes: tasks.reduce((s, t) => s + t.bytes, 0),
  };
}

/** 基线文件只留比较需要的字段 */
export function toBaseline(results) {
  return {
    version: results.version,
    patchright: results.patchright,
    createdAt: results.generatedAt,
    summary: results.summary,
    tasks: Object.fromEntries(results.tasks.map((t) => [t.id, { pass: t.pass, ms: t.ms, bytes: t.bytes, toolErrors: t.toolErrors }])),
  };
}

export function compare(results, baseline, gates = GATES) {
  const failures = [];
  const warnings = [];
  const notes = [];
  if (!baseline) return { ok: true, failures, warnings, notes: ['没有基线,只记录成绩'] };
  const now = new Map(results.tasks.map((t) => [t.id, t]));
  for (const [id, b] of Object.entries(baseline.tasks)) {
    const cur = now.get(id);
    if (!cur) { failures.push(`${id}: 基线里有这道题,这次没跑`); continue; }
    if (b.pass && !cur.pass) failures.push(`${id}: 回归(基线通过,现在失败:${cur.error ?? '未知'})`);
    if (!b.pass && cur.pass) notes.push(`${id}: 基线没过,现在通过`);
    if (cur.pass && b.bytes > 0 && cur.bytes > b.bytes * gates.bytesWarnRatio) warnings.push(`${id}: 输出 ${cur.bytes}B,基线 ${b.bytes}B`);
    if (cur.pass && cur.ms > gates.msWarnFloor && cur.ms > b.ms * gates.msWarnRatio) warnings.push(`${id}: 耗时 ${cur.ms}ms,基线 ${b.ms}ms`);
  }
  for (const id of now.keys()) if (!(id in baseline.tasks)) notes.push(`${id}: 新题(基线里没有)`);
  const s = results.summary;
  const bs = baseline.summary;
  if (bs.passRate - s.passRate > gates.passRateWorseByPp) failures.push(`通过率 ${s.passRate}% 比基线 ${bs.passRate}% 低超过 ${gates.passRateWorseByPp}pp`);
  if (s.toolErrorRate - bs.toolErrorRate > gates.toolErrorRateWorseByPp) failures.push(`工具报错率 ${s.toolErrorRate}% 比基线 ${bs.toolErrorRate}% 高超过 ${gates.toolErrorRateWorseByPp}pp`);
  if (bs.totalBytes > 0 && s.totalBytes > bs.totalBytes * gates.bytesWarnRatio) warnings.push(`总输出 ${s.totalBytes}B,基线 ${bs.totalBytes}B`);
  return { ok: failures.length === 0, failures, warnings, notes };
}
