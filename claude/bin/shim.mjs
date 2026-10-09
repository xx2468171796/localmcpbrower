#!/usr/bin/env node
/**
 * stdio ⇄ pipe 字节泵。
 *
 * 客户端把它当成一个普通的 stdio MCP 服务器启动:
 *
 *   claude mcp add browser -- node <ROOT>/claude/bin/shim.mjs headless
 *
 * 它自己不懂 MCP,只把 stdin 的字节转给常驻进程的 named pipe / unix socket,
 * 再把回来的字节写到 stdout。真正的浏览器与 McpServer 都在常驻进程里,
 * 仍然是「一台机一份浏览器」。
 *
 * **为什么要有这一层**:协议 2026-07-28 删掉了协议级 session,服务端再也没有
 * 任何协议层线索能区分「这是哪个客户端窗口」。而客户端本来就是每个窗口 spawn 一份
 * stdio 子进程 —— 于是「一条 socket = 一个窗口 = 一个会话」,由内核保证唯一性
 * 和生命周期,不需要 44 个工具各自多带一个 handle 参数,也就不存在模型漏传导致的串台。
 * 详见 `src/pipe.ts` 头部。
 *
 * 常驻服务重启时自动重连并重放开场握手(session-relay.mjs),客户端不用手动 /mcp 重连。
 *
 * 刻意保持无依赖、不参与构建:它要在 `npm install` 之前就能跑,
 * 也不该因为 dist 没构建就失效。
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LineSplitter, SessionRelay } from './session-relay.mjs';

const service = process.argv[2] ?? 'headless';

/**
 * 候选端点路径。第一条与 src/pipe.ts 的 endpointPath 一致(服务端就按它建 socket);
 * 后面几条是**客户端拿不到 XDG_RUNTIME_DIR 时**的兜底。
 *
 * ⚠️ 为什么必须兜底:MCP 客户端 spawn stdio 服务器时普遍**只透传一小撮环境变量**
 * (SDK 的 getDefaultEnvironment 就是 HOME/PATH/SHELL/USER 那几个;实测 Codex 的
 * VSCode 扩展只给 8 个;本仓自己的 test/smoke-*.mjs 也没传)。
 * 而服务端跑在 pm2/登录会话里,XDG_RUNTIME_DIR **是有的** ——
 * 于是服务端建在 /run/user/1000/,shim 却去 /tmp 找,ENOENT,**永远连不上**。
 * 这不是配置问题:两边算路径的输入本来就不一样。
 *
 * `/run/user/<uid>` 在任何 systemd Linux 上都等价于 XDG_RUNTIME_DIR,可以直接推出来,
 * 不需要客户端配合传环境变量。(2026-08-31 实测于 Linux + Codex/Claude Code。)
 */
function endpointCandidates(svc) {
  if (process.platform === 'win32') {
    const user = (process.env.USERNAME ?? 'user').replace(/[^A-Za-z0-9_-]/g, '');
    return [String.raw`\\.\pipe\localmcp-` + `${user}-${svc}`];
  }
  const uid = process.getuid?.() ?? 0;
  const bases = [
    process.env.XDG_RUNTIME_DIR,
    process.platform === 'linux' ? `/run/user/${uid}` : undefined,
    os.tmpdir(),
    '/tmp',
  ].filter(Boolean);
  const seen = new Set();
  return bases
    .map((b) => path.join(b, `localmcp-${uid}-${svc}.sock`))
    .filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
}

// 命名管道没有「文件存在」这一说,Windows 直接用第一条;
// unix 挑真实存在的那条,都不存在时仍用第一条,好让报错信息指向服务端该建的位置。
// 每次连接前重新挑:服务刚被拉起时 socket 文件是后出现的。
function pickEndpoint() {
  const candidates = endpointCandidates(service);
  return process.platform === 'win32'
    ? candidates[0]
    : (candidates.find((p) => { try { return fs.statSync(p).isSocket(); } catch { return false; } }) ?? candidates[0]);
}

function connectOnce(endpoint) {
  return new Promise((resolve, reject) => {
    const s = net.connect(endpoint);
    s.once('connect', () => { s.removeAllListeners('error'); resolve(s); });
    s.once('error', reject);
  });
}

/**
 * 连不上常驻服务时,自己把它拉起来再连(最多等 60 秒),而不是直接失败。
 * 以前这里一失败,安装脚本就退回「每个窗口各起一套服务 + 一个浏览器」的直连模式,
 * 窗口一多内存就被顶爆 —— 现在不管服务在不在,注册的永远是 shim,全机共用一个浏览器。
 * 多个窗口同时拉起没关系:mcp.mjs start 发现服务已在跑会直接跳过。
 */
/**
 * 拉起常驻服务用哪个版本的 mcp.mjs:经 ai-kit 启动器(~/.ankotti/browser-mcp/shim.mjs)起的,启动器设了
 * LOCALMCP_STATE_FILE,用它记的当前版本(自动更新换过版本后,老窗口里的 shim 也不会把旧版本拉起来);否则用 shim 自己旁边的。
 */
function mcpScript() {
  const own = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp.mjs');
  const stateFile = process.env.LOCALMCP_STATE_FILE;
  if (!stateFile) return own;
  try {
    const root = JSON.parse(fs.readFileSync(stateFile, 'utf8')).current?.root;
    const p = root ? path.join(root, 'claude', 'mcp.mjs') : null;
    if (p && fs.existsSync(p)) return p;
  } catch { /* 读不到就用自己旁边的 */ }
  return own;
}

/**
 * graceMs:断线重连时先只等服务自己回来这么久、不去拉起 —— 多半是自动更新在换版本(先停旧的再起新的),
 * 这时抢着用自己这个版本的 mcp.mjs 把服务拉起来,会和更新器打架(2026-10-09 回滚演练里实测到)。
 */
async function connect(graceMs = 0) {
  for (const deadline = Date.now() + graceMs; ; ) {
    try { return await connectOnce(pickEndpoint()); } catch { /* 下面等一下或拉起 */ }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  {
    const mcp = mcpScript();
    process.stderr.write(`[shim] 常驻服务没在跑,正在拉起:node mcp.mjs start ${service}\n`);
    try {
      spawn(process.execPath, [mcp, 'start', service], { cwd: path.dirname(mcp), detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } catch { /* 下面的重试会给出最终错误 */ }
    let last;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
      await new Promise((r) => setTimeout(r, 1000));
      try { return await connectOnce(pickEndpoint()); } catch (e) { last = e; }
    }
    // 走 stderr:stdout 是 JSON-RPC 数据流,写一个字节的杂物就会把客户端解析器搞崩
    process.stderr.write(
      `[shim] 连不上常驻服务 ${pickEndpoint()}(${last?.code ?? last?.message ?? '超时'}),自动拉起也没成功。\n` +
      `[shim] 手动试:cd <ROOT>/claude && node mcp.mjs start ${service},再看 pm2 logs\n`
    );
    process.exit(1);
  }
}

// ── 转发 + 断线续接(见 session-relay.mjs)──
// 常驻服务重启(自动更新换版本 / 崩溃被 PM2 拉起)时不再跟着退出:在途请求各回一条错误,重连后重放开场握手,
// 客户端那边这个 MCP 不会「断开」,不用人手动 /mcp 重连。
const relay = new SessionRelay();
const queue = [];          // 续接期间客户端发来的行,握手重放完再发
let sock = null;
let resuming = false;
let stdinEnded = false;
let replayRest = [];
const RECONNECT_GRACE_MS = 180_000; // 换版本最慢:新版本健康检查 150 秒 + 退回;正常换版本 10 秒内就回来
const resumes = [];        // 最近的续接时刻:10 分钟内超过 20 次就放弃(服务在反复崩)

function toServer(line) {
  if (!sock || resuming) queue.push(line);
  else sock.write(line + '\n');
}

function replayDone() {
  for (const l of replayRest) sock.write(l + '\n');
  replayRest = [];
  resuming = false;
  for (const l of queue.splice(0)) sock.write(l + '\n');
  process.stderr.write('[shim] 已重新接上常驻服务\n');
}

function attach(s) {
  // Nagle 会把小的 JSON-RPC 消息攒着,给交互式调用凭空加延迟
  s.setNoDelay(true);
  s.setEncoding('utf8');
  const lines = new LineSplitter();
  s.on('data', (chunk) => {
    for (const line of lines.push(chunk)) {
      if (relay.fromServer(line)) process.stdout.write(line + '\n');
      else replayDone();
    }
  });
  s.on('error', (e) => process.stderr.write(`[shim] 与常驻服务的连接出错:${e.code ?? e.message}\n`));
  s.on('close', () => { if (s === sock) void onServerClosed(); });
}

async function onServerClosed() {
  sock = null;
  // 客户端已经走了,或者还没握过手(没东西可重放):照旧退出
  if (stdinEnded || !relay.canResume()) process.exit(0);
  const now = Date.now();
  resumes.push(now);
  while (resumes.length && now - resumes[0] > 10 * 60_000) resumes.shift();
  if (resumes.length > 20) {
    process.stderr.write('[shim] 常驻服务 10 分钟内断了 20 多次,不再自动重连\n');
    process.exit(1);
  }
  resuming = true;
  for (const line of relay.failPending('reconnecting')) process.stdout.write(line + '\n');
  process.stderr.write('[shim] 常驻服务断开了(可能在换版本),正在重连…\n');
  const s = await connect(RECONNECT_GRACE_MS);
  sock = s;
  attach(s);
  const [opening, ...rest] = relay.replayLines();
  replayRest = rest;
  s.write(opening + '\n');
  setTimeout(() => {
    if (resuming && sock === s) {
      process.stderr.write('[shim] 重连后握手 30 秒没回应,退出(客户端重连即可)\n');
      process.exit(1);
    }
  }, 30_000).unref();
}

// 连上之前客户端发来的消息留在 stdin 缓冲里,连上后一并转发,不丢
process.stdin.pause();
sock = await connect();
attach(sock);
process.stdin.setEncoding('utf8');
const fromClient = new LineSplitter();
process.stdin.on('data', (chunk) => {
  for (const line of fromClient.push(chunk)) {
    relay.fromClient(line);
    toServer(line);
  }
});
// 客户端断开就收尾,否则常驻服务会一直留着这个会话
process.stdin.on('end', () => {
  stdinEnded = true;
  if (fromClient.rest) toServer(fromClient.rest);
  if (sock) sock.end();
  else process.exit(0);
});
process.stdin.resume();
