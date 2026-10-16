/**
 * 工作区身份端到端测试(identity.ts / geoip.ts / space_new 的 proxy):真起服务、真开浏览器,自带一个本地 HTTP 代理(要账号密码)。
 *
 *   node test/identity-e2e.mjs
 *
 * 验证:挂代理后页面请求真的走代理且带上了账号密码;结果里代理打码;身份写进 identity.json、重启后屏幕 / 代理不变;
 * 去掉代理时浏览器自动重开、请求不再走代理;出口时区查到了就记进身份(要能上外网,查不到只提示不判失败)。
 * 隔离做法同 stealth-check.mjs:临时目录、随机端口、不碰本机常驻服务和登录态。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`); };
const USER = 'tester';
const PASS = 'p@ss:word';

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

/** 本地站点:/ip 回显「谁连的我」(经代理时代理会加 x-via-proxy 头) */
async function startSite() {
  const port = await freePort();
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>t</title><pre id="via">${req.headers['x-via-proxy'] ?? 'direct'}</pre>`);
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { port, close: () => srv.close() };
}

/** 要 Basic 认证的 HTTP 代理(普通请求 + CONNECT);记下经过它的请求 */
async function startProxy() {
  const port = await freePort();
  const seen = [];
  const expected = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
  const deny = (res) => { res.writeHead(407, { 'proxy-authenticate': 'Basic realm="t"' }); res.end(); };
  const srv = http.createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== expected) { deny(res); return; }
    seen.push(req.url);
    const u = new URL(req.url);
    const headers = { ...req.headers, 'x-via-proxy': 'yes' };
    delete headers['proxy-authorization'];
    const up = http.request({ host: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  srv.on('clientError', (_e, sock) => sock.destroy());
  srv.on('connect', (req, sock, head) => {
    sock.on('error', () => { /* 浏览器那头断了 */ });
    if (req.headers['proxy-authorization'] !== expected) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="t"\r\n\r\n'); return; }
    seen.push('CONNECT ' + req.url);
    const [host, p] = req.url.split(':');
    const up = net.connect(Number(p) || 443, host, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy());
    sock.on('close', () => up.destroy());
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { url: `http://${USER}:${encodeURIComponent(PASS)}@127.0.0.1:${port}`, seen, close: () => srv.close() };
}

function playwrightBrowsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

async function startServer(scratch) {
  const port = await freePort();
  const d = (n) => { const p = path.join(scratch, n); fs.mkdirSync(p, { recursive: true }); return p; };
  const home = d('home');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
    PORT: String(port), HOST: '127.0.0.1', HEADLESS: 'true', KILL_PORT_ON_START: '0', PIPE_DISABLE: '1',
    USER_DATA_DIR: d('profile'), LOCALMCP_DATA_DIR: d('data'), SCREENSHOT_DIR: d('shots'), BROWSER_TELEMETRY: '0', MCP_AUTH_TOKEN: '',
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', fs.openSync(path.join(scratch, 'server.log'), 'a'), fs.openSync(path.join(scratch, 'server.log'), 'a')], windowsHide: true });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error('服务没起来');
    try { if ((await fetch(`${base}/livez`)).ok) break; } catch { /* 还没起 */ }
    await sleep(500);
  }
  const client = new Client({ name: 'identity-e2e', version: '1' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    return { raw: r._meta?.['localmcp/result'], text: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
  };
  const stop = async () => {
    await client.close().catch(() => { /* noop */ });
    try { process.platform === 'win32' ? execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) : child.kill('SIGTERM'); } catch { /* 已退出 */ }
    for (let i = 0; i < 40 && child.exitCode === null; i++) await sleep(250);
    await sleep(1000);
  };
  return { call, stop };
}

const readIdentity = (scratch, space) => JSON.parse(fs.readFileSync(path.join(scratch, 'profile-spaces', space, 'identity.json'), 'utf8'));

async function main() {
  const site = await startSite();
  const proxy = await startProxy();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-e2e-'));
  // 页面打开的是本机站点:Playwright 默认带 --proxy-bypass-list=<-loopback>,回环地址也走代理,正好能验证
  const viaUrl = `http://127.0.0.1:${site.port}/`;
  try {
    let srv = await startServer(scratch);
    const onDefault = await srv.call('space_new', { name: 'default', proxy: proxy.url });
    check('默认工作区不能经工具挂代理', onDefault.raw?.success === false, onDefault.raw?.error ?? '');
    const publicProxy = await srv.call('space_new', { name: 'p2', proxy: 'http://proxy.attacker.example:8080' });
    check('不在白名单的公网代理被拒', publicProxy.raw?.success === false, publicProxy.raw?.error ?? '');
    const made = await srv.call('space_new', { name: 'p1', proxy: proxy.url });
    check('space_new 挂代理成功', made.raw?.success === true, made.raw?.error ?? '');
    check('结果里代理账号密码打码', made.raw?.data?.proxy === `http://***@127.0.0.1:${new URL(proxy.url).port}` && !made.text.includes(PASS), made.raw?.data?.proxy);
    const id1 = readIdentity(scratch, 'p1');
    check('身份写进 identity.json', id1.proxy === proxy.url && id1.screen.width > 0, JSON.stringify(id1.screen));
    if (id1.geo) console.log(`[--]   出口时区已记进身份:${id1.geo.timezone}(${id1.geo.country})`);
    else console.log('[--]   出口时区没查到(本机连不上外网的查询接口时正常),时区跟系统');
    await srv.stop();

    srv = await startServer(scratch);
    await srv.call('space_switch', { name: 'p1' }).catch(() => null);
    await srv.call('space_new', { name: 'p1' });
    await srv.call('navigate', { url: viaUrl });
    const via = await srv.call('get_element_text', { selector: '#via' });
    const viaText = via.raw?.data?.text ?? '';
    check('重启后照样走代理(带账号密码)', viaText === 'yes' || proxy.seen.some((u) => u.includes(String(site.port))), `站点看到:${viaText};代理记录 ${proxy.seen.length} 条`);
    const id2 = readIdentity(scratch, 'p1');
    check('重启后身份不变', JSON.stringify(id2.screen) === JSON.stringify(id1.screen) && id2.proxy === id1.proxy);
    const cleared = await srv.call('space_new', { name: 'p1', proxy: '' });
    check('去掉代理时浏览器自动重开', cleared.raw?.data?.restarted === true && cleared.raw?.data?.proxy === null, JSON.stringify(cleared.raw?.data ?? cleared.raw));
    const before = proxy.seen.length;
    await srv.call('navigate', { url: viaUrl });
    const direct = await srv.call('get_element_text', { selector: '#via' });
    check('去掉代理后不再走代理', (direct.raw?.data?.text ?? '') === 'direct' && proxy.seen.length === before, direct.raw?.data?.text);
    await srv.stop();
  } finally {
    site.close();
    proxy.close();
    for (let i = 0; i < 20; i++) { try { fs.rmSync(scratch, { recursive: true, force: true }); break; } catch { await sleep(500); } }
  }
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n通过 ${results.length - failed} 项,失败 ${failed} 项`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
