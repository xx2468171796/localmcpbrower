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
import os from 'node:os';
import path from 'node:path';

const service = process.argv[2] ?? 'headless';

/** 必须与 src/pipe.ts 的 endpointPath 保持一致 —— 改一处必须改两处 */
function endpointPath(svc) {
  if (process.platform === 'win32') {
    const user = (process.env.USERNAME ?? 'user').replace(/[^A-Za-z0-9_-]/g, '');
    return String.raw`\\.\pipe\localmcp-` + `${user}-${svc}`;
  }
  const base = process.env.XDG_RUNTIME_DIR ?? os.tmpdir();
  return path.join(base, `localmcp-${process.getuid?.() ?? 0}-${svc}.sock`);
}

const endpoint = endpointPath(service);
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
