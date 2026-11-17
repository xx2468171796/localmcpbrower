/**
 * 指纹环境工作区端到端(space_new { fingerprint: true }):自己起一个独立的 stdio 服务实例(临时 profile 目录,
 * 不碰常驻服务),开两个指纹环境,走真实工具;要求这台电脑装了浏览器核心(~/.ankotti/browser-core)。
 *
 *   node test/fingerprint-e2e.mjs
 *
 * 判定:两个工作区都能导航 / 取快照 / 截图;两套指纹不同(同一段文字的排版测量值,内核按环境加扰动);
 * 关闭工作区、断开客户端后,临时目录下不再有浏览器或核心进程。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-e2e-'));
const client = new Client({ name: 'fp-e2e', version: '1' }, { capabilities: {} });
await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: [path.join(process.cwd(), 'dist', 'server.js'), '--stdio'],
  env: { ...process.env, USER_DATA_DIR: path.join(scratch, 'user_data'), HEADLESS: 'true', BROWSER_HUMANIZE: 'false' },
}));

const results = [];
async function call(name, args = {}, timeout = 120_000) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const parsed = r._meta?.['localmcp/result'] ?? (() => { try { return JSON.parse(r.content?.[0]?.text ?? ''); } catch { return { raw: r.content?.[0]?.text }; } })();
  return { parsed, ms: Date.now() - t0, content: r.content };
}
function check(label, ok, note = '') {
  results.push({ label, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${note ? `  — ${note}` : ''}`);
}

const MEASURE = `const s = document.createElement('span'); s.style.font = '16px Arial'; s.textContent = 'The quick brown fox jumps over the lazy dog 0123456789'; document.body.appendChild(s); const r = s.getClientRects()[0]; s.remove(); return JSON.stringify({ w: r.width, h: r.height, cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, wd: navigator.webdriver });`;
const prints = {};
try {
  for (const name of ['fpa', 'fpb']) {
    const made = await call('space_new', { name, fingerprint: true });
    check(`${name}: space_new fingerprint`, made.parsed?.success === true && made.parsed?.data?.fingerprint === true, `${made.ms}ms ${JSON.stringify(made.parsed?.data ?? made.parsed).slice(0, 140)}`);
    const nav = await call('navigate', { url: 'https://example.com/' });
    check(`${name}: navigate`, nav.parsed?.success === true, `${nav.ms}ms`);
    const snap = await call('snapshot');
    check(`${name}: snapshot`, JSON.stringify(snap.parsed ?? '').includes('documentation examples'), `${snap.ms}ms`);
    const shot = await call('take_screenshot');
    check(`${name}: take_screenshot`, shot.parsed?.success === true, `${shot.ms}ms`);
    const js = await call('execute_js', { script: MEASURE });
    const value = js.parsed?.data?.result ?? js.parsed?.data;
    prints[name] = typeof value === 'string' ? JSON.parse(value) : value;
    check(`${name}: execute_js`, Boolean(prints[name]?.w), `${js.ms}ms ${JSON.stringify(prints[name])}`);
  }
  check('两个环境的指纹不同', prints.fpa?.w !== prints.fpb?.w || prints.fpa?.cores !== prints.fpb?.cores || prints.fpa?.mem !== prints.fpb?.mem,
    `fpa w=${prints.fpa?.w} fpb w=${prints.fpb?.w}`);
  check('navigator.webdriver 为 false', prints.fpa?.wd === false && prints.fpb?.wd === false);
  const list = await call('space_list');
  const spaces = list.parsed?.data?.spaces ?? [];
  check('space_list 标出指纹环境', spaces.filter((s) => s.fingerprint).length === 2, JSON.stringify(spaces.map((s) => [s.name, s.alive, s.fingerprint ?? false])));
  const wrong = await call('space_new', { name: 'fpa', fingerprint: false });
  check('指纹环境不能改成普通工作区', wrong.parsed?.success === false, String(wrong.parsed?.error ?? '').slice(0, 60));
  // 回到 fpa 再用一次:连接复用,不重开浏览器
  const back = await call('space_switch', { name: 'fpa' });
  const again = await call('navigate', { url: 'https://example.org/' });
  check('切回已开着的环境直接可用', back.parsed?.success === true && again.parsed?.success === true, `switch ${back.ms}ms, navigate ${again.ms}ms`);
  for (const name of ['fpa', 'fpb']) {
    const closed = await call('space_close', { name });
    check(`${name}: space_close`, closed.parsed?.success === true, `${closed.ms}ms`);
  }
} catch (e) {
  check('没有抛异常', false, String(e?.message ?? e));
}
await client.close().catch(() => {});
await new Promise((r) => setTimeout(r, 6000));
// 临时目录下不该再有进程(核心随服务退出,浏览器随核心退出)
let left = '';
try {
  left = execFileSync('powershell', ['-NoProfile', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${path.basename(scratch)}*' -and $_.Name -ne 'powershell.exe' } | ForEach-Object { $_.Name } | Sort-Object -Unique`], { encoding: 'utf8', timeout: 30_000 }).trim();
} catch { left = '(查不了)'; }
check('退出后没有残留进程', left === '', left.replace(/\s+/g, ' '));
try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
