/**
 * 按需弹窗集成测试 —— 一个浏览器 MCP,只在要人工时才有可见窗口。
 *
 *   node test/on-demand-headed.mjs
 *
 * 自己起一份**独立**的服务(空闲端口 + 临时数据目录 + 独有的管道名),不碰本机在跑的
 * 3213 / 3215 和它们的 profile。走真实调用路径(shim → named pipe → 常驻服务)。
 *
 * 验证:
 *  1. 无头下打开一个会写 cookie 的本地页 → wait_for_human 自动弹窗(switchedToHeaded=true)、
 *     网址恢复、会话 cookie 和持久 cookie 都还在、浏览器进程真的不带 --headless;
 *  2. hide_window → 换回无头,网址和 cookie 仍在,进程又带上 --headless;
 *  3. 另一个窗口有调用正在跑时,wait_for_human 拒绝换形态(明确报错),不把人家的调用掐断。
 *
 * Windows 上测试期间会短暂弹出一个真窗口,正常。不写任何凭据。
 */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

const ROOT = process.cwd();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ondemand-'));
const DATA = path.join(TMP, 'data');
const USER_DATA = path.join(DATA, 'user_data');
const SERVICE = `odtest${process.pid}`;

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// ── 本地测试页:会话 cookie(无过期,不落盘)+ 持久 cookie,页面上有 #ok
const web = http.createServer((req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Set-Cookie': ['od_sess=s1; Path=/', 'od_persist=p1; Max-Age=3600; Path=/'],
  });
  res.end('<!doctype html><title>od</title><div id="ok">ok</div>');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const PAGE = `http://127.0.0.1:${web.address().port}/page?step=1`;

// ── 独立的服务实例
const PORT = await freePort();
const log = fs.openSync(path.join(TMP, 'server.log'), 'a');
const server = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    PIPE_SERVICE: SERVICE,
    HEADLESS: 'true',
    LOCALMCP_DATA_DIR: DATA,
    LOCALMCP_LEGACY_DIR: path.join(TMP, 'legacy'),
    USER_DATA_DIR: USER_DATA,
  },
  stdio: ['ignore', log, log],
  windowsHide: true,
});

async function waitHealthy() {
  for (const deadline = Date.now() + 90_000; Date.now() < deadline; ) {
    if (server.exitCode !== null) throw new Error(`服务提前退出,见 ${path.join(TMP, 'server.log')}`);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('服务 90 秒内没起来');
}

/** 本服务这个 profile 的浏览器主进程命令行(子进程带 --type=,排除) */
function browserMains() {
  const want = USER_DATA.toLowerCase();
  let rows = [];
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*chrom*' } | Select-Object Name,CommandLine | ConvertTo-Json -Compress"],
      { encoding: 'utf8', windowsHide: true }).trim();
    const parsed = out ? JSON.parse(out) : [];
    rows = (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ name: p.Name ?? '', cmd: p.CommandLine ?? '' }));
  } else {
    const out = execFileSync('ps', ['-eo', 'comm=,args='], { encoding: 'utf8' });
    rows = out.split('\n').map((l) => ({ name: l.trim().split(/\s+/)[0] ?? '', cmd: l }));
  }
  return rows.filter((p) => /chrom/i.test(p.name) && !/--type=/.test(p.cmd) && p.cmd.toLowerCase().includes(want));
}
/** 浏览器主进程是不是有窗口的:不带 --headless,也不是 headless_shell */
function realHeaded() {
  const mains = browserMains();
  assert.ok(mains.length > 0, '找不到本测试实例的浏览器主进程');
  return mains.some((p) => !/--headless/.test(p.cmd) && !/headless[_-]shell/i.test(`${p.name} ${p.cmd}`));
}

const connect = async (name) => {
  const c = new Client({ name, version: '1' }, { capabilities: {} });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', 'shim.mjs'), SERVICE] }));
  return c;
};
async function call(c, name, args = {}, timeout = 90_000) {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout });
  let parsed = r._meta?.['localmcp/result'];
  if (!parsed) { try { parsed = JSON.parse(r.content?.[0]?.text ?? ''); } catch { parsed = { raw: r.content?.[0]?.text } } }
  return parsed;
}
const cookieNames = async (c) => {
  const r = await call(c, 'get_cookies', {});
  assert.equal(r.success, true, `get_cookies 失败:${r.error}`);
  return new Set(r.data.cookies.map((x) => x.name));
};
const activeUrl = async (c) => {
  const r = await call(c, 'list_tabs', {});
  return r.data.tabs.find((t) => t.active)?.url;
};
const defaultHeaded = async (c) => (await call(c, 'space_list', {})).data.spaces.find((s) => s.name === 'default').headed;

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log(`[OK]   ${name}`); }
  catch (e) { results.push([false, name]); console.log(`[FAIL] ${name}\n       ${e.message}`); }
}

let a; let b;
try {
  await waitHealthy();
  a = await connect('od-a');

  await check('无头起步:打开会写 cookie 的本地页', async () => {
    const r = await call(a, 'navigate', { url: PAGE });
    assert.equal(r.success, true, r.error);
    assert.equal(await defaultHeaded(a), false);
    assert.equal(realHeaded(), false, '服务以 HEADLESS=true 启动,浏览器却有窗口');
    const names = await cookieNames(a);
    assert.ok(names.has('od_sess') && names.has('od_persist'), `cookie 没写上:${[...names]}`);
  });

  await check('wait_for_human 自动弹窗:switchedToHeaded=true、网址恢复、cookie 仍在', async () => {
    const r = await call(a, 'wait_for_human', { appears: '#ok', timeoutSec: 10 });
    assert.equal(r.success, true, r.error);
    assert.equal(r.data.switchedToHeaded, true);
    assert.equal(r.data.headed, true);
    assert.equal(r.data.url, PAGE);
    assert.equal(await activeUrl(a), PAGE);
    assert.equal(await defaultHeaded(a), true);
    assert.equal(realHeaded(), true, '说是弹了窗,浏览器进程却还是 --headless');
    const names = await cookieNames(a);
    assert.ok(names.has('od_sess'), '会话 cookie 换形态后丢了');
    assert.ok(names.has('od_persist'), '持久 cookie 换形态后丢了');
  });

  await check('已经有窗口时再调 wait_for_human 不重开(switchedToHeaded=false)', async () => {
    const r = await call(a, 'wait_for_human', { appears: '#ok', timeoutSec: 10 });
    assert.equal(r.success, true, r.error);
    assert.equal(r.data.switchedToHeaded, false);
    assert.equal(r.data.headed, true);
  });

  await check('hide_window 换回无头:网址和 cookie 仍在', async () => {
    const r = await call(a, 'hide_window', {});
    assert.equal(r.success, true, r.error);
    assert.equal(r.data.headed, false);
    assert.equal(r.data.switched, true);
    assert.ok(r.data.restored.includes(PAGE), `没恢复网址:${JSON.stringify(r.data.restored)}`);
    assert.equal(await activeUrl(a), PAGE);
    assert.equal(await defaultHeaded(a), false);
    assert.equal(realHeaded(), false, '收起窗口后浏览器进程仍然有窗口');
    const names = await cookieNames(a);
    assert.ok(names.has('od_sess') && names.has('od_persist'), `cookie 丢了:${[...names]}`);
  });

  await check('另一个窗口有调用在跑时拒绝弹窗,不掐断它', async () => {
    b = await connect('od-b');
    // b 的调用占着浏览器约 6 秒(等一个永远不会出现的元素)
    const busy = call(b, 'wait_for_selector', { selector: '#never-appears', timeout: 6000 });
    await new Promise((r) => setTimeout(r, 1000));
    const r = await call(a, 'wait_for_human', { appears: '#ok', timeoutSec: 5 });
    assert.equal(r.success, false, '别的调用在跑,却还是换了形态');
    assert.match(r.error, /别的调用正在用浏览器/);
    assert.equal(await defaultHeaded(a), false);
    const br = await busy;
    // b 的调用是自己超时结束的(等不到元素),不是被关浏览器打断的
    assert.equal(br.success, false);
    assert.doesNotMatch(String(br.error), /closed|已关闭/i, `b 的调用被打断了:${br.error}`);
    // 那边跑完后就能正常弹窗了
    const ok = await call(a, 'wait_for_human', { appears: '#ok', timeoutSec: 10 });
    assert.equal(ok.success, true, ok.error);
    assert.equal(ok.data.switchedToHeaded, true);
    const hide = await call(a, 'hide_window', {});
    assert.equal(hide.success, true, hide.error);
    assert.equal(hide.data.headed, false);
  });

  await check('show=false 时只盯页面、不弹窗', async () => {
    const r = await call(a, 'wait_for_human', { appears: '#ok', timeoutSec: 10, show: false });
    assert.equal(r.success, true, r.error);
    assert.equal(r.data.switchedToHeaded, false);
    assert.equal(r.data.headed, false);
    assert.equal(realHeaded(), false);
  });
} catch (e) {
  results.push([false, `测试框架:${e.message}`]);
  console.log(`[FAIL] ${e.stack ?? e}`);
} finally {
  for (const c of [a, b]) { try { await c?.close(); } catch { /* noop */ } }
  // 关服务连同浏览器进程树;再按 profile 目录扫一遍残留,只会命中本测试的临时目录
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else server.kill('SIGTERM');
  } catch { /* 可能已退出 */ }
  await new Promise((r) => setTimeout(r, 1500));
  try {
    const { killOrphanBrowsers } = await import('../dist/reclaim.js');
    await killOrphanBrowsers(USER_DATA);
  } catch { /* noop */ }
  web.close();
  fs.closeSync(log);
  const keep = results.some(([ok]) => !ok);
  if (keep) console.log(`服务日志保留在 ${path.join(TMP, 'server.log')}`);
  else fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

const fails = results.filter(([ok]) => !ok);
console.log(`\n通过 ${results.length - fails.length}/${results.length}${fails.length ? ',失败: ' + fails.map(([, n]) => n).join(' / ') : ''}`);
process.exit(fails.length ? 1 : 0);
