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
import { probeHtml, PROBE_CSP } from './stealth-probe.mjs';

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

async function startServer() {
  const port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stealth-'));
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
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try { fs.rmSync(scratch, { recursive: true, force: true }); return; } catch { /* Windows 上句柄还没放 */ }
    }
  };
  return { base, stop };
}

/** 公网检测站:打开、等它算完、摘一句结论;摘不到就只截图 */
const ONLINE_SITES = [
  { name: 'sannysoft', url: 'https://bot.sannysoft.com/', wait: 6000,
    js: "return { failed: [...document.querySelectorAll('td.failed, .failed')].map(e => (e.closest('tr')?.cells?.[0]?.textContent || e.textContent).trim()).slice(0, 20) }" },
  { name: 'creepjs', url: 'https://abrahamjuliot.github.io/creepjs/', wait: 15000,
    js: "const t = document.body.innerText; return { headless: (t.match(/(\\d+)% like headless/) || [])[1], stealth: (t.match(/(\\d+)% stealth/) || [])[1], lies: (t.match(/lies \\((\\d+)\\)/) || [])[1] }" },
  { name: 'browserscan', url: 'https://www.browserscan.net/bot-detection', wait: 10000,
    js: "const t = document.body.innerText; return { verdict: (t.match(/Test Results:?\\s*(\\w+)/i) || [])[1], robot: /robot/i.test(t.slice(0, 3000)) }" },
];

async function main() {
  const site = await startProbeSite();
  const srv = await startServer();
  const client = new Client({ name: 'stealth-check', version: '1' }, { capabilities: {} });
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
    return r._meta?.['localmcp/result'] ?? { success: false, error: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
  };
  let bad = 0;
  const report = { mode: HEADED ? 'headed' : 'headless', env: { BROWSER_EXTENSION: process.env.BROWSER_EXTENSION ?? '' }, probe: [], online: [] };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`)));
    await call('navigate', { url: site.url });
    const w = await call('wait_for_selector', { selector: '#out', timeout: 15000 });
    if (!w.success) throw new Error('探针页没出结果:' + w.error);
    const txt = await call('get_element_text', { selector: '#out' });
    report.probe = JSON.parse(txt.data?.text ?? txt.data ?? '[]');
    console.log(`\n== 本地探针(${report.mode}${report.env.BROWSER_EXTENSION ? ', BROWSER_EXTENSION=' + report.env.BROWSER_EXTENSION : ''})`);
    for (const c of report.probe) {
      const tag = c.ok === null ? '[--]  ' : c.ok ? '[OK]  ' : '[FAIL]';
      if (c.ok === false) bad++;
      console.log(`${tag} ${c.id}${c.value ? ' — ' + c.value : ''}${c.ok === false && c.note ? '  (' + c.note + ')' : ''}`);
    }
    if (ONLINE) {
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
  } finally {
    await client.close().catch(() => { /* noop */ });
    await srv.stop();
    site.close();
  }
  const jsonOut = argOf('--json');
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`\n破绽 ${bad} 项`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
