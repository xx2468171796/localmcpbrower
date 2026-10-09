/**
 * 浏览器 MCP 考卷(裁判层):`pnpm eval` / `npm run eval`。
 *
 *   node eval/run.mjs                    跑全部题,写 eval/results.json,和 eval/baseline.json 比,退出码 = 是否放行
 *   node eval/run.mjs --only iframe      只跑 id 里含 iframe 的题(调试用,不和基线比)
 *   node eval/run.mjs --update-baseline  把这次成绩写成新基线 —— 只有人能做(AI 改进流程不得改基线)
 *
 * 全程离线:题目只打本地测试页(fixtures.mjs)。被测服务起在空闲端口、临时 profile,跑完清干净,
 * 不碰本机 PM2 管的 3213 / 3215 服务和你的登录态。
 * 这个文件属于裁判层(.ankotti/evolve.json protected),AI 改进流程不得修改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, summarize, toBaseline } from './compare.mjs';
import { startFixtures } from './fixtures.mjs';
import { connect, runTask, startServer } from './harness.mjs';
import { browserTasks } from './tasks-browser.mjs';
import { dataTasks } from './tasks-data.mjs';
import { pageTasks } from './tasks-page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RESULTS = path.join(HERE, 'results.json');
const BASELINE = path.join(HERE, 'baseline.json');

const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
const updateBaseline = argv.includes('--update-baseline');
const log = (...a) => console.log(...a);

const ALL = [...pageTasks, ...dataTasks, ...browserTasks];
const ids = new Set();
for (const t of ALL) { if (ids.has(t.id)) throw new Error(`题目 id 重复:${t.id}`); ids.add(t.id); }
const tasks = only ? ALL.filter((t) => t.id.includes(only)) : ALL;

if (!fs.existsSync(path.join(ROOT, 'dist', 'server.js'))) {
  console.error('缺 dist/server.js,先 npm run build');
  process.exit(2);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const patchright = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'patchright', 'package.json'), 'utf8')).version; } catch { return null; } })();

const fixtures = await startFixtures();
let server = null;
let client = null;
const out = [];
let exitCode = 1;
try {
  server = await startServer({ root: ROOT, log });
  log(`[eval] 被测服务 ${server.base}(临时 profile),测试页 ${fixtures.main} / ${fixtures.other},共 ${tasks.length} 题`);
  client = await connect(server.base);
  const env = { main: fixtures.main, other: fixtures.other, hits: fixtures.hits, dirs: server.dirs, base: server.base };
  for (const task of tasks) {
    const r = await runTask(client, task, env);
    out.push(r);
    log(`${r.pass ? '[OK]  ' : '[FAIL]'} ${r.id.padEnd(36)} ${String(r.ms).padStart(6)}ms ${String(r.bytes).padStart(7)}B${r.error ? '  ' + r.error : ''}`);
  }
  const results = {
    version: pkg.version,
    patchright,
    node: process.version,
    generatedAt: new Date().toISOString(),
    summary: summarize(out),
    tasks: out,
  };
  const baseline = !only && fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
  results.comparison = only ? { ok: out.every((t) => t.pass), failures: [], warnings: [], notes: ['--only:不和基线比'] } : compare(results, baseline);
  fs.writeFileSync(RESULTS, JSON.stringify(results, null, 2) + '\n');
  const s = results.summary;
  log(`\n通过 ${s.passed}/${s.tasks}(${s.passRate}%) · 调用 ${s.calls} 次,工具报错率 ${s.toolErrorRate}% · 总耗时 ${s.totalMs}ms,p50 ${s.p50Ms}ms · 输出 ${s.totalBytes}B`);
  for (const f of results.comparison.failures) log(`  ✗ ${f}`);
  for (const w of results.comparison.warnings) log(`  ! ${w}`);
  for (const n of results.comparison.notes) log(`  · ${n}`);
  if (updateBaseline) {
    if (only) throw new Error('--update-baseline 不能和 --only 一起用');
    fs.writeFileSync(BASELINE, JSON.stringify(toBaseline(results), null, 2) + '\n');
    log(`[eval] 基线已更新:${BASELINE}`);
  }
  log(`[eval] ${results.comparison.ok ? '放行' : '不放行'}(结果:${RESULTS})`);
  exitCode = results.comparison.ok ? 0 : 1;
} catch (e) {
  console.error('[eval] 运行失败:', e instanceof Error ? e.message : e);
  exitCode = 2;
} finally {
  try { await client?.close(); } catch { /* noop */ }
  if (server) await server.stop();
  await fixtures.close();
}
process.exit(exitCode);
