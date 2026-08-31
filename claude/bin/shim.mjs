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
 * 刻意保持无依赖、不参与构建:它要在 `npm install` 之前就能跑,
 * 也不该因为 dist 没构建就失效。
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const candidates = endpointCandidates(service);
// 命名管道没有「文件存在」这一说,Windows 直接用第一条;
// unix 挑真实存在的那条,都不存在时仍用第一条,好让报错信息指向服务端该建的位置。
const endpoint =
  process.platform === 'win32'
    ? candidates[0]
    : (candidates.find((p) => { try { return fs.statSync(p).isSocket(); } catch { return false; } }) ?? candidates[0]);
const sock = net.connect(endpoint);

// Nagle 会把小的 JSON-RPC 消息攒着,给交互式调用凭空加延迟
sock.setNoDelay(true);

sock.on('error', (e) => {
  // 走 stderr:stdout 是 JSON-RPC 数据流,写一个字节的杂物就会把客户端解析器搞崩
  process.stderr.write(
    `[shim] 连不上常驻服务 ${endpoint}(${e.code ?? e.message})。\n` +
    `[shim] 常驻服务没起来?试:cd <ROOT>/claude && node mcp.mjs start ${service}\n`
  );
  process.exit(1);
});

process.stdin.pipe(sock);
sock.pipe(process.stdout);

// 任意一端断开都要收尾,否则客户端会一直等一个永远不来的响应
sock.on('close', () => process.exit(0));
process.stdin.on('end', () => sock.end());
