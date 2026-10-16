/**
 * 拟人操作端到端:真起一个本仓的浏览器 MCP(隔离临时目录、BROWSER_HUMANIZE=1,不碰本机常驻服务和登录态),
 * 打开本地记录页,经 MCP 工具点击 / 悬停 / 输入 / 拖放 / 滚动,看页面收到的事件像不像人:
 * 点击前有足够多的 mousemove、落点不是正中心、事件 isTrusted、按键间隔有变化、最终值与要求完全一致。
 *
 *   node test/humanize-e2e.mjs            # 无头
 *   HEADED=1 node test/humanize-e2e.mjs   # 有头(Linux 要 DISPLAY)
 *
 * 退出码:全过 0;有失败 1;起不来 2。
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
const HEADED = process.env.HEADED === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

/** 记录页:所有事件记进 window.rec,同时序列化到 #rec(工具读 DOM,跨世界可见) */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>humanize</title>
<style>
  body { margin: 0; height: 4000px; font: 14px sans-serif; }
  #btn { position: absolute; left: 520px; top: 260px; width: 160px; height: 48px; }
  #hov { position: absolute; left: 120px; top: 420px; width: 140px; height: 60px; background: #ddd; }
  #name { position: absolute; left: 120px; top: 120px; width: 260px; }
  #pw { position: absolute; left: 120px; top: 170px; width: 260px; }
  #pre { position: absolute; left: 420px; top: 120px; width: 260px; }
  #date { position: absolute; left: 420px; top: 170px; }
  #src { position: absolute; left: 120px; top: 560px; width: 80px; height: 80px; background: #9cf; }
  #dst { position: absolute; left: 700px; top: 520px; width: 160px; height: 160px; background: #fc9; }
  #fr { position: absolute; left: 800px; top: 100px; width: 300px; height: 150px; border: 1px solid #999; }
  #rec { position: absolute; left: 0; top: 3900px; font-size: 8px; }
</style></head><body>
<input id="name" autocomplete="off"><input id="pw" type="password"><input id="pre" value="old value here"><input id="date" type="date">
<button id="btn">Click me</button><div id="hov">hover</div><div id="src">drag</div><div id="dst">drop</div>
<iframe id="fr" srcdoc="<button id=ibtn style='margin:40px;width:120px;height:40px' onclick='parent.rec.iframeClicks++'>in frame</button>"></iframe>
<pre id="rec"></pre>
<script>
  const rec = window.rec = { moves: 0, clicks: [], keys: [], hoverEntered: false, hoverMoves: 0, dragging: false, dragMoves: 0, dropped: false, wheel: 0, iframeClicks: 0 };
  const dump = () => { document.getElementById('rec').textContent = JSON.stringify({ ...rec, values: {
    name: document.getElementById('name').value, pw: document.getElementById('pw').value,
    pre: document.getElementById('pre').value, date: document.getElementById('date').value }, scrollY }); };
  setInterval(dump, 50);
  addEventListener('mousemove', (e) => { rec.moves++; if (rec.dragging) rec.dragMoves++; if (e.target.id === 'hov') rec.hoverMoves++; });
  addEventListener('wheel', () => { rec.wheel++; }, { passive: true });
  const btn = document.getElementById('btn');
  btn.addEventListener('click', (e) => {
    const r = btn.getBoundingClientRect();
    rec.clicks.push({ moves: rec.moves, trusted: e.isTrusted, dx: e.clientX - (r.left + r.width / 2), dy: e.clientY - (r.top + r.height / 2) });
    rec.moves = 0;
  });
  document.getElementById('hov').addEventListener('mouseenter', () => { rec.hoverEntered = true; });
  for (const id of ['name', 'pw']) document.getElementById(id).addEventListener('keydown', (e) => {
    rec.keys.push({ id, t: performance.now(), trusted: e.isTrusted, key: e.key === 'Backspace' ? 'BS' : '' });
  });
  document.getElementById('src').addEventListener('mousedown', () => { rec.dragging = true; rec.dragMoves = 0; });
  addEventListener('mouseup', (e) => {
    if (!rec.dragging) return;
    rec.dragging = false;
    const r = document.getElementById('dst').getBoundingClientRect();
    rec.dropped = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  });
</script></body></html>`;

async function startSite() {
  const port = await freePort();
  const srv = http.createServer((_req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(PAGE); });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { url: `http://localhost:${port}/`, close: () => srv.close() };
}

function playwrightBrowsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

async function startServer() {
  const port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'humanize-'));
  const d = (n) => { const p = path.join(scratch, n); fs.mkdirSync(p, { recursive: true }); return p; };
  const home = d('home');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath(),
    PORT: String(port), HOST: '127.0.0.1', HEADLESS: HEADED ? 'false' : 'true',
    KILL_PORT_ON_START: '0', PIPE_DISABLE: '1', BROWSER_HUMANIZE: '1',
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

const stdev = (xs) => { const m = xs.reduce((s, x) => s + x, 0) / xs.length; return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length); };

async function run(call, check, site) {
  const rec = async () => { await sleep(120); const r = await call('get_element_text', { selector: '#rec' }); return JSON.parse(r.data?.text || '{}'); };
  check('navigate', (await call('navigate', { url: site.url })).success);
  await call('wait_for_selector', { selector: '#btn' });
  await sleep(300);

  // 点击:三次,每次之前要有足够多的 mousemove、落点不在正中、isTrusted,三次落点不全一样
  let t0 = Date.now();
  for (let i = 0; i < 3; i++) {
    const r = await call('click', { selector: '#btn' });
    check(`click #${i + 1} 成功`, r.success, r.error);
    if (i === 0) console.log(`       (一次拟人点击耗时 ${Date.now() - t0}ms)`);
    await call('hover', { selector: '#hov' }); // 中间移开,下一次点击重新走一段轨迹
  }
  let s = await rec();
  check('click 都到达页面', s.clicks?.length === 3, JSON.stringify(s.clicks));
  for (const [i, c] of (s.clicks ?? []).entries()) {
    check(`click #${i + 1} 前 mousemove ≥ 10(实际 ${c.moves})`, c.moves >= 10);
    check(`click #${i + 1} isTrusted`, c.trusted === true);
    check(`click #${i + 1} 落点不在正中(偏 ${c.dx.toFixed(1)}, ${c.dy.toFixed(1)})`, Math.abs(c.dx) > 0.5 || Math.abs(c.dy) > 0.5);
  }
  const uniq = new Set((s.clicks ?? []).map((c) => `${c.dx.toFixed(1)},${c.dy.toFixed(1)}`));
  check(`三次落点各不相同(${uniq.size} 种)`, uniq.size >= 2);

  // 悬停
  const hv = await call('hover', { selector: '#hov' });
  s = await rec();
  check('hover 成功且触发 mouseenter', hv.success && s.hoverEntered === true, hv.error);

  // 输入
  const text = 'Hello World, humanize 123';
  t0 = Date.now();
  const ty = await call('type', { selector: '#name', text });
  const typeMs = Date.now() - t0;
  s = await rec();
  check(`type 成功(${typeMs}ms)`, ty.success, ty.error);
  check('type 最终值完全一致', s.values?.name === text, JSON.stringify(s.values?.name));
  const nameKeys = (s.keys ?? []).filter((k) => k.id === 'name');
  check(`type 逐字按键(keydown ${nameKeys.length} ≥ ${text.length})`, nameKeys.length >= text.length);
  check('type 按键 isTrusted', nameKeys.length > 0 && nameKeys.every((k) => k.trusted));
  const gaps = nameKeys.slice(1).map((k, i) => k.t - nameKeys[i].t);
  const sd = gaps.length ? stdev(gaps) : 0;
  check(`type 按键间隔有变化(标准差 ${sd.toFixed(1)}ms)`, sd > 10);

  const pw = 'S3cret!passw0rd';
  const tp = await call('type', { selector: '#pw', text: pw });
  s = await rec();
  check('密码框 type 值一致且结果标记 password', tp.success && s.values?.pw === pw && tp.data?.password === true, tp.error);
  check('密码框没有退格(不出错字)', !(s.keys ?? []).some((k) => k.id === 'pw' && k.key === 'BS'));

  const tr = await call('type', { selector: '#pre', text: 'replaced' });
  s = await rec();
  check('已有内容的输入框被替换', tr.success && s.values?.pre === 'replaced', JSON.stringify(s.values?.pre));

  const td = await call('type', { selector: '#date', text: '2026-10-17' });
  s = await rec();
  check('date 输入框退回 fill 仍然成功', td.success && s.values?.date === '2026-10-17', td.error ?? JSON.stringify(s.values?.date));

  const ff = await call('fill_form', { fields: [{ selector: '#name', value: 'form value', type: 'text' }] });
  s = await rec();
  check('fill_form 文本字段', ff.success && s.values?.name === 'form value', ff.error);

  // iframe 里的按钮
  const ic = await call('click', { selector: '#ibtn' });
  s = await rec();
  check('iframe 内按钮被点到', ic.success && s.iframeClicks === 1, ic.error ?? String(s.iframeClicks));

  // 拖放
  const dr = await call('drag_and_drop', { source: '#src', target: '#dst' });
  s = await rec();
  check('drag_and_drop 成功且落在目标里', dr.success && s.dropped === true, dr.error);
  check(`拖动过程 mousemove ≥ 10(实际 ${s.dragMoves})`, s.dragMoves >= 10);

  // 滚动
  const sc = await call('scroll', { y: 1500 });
  s = await rec();
  check(`scroll 到 1500(实际 ${sc.data?.y})`, sc.success && sc.data?.y === 1500, sc.error);
  check(`scroll 用滚轮分格(wheel ${s.wheel} ≥ 5)`, s.wheel >= 5);
  const back = await call('scroll', { y: 0 });
  check('scroll 回到 0', back.success && back.data?.y === 0, back.error);
}

async function main() {
  const site = await startSite();
  const srv = await startServer();
  const client = new Client({ name: 'humanize-e2e', version: '1' }, { capabilities: {} });
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
    return r._meta?.['localmcp/result'] ?? { success: false, error: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
  };
  let bad = 0;
  let ok = 0;
  const check = (name, pass, detail) => {
    if (pass) ok++; else bad++;
    console.log(`${pass ? '[OK]  ' : '[FAIL]'} ${name}${!pass && detail ? ' — ' + detail : ''}`);
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`)));
    await run(call, check, site);
  } finally {
    await client.close().catch(() => { /* noop */ });
    await srv.stop();
    site.close();
  }
  console.log(`\n通过 ${ok} 项,失败 ${bad} 项`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
