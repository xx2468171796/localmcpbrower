/**
 * 3.0 工位能力端到端测试:真起服务、真开浏览器,逐项验证监测 / 接管 / 白名单 / 堡垒机取密钥 / CDP / 流程 / 管理接口。
 *
 *   node test/desk-e2e.mjs            # 无头(任何机器)
 *   HEADED=1 node test/desk-e2e.mjs   # 有头:另测自带扩展(录制、全标签页);Linux 需要 DISPLAY
 *
 * 隔离做法照 eval/harness.mjs:随机端口、临时 profile / 数据 / 截图目录、HOME 指向临时目录、不发遥测,
 * 不碰本机常驻服务和登录态。堡垒机用本地假服务(返回格式照 baolei 3.2.0 get_asset),不连真堡垒机。
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEADED = process.env.HEADED === '1';
const ADMIN = 'admin-test-token';
const SECRET = 'S3cret-Pa55';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${name}${detail ? ' — ' + detail : ''}`); };

function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

// ── 测试站点:/a 有站内链接和指向 localhost(另一个「站点」)的链接;/login 有账号密码框 ──
async function startSite() {
  const port = await freePort();
  const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title></head><body>${body}</body></html>`;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (u.pathname === '/a') res.end(page(`<a id="in" href="/b">B</a> <a id="out" href="http://localhost:${port}/b">外站</a>`));
    else if (u.pathname === '/b') res.end(page('<h1 id="b">page b</h1>'));
    else if (u.pathname === '/login') res.end(page('<input id="u" name="user"><input id="p" type="password" name="pass"><button id="go" onclick="document.title=\'submitted\'">登录</button>'));
    else { res.statusCode = 404; res.end(page('404')); }
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { port, base: `http://127.0.0.1:${port}`, close: () => srv.close() };
}

// ── 假堡垒机:get_asset 回资产文字(登记地址 = 测试站点 127.0.0.1) ──
async function startFakeBaolei(sitePort) {
  const port = await freePort();
  let calls = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls++;
      const args = JSON.parse(body).params?.arguments ?? {};
      const text = `    Asset 9 · 账号 · 测试站 · 管理员 · owner admin · 运行中
    address: http://127.0.0.1:${sitePort}/login（测试）
    account: alice
    secret: ${args.reveal ? SECRET : '(stored; reveal=true to get it)'}
    tags: test`;
      res.setHeader('content-type', 'text/event-stream');
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })}\n\n`);
    });
  });
  await new Promise((r) => srv.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${port}/mcp`, calls: () => calls, close: () => srv.close() };
}

async function startServer(extraEnv) {
  const port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-e2e-'));
  const d = (n) => { const p = path.join(scratch, n); fs.mkdirSync(p, { recursive: true }); return p; };
  const home = d('home');
  const env = {
    ...process.env, HOME: home, USERPROFILE: home,
    PORT: String(port), HOST: '127.0.0.1', HEADLESS: HEADED ? 'false' : 'true',
    DESK_ID: 'e2e', KILL_PORT_ON_START: '0', PIPE_DISABLE: '1',
    USER_DATA_DIR: d('profile'), LOCALMCP_DATA_DIR: d('data'), SCREENSHOT_DIR: d('shots'),
    ADMIN_TOKEN: ADMIN, BROWSER_TELEMETRY: '0', MCP_AUTH_TOKEN: '', PAUSE_WAIT_MAX_MS: '20000',
    ...extraEnv,
  };
  const log = fs.openSync(path.join(scratch, 'server.log'), 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', log, log], windowsHide: true });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) break;
    try { if ((await fetch(`${base}/livez`)).ok) break; } catch { /* 还没起 */ }
    await sleep(500);
  }
  const stop = async () => {
    try { process.platform === 'win32' ? execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) : child.kill('SIGTERM'); } catch { /* 已退出 */ }
    // Windows 上 Chromium 退出后文件句柄要一会儿才放,多试几次
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      try { fs.rmSync(scratch, { recursive: true, force: true }); return; } catch { /* 还被占着 */ }
    }
    console.log(`(临时目录没删掉:${scratch})`);
  };
  return { base, scratch, child, stop, logTail: () => fs.readFileSync(path.join(scratch, 'server.log'), 'utf8').slice(-3000) };
}

const admin = (base, p, init = {}) => fetch(`${base}/admin${p}`, { ...init, headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

async function main() {
  const site = await startSite();
  const baolei = await startFakeBaolei(site.port);
  const srv = await startServer({ BAOLEI_MCP_URL: baolei.url, BAOLEI_MCP_TOKEN: 'fake' });
  const client = new Client({ name: 'desk-e2e', version: '1' }, { capabilities: {} });
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 90_000 });
    return { r, raw: r._meta?.['localmcp/result'], text: (r.content ?? []).map((c) => c.text ?? '').join('\n') };
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${srv.base}/mcp`)));

    const list = await client.listTools();
    check('tools/list 有 57 个工具', list.tools.length === 57, `实际 ${list.tools.length}`);

    // 管理接口鉴权 + /livez 不拉起浏览器
    check('/admin 无令牌 401', (await fetch(`${srv.base}/admin/state`)).status === 401);
    const livez = await (await fetch(`${srv.base}/livez`)).json();
    check('/livez 正常且报工位 id', livez.status === 'ok' && livez.deskId === 'e2e');

    // 失败带 isError + 错误码
    await call('navigate', { url: `${site.base}/a` });
    const miss = await call('click', { selector: '#nope-does-not-exist', timeout: 1500 });
    check('失败带 isError 与错误码', miss.r.isError === true && typeof miss.raw?.code === 'string', `code=${miss.raw?.code}`);

    // 暂停:写操作等,只读放行,恢复后继续
    await admin(srv.base, '/pause', { method: 'POST', body: JSON.stringify({ by: 'e2e', reason: '人工登录' }) });
    let clicked = false;
    const pending = call('click', { selector: '#in' }).then((x) => { clicked = true; return x; });
    await sleep(800);
    const snap = await call('snapshot', {});
    check('暂停中只读工具放行', snap.raw?.success === true);
    check('暂停中写操作在等', clicked === false);
    await admin(srv.base, '/resume', { method: 'POST' });
    const after = await pending;
    check('恢复后写操作继续完成', after.raw?.success === true);

    // 白名单:参数网址 + 点链接跳外站
    await admin(srv.base, '/allowlist', { method: 'PUT', body: JSON.stringify({ domains: ['127.0.0.1'] }) });
    const blocked = await call('navigate', { url: `http://localhost:${site.port}/b` });
    check('白名单拦参数里的网址', blocked.raw?.code === 'DOMAIN_BLOCKED', `code=${blocked.raw?.code}`);
    await call('navigate', { url: `${site.base}/a` });
    await call('click', { selector: '#out' });
    await sleep(1000);
    const where = await call('execute_js', { script: 'return location.host' });
    // 被拦的主页面跳转会停在 Chrome 的拦截错误页(chromewebdata)或原页面,总之没到外站
    check('白名单拦点链接跳外站', !String(where.raw?.data?.result ?? '').startsWith('localhost'), `停在 ${where.raw?.data?.result}`);
    await admin(srv.base, '/allowlist', { method: 'PUT', body: JSON.stringify({ domains: [] }) });

    // 堡垒机取密钥:填得进、明文不外露、站点不对拒填
    await call('navigate', { url: `${site.base}/login` });
    const filled = await call('fill_secret', { asset: '9', selector: '#p' });
    const val = await call('execute_js', { script: `return document.querySelector('#p').value === ${JSON.stringify(SECRET)}` });
    check('fill_secret 填进了密码框', filled.raw?.success === true && val.raw?.data?.result === true, filled.raw?.error ?? '');
    check('fill_secret 结果里没有明文', !JSON.stringify(filled.r).includes(SECRET));
    const login = await call('login_with_asset', { asset: '9', user: { selector: '#u' }, pass: { selector: '#p' }, submit: { selector: '#go' } });
    const title = await call('execute_js', { script: 'return [document.title, document.querySelector("#u").value]' });
    check('login_with_asset 填账号并提交', login.raw?.success === true && JSON.stringify(title.raw?.data?.result) === '["submitted","alice"]', JSON.stringify(title.raw?.data?.result));
    await call('navigate', { url: `http://localhost:${site.port}/login` });
    const mismatch = await call('fill_secret', { asset: '9', selector: '#p' });
    check('站点对不上拒填', mismatch.raw?.code === 'SECRET_ORIGIN_MISMATCH', `code=${mismatch.raw?.code}`);

    // CDP 直通
    const cdp = await call('cdp_send', { method: 'Runtime.evaluate', params: { expression: '6*7', returnByValue: true } });
    check('cdp_send 页面级命令可用', cdp.raw?.data?.result?.result?.value === 42);
    const cdpNo = await call('cdp_send', { method: 'Browser.close' });
    check('cdp_send 浏览器级默认拒绝', cdpNo.raw?.code === 'UNSUPPORTED' && srv.child.exitCode === null);

    // run_flow:跨导航、变量引用
    const flow = await call('run_flow', { steps: [
      { tool: 'navigate', args: { url: `${site.base}/a` } },
      { tool: 'extract_links', args: {}, as: 'L' },
      { tool: 'navigate', args: { url: `${site.base}/b` } },
      { tool: 'get_element_text', args: { selector: '#b' }, as: 'B' },
    ] });
    check('run_flow 跨导航跑完 4 步', flow.raw?.success === true && flow.raw?.data?.completed === 4, flow.raw?.error ?? '');
    check('run_flow 存下变量', flow.raw?.data?.vars?.B?.text === 'page b', JSON.stringify(flow.raw?.data?.vars?.B));

    // 管理接口:状态 / 事件 / 截图 / 指标 / 重启 + recycled
    const state = await (await admin(srv.base, '/state')).json();
    const tabs = state.browser?.spaces?.flatMap((s) => s.sessions.flatMap((x) => x.tabs)) ?? [];
    check('/admin/state 看得到标签页', tabs.some((t) => t.url.includes('/b')), `${tabs.length} 个`);
    const ev = await (await admin(srv.base, '/events?since=0&limit=2000')).json();
    const kinds = new Set(ev.events.map((e) => e.kind));
    check('/admin/events 有调用与闸门事件', kinds.has('call_start') && kinds.has('call_end') && kinds.has('gate'));
    check('时间线里没有明文密码', !JSON.stringify(ev).includes(SECRET));
    check('时间线记了外站拦截', ev.events.some((e) => e.detail === 'blocked_by_allowlist'));
    const shot = await admin(srv.base, '/screenshot');
    check('/admin/screenshot 返回 PNG', shot.ok && shot.headers.get('content-type') === 'image/png');
    const metrics = await (await admin(srv.base, '/metrics')).json();
    check('/admin/metrics 有 Chromium pid', metrics.spaces?.some((s) => s.chromiumPid));
    await admin(srv.base, '/restart?space=default', { method: 'POST' });
    const re = await call('list_tabs', {});
    check('重启后下一次结果带 recycled', re.raw?.recycled === true, JSON.stringify(re.raw).slice(0, 120));

    // 自带扩展(有头)
    if (HEADED) {
      await call('navigate', { url: `${site.base}/login` });
      const rs = await call('record_start');
      check('record_start', rs.raw?.success === true, rs.raw?.error ?? '');
      await call('type', { selector: '#u', text: 'bob' });
      await call('click', { selector: '#go' });
      await sleep(500);
      const st = await call('record_stop');
      const tools = (st.raw?.data?.steps ?? []).map((s) => s.tool);
      check('录制转成了流程(type + click)', tools.includes('click') && tools.includes('type'), tools.join(','));
      const bt = await call('browser_tabs');
      check('browser_tabs 列出全部标签页', Array.isArray(bt.raw?.data) && bt.raw.data.length >= 1);
    }
    check('假堡垒机确实被调用', baolei.calls() >= 3);
  } catch (e) {
    check('测试过程没有抛异常', false, e instanceof Error ? e.stack : String(e));
    console.log(srv.logTail());
  } finally {
    await client.close().catch(() => {});
    await srv.stop();
    site.close();
    baolei.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length ? 1 : 0);
}

main();
