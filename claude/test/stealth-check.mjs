/**
 * 隐身体检:真起一个本仓的浏览器 MCP(隔离的临时目录、不碰本机常驻服务和登录态),打开本地探针页,
 * 逐项列出「看得出是自动化浏览器」的破绽。改了内核、启动参数、注入脚本之后跑一遍,和改之前比。
 *
 *   node test/stealth-check.mjs                    # 无头
 *   HEADED=1 node test/stealth-check.mjs           # 有头(Linux 要 DISPLAY)
 *   node test/stealth-check.mjs --online [目录]     # 另外打开几个公网检测站,摘结果、截图存到目录
 *   node test/stealth-check.mjs --json out.json    # 结果另存 JSON(对比用)
 *
 * 其它环境变量原样传给被测服务(例如 BROWSER_EXTENSION=on 测新无头模式)。
 * 退出码:本地探针有破绽 → 1;全过 → 0。公网检测站只报不判(站点会改版、会限流)。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { probeHtml, PROBE_CSP, PROBE_WORKER_JS } from './stealth-probe.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADED = process.env.HEADED === '1';
const argOf = (name) => { const i = process.argv.indexOf(name); return i > 0 ? (process.argv[i + 1] ?? '') : null; };
const ONLINE = process.argv.includes('--online');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function startProbeSite() {
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/probe-worker.js')) {
      res.setHeader('content-type', 'text/javascript');
      res.end(PROBE_WORKER_JS);
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('content-security-policy', PROBE_CSP);
    res.end(probeHtml(req.headers));
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  // 用 localhost 而不是 127.0.0.1:有的内核对 IP 地址的页面少发 Client Hints
  return { url: `http://localhost:${port}/probe`, close: () => srv.close() };
}

function playwrightBrowsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

/** 起被测服务。scratch 由调用方给:两次启动共用同一个数据目录(第二次才用得上缓存的原生 Client Hints) */
async function startServer(scratch) {
  const port = await freePort();
  const d = (n) => { const p = path.join(scratch, n); fs.mkdirSync(p, { recursive: true }); return p; };
  const home = d('home');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
    PORT: String(port), HOST: '127.0.0.1', HEADLESS: HEADED ? 'false' : 'true',
    KILL_PORT_ON_START: '0', PIPE_DISABLE: '1',
    USER_DATA_DIR: d('profile'), LOCALMCP_DATA_DIR: d('data'), SCREENSHOT_DIR: d('shots'),
    BROWSER_TELEMETRY: '0', MCP_AUTH_TOKEN: '',
  };
  const log = fs.openSync(path.join(scratch, 'server.log'), 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', log, log], windowsHide: true });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error('服务没起来:\n' + fs.readFileSync(path.join(scratch, 'server.log'), 'utf8').slice(-2000));
    try { if ((await fetch(`${base}/livez`)).ok) break; } catch { /* 还没起 */ }
    await sleep(500);
  }
  const stop = async () => {
    try { process.platform === 'win32' ? execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) : child.kill('SIGTERM'); } catch { /* 已退出 */ }
    for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250);
    await sleep(1000);   // Windows 上 Chromium 退出后 profile 锁要一会儿才放
  };
  return { base, stop };
}

async function removeDir(dir) {
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(500); }
  }
}

/** 公网检测站:打开、等它算完、摘一句结论;摘不到就只截图 */
const ONLINE_SITES = [
  { name: 'sannysoft', url: 'https://bot.sannysoft.com/', wait: 6000,
    js: "return { failed: [...document.querySelectorAll('td.failed, .failed')].map(e => (e.closest('tr')?.cells?.[0]?.textContent || e.textContent).trim()).slice(0, 20) }" },
  { name: 'creepjs', url: 'https://abrahamjuliot.github.io/creepjs/', wait: 15000,
    js: "const t = document.body.innerText; return { headless: (t.match(/(\d+)% like headless/) || [])[1], headlessFlag: (t.match(/(\d+)% headless:/) || [])[1], stealth: (t.match(/(\d+)% stealth/) || [])[1], workerHeadless: /HeadlessChrome/.test(t) }" },
  { name: 'browserscan', url: 'https://www.browserscan.net/bot-detection', wait: 10000,
    js: "const t = document.body.innerText; return { verdict: (t.match(/Test Results:?\s*(\w+)/i) || [])[1] }" },
];

/** 跑一遍本地探针,打印,返回破绽数 */
async function runProbe(call, siteUrl, label, report) {
  await call('navigate', { url: siteUrl });
  const w = await call('wait_for_selector', { selector: '#out', timeout: 15000 });
  if (!w.success) throw new Error('探针页没出结果:' + w.error);
  const txt = await call('get_element_text', { selector: '#out' });
  const probe = JSON.parse(txt.data?.text ?? txt.data ?? '[]');
  report.probe.push({ run: label, checks: probe });
  console.log(`\n== 本地探针(${report.mode},${label}${report.env.BROWSER_EXTENSION ? ', BROWSER_EXTENSION=' + report.env.BROWSER_EXTENSION : ''})`);
  let bad = 0;
  for (const c of probe) {
    const tag = c.ok === null ? '[--]  ' : c.ok ? '[OK]  ' : '[FAIL]';
    if (c.ok === false) bad++;
    console.log(`${tag} ${c.id}${c.value ? ' — ' + c.value : ''}${c.ok === false && c.note ? '  (' + c.note + ')' : ''}`);
  }
  return bad;
}

async function runOnline(call, report) {
  const dir = path.resolve(argOf('--online') && !argOf('--online').startsWith('--') ? argOf('--online') : path.join(os.tmpdir(), 'stealth-online'));
  fs.mkdirSync(dir, { recursive: true });
  console.log(`\n== 公网检测站(截图存 ${dir})`);
  for (const s of ONLINE_SITES) {
    const nav = await call('navigate', { url: s.url, waitUntil: 'load', timeout: 45000 });
    if (!nav.success) { console.log(`[--]   ${s.name} 打不开:${nav.error}`); report.online.push({ name: s.name, error: nav.error }); continue; }
    await sleep(s.wait);
    const r = await call('execute_js', { script: s.js });
    const shot = await call('take_screenshot', { fullPage: true });
    const src = shot.data?.path ?? shot.data?.file;
    if (src && fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, `${report.mode}-${s.name}.png`));
    console.log(`[--]   ${s.name} — ${JSON.stringify(r.data?.result ?? r.data ?? r.error)}`);
    report.online.push({ name: s.name, result: r.data?.result ?? r.data });
  }
}

async function main() {
  const site = await startProbeSite();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-'));
  const report = { mode: HEADED ? 'headed' : 'headless', env: { BROWSER_EXTENSION: process.env.BROWSER_EXTENSION ?? '' }, probe: [], online: [] };
  let bad = 0;
  try {
    // 首次启动:还没缓存这个内核的原生 Client Hints;再次启动:用缓存 + 启动参数改 UA(日常就是这条路)
    for (const label of ['首次启动', '再次启动']) {
      const srv = await startServer(scratch);
      const client = new Client({ name: 'stealth-check', version: '1' }, { capabilities: {} });
      const call = async (name, args = {}) => {
        const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
        return r._meta?.['localmcp/result'] ?? { success: false, error: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
      };
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`)));
        bad += await runProbe(call, site.url, label, report);
        if (ONLINE && label === '再次启动') await runOnline(call, report);
      } finally {
        await client.close().catch(() => { /* noop */ });
        await srv.stop();
      }
    }
  } finally {
    site.close();
    await removeDir(scratch);
  }
  const jsonOut = argOf('--json');
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`\n破绽 ${bad} 项`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
