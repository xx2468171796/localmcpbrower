/**
 * Pipe 传输腿 —— 协议 2026-07-28 下的会话隔离方案。
 *
 * ## 为什么需要这个文件
 *
 * 协议 2026-07-28 **移除了协议级 session**(不再有 `Mcp-Session-Id`)。而本服务最核心的
 * 能力就是会话隔离:一台机一份浏览器,每个客户端窗口分到自己的标签页/屏蔽规则/登录态,
 * 互不串台。旧协议下隔离键直接取自 session id,新协议下**没有任何协议层线索**可用:
 *
 * - 官方 `CLIENT_INFO_META_KEY` 文档原文:"self-reported…**servers should not rely on it
 *   for behavior or security decisions**" —— 不能拿它当身份。
 * - `requestState` 是多步输入流程(`inputRequired`)的续传令牌,拿到 complete result
 *   那一刻客户端就丢了,**活不过一次 tools/call**。
 * - 官方指引的"显式 handle 当工具参数"可行,但把隔离正确性押在模型记忆力上:
 *   44 个工具每次都要带 handle,上下文压缩后漏带是必然而非概率事件,
 *   而漏带只有两条路 —— 严格报错(体验崩)或静默落到共享会话(**串台**,正是要防的事)。
 *
 * ## 解法:让操作系统提供身份
 *
 * **一条 socket = 一个窗口 = 一个会话。** 唯一性和生命周期由内核保证,不靠协议头,
 * 也不靠模型记得传参。
 *
 * 客户端把一个 ~15 行的字节泵(`bin/shim.mjs`)当普通 stdio MCP 服务器启动 ——
 * 这正是客户端**本来就在做的事**:实测本机 `codex.exe` 单进程下挂着 6 个
 * `--stdio` 子进程(2 个窗口 × 3 个服务),`claude.exe` 同理。每窗口一个子进程,
 * 正好就是我们要的隔离粒度,不需要客户端配合任何新东西。
 *
 * shim 只把字节转发到本文件监听的 named pipe / unix socket,真正的浏览器和
 * McpServer 都留在常驻进程里 —— 仍然是「一台机一份浏览器」。
 *
 * ## 官方背书
 *
 * `ServeStdioOptions.transport` 的原文:"Bring your own transport (for example a
 * `StdioServerTransport` constructed over a **Unix domain socket or TCP stream**,
 * per the stdio binding's custom-transport guidance)."
 * 而 `serveStdio` 的语义正是所需:开场那条消息定纪元,**一个 factory 实例钉住整条连接**。
 *
 * ## 已实测(原型,2026-08-31)
 *
 * 两个客户端各起一个 shim → 拿到互相隔离的状态(A 存 alpha、B 存 beta,互不可见);
 * 关掉 A 后 B 不受影响;全程 `versionNegotiation: { pin: '2026-07-28' }` 纯新协议。
 *
 * ⚠️ **实测发现的坑**:客户端的 `server/discover` 版本探测会**先单独开一条连接再关掉**,
 * 所以每个窗口实际产生 2 条连接。好在 `BrowserManager.getPage()` 是惰性的 ——
 * 探测连接不调任何工具,就不会开标签页。**别在连接建立时预创建浏览器上下文**,
 * 否则每开一个窗口就白起一个浏览器。
 */

import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import type { McpServer } from '@modelcontextprotocol/server';

/** 每条连接一个会话:工厂按 sessionId 造 McpServer,断开时回收该会话的页面 */
export interface PipeLegOptions {
  /** 服务名,用于区分不同服务的端点(headless / headed / db) */
  service: string;
  /** 造 McpServer —— 与 HTTP 腿共用同一个,保证两条腿工具完全一致 */
  createServer: (sessionId: string) => McpServer;
  /** 连接断开时回收该会话占用的资源(关标签页、清日志缓冲) */
  releaseSession: (sessionId: string) => void;
}

/**
 * 端点路径。
 *
 * - Windows:命名管道。**只能**放在 `\\.\pipe\` 下,这是 Win32 的硬性要求,
 *   不是可选目录。名字里带用户名,避免多用户登录同一台机时互相抢占。
 * - Linux/macOS:unix domain socket。放 `XDG_RUNTIME_DIR`(systemd 会随会话清理),
 *   没有就退到 `os.tmpdir()`。
 *   ⚠️ macOS 的 unix socket 路径有 **104 字节**硬上限(Linux 108),
 *   所以名字必须短,不能把长路径拼进去。
 */
export function endpointPath(service: string): string {
  if (process.platform === 'win32') {
    const user = (process.env['USERNAME'] ?? 'user').replace(/[^A-Za-z0-9_-]/g, '');
    return `\\\\.\\pipe\\localmcp-${user}-${service}`;
  }
  const base = process.env['XDG_RUNTIME_DIR'] ?? os.tmpdir();
  return path.join(base, `localmcp-${process.getuid?.() ?? 0}-${service}.sock`);
}

/**
 * 起 pipe 腿。返回一个关闭函数。
 *
 * 不做的事:**不预创建浏览器上下文**(见文件头的坑)。
 */
export function startPipeLeg(opts: PipeLegOptions): { close: () => void; endpoint: string } {
  const endpoint = endpointPath(opts.service);

  // unix socket 是文件,进程被 SIGKILL 后会留下死文件,下次 listen 直接 EADDRINUSE。
  // 但**不能无脑删** —— 那会把另一个正在跑的实例踢下线。先探活:连得上说明有人在用,
  // 连不上(ECONNREFUSED)才是死文件,可以安全删。
  if (process.platform !== 'win32' && fs.existsSync(endpoint)) {
    try {
      const probe = net.connect(endpoint);
      probe.on('error', () => { try { fs.unlinkSync(endpoint); } catch { /* 已被别人清掉 */ } });
      probe.on('connect', () => { probe.destroy(); });
      probe.setTimeout(300, () => probe.destroy());
    } catch { /* 探活失败不阻断启动,交给下面的 listen 报错 */ }
  }

  const srv = net.createServer((socket) => {
    const sessionId = `pipe-${randomUUID()}`;
    // Nagle 会把小的 JSON-RPC 消息攒着等,给交互式调用凭空加延迟
    socket.setNoDelay(true);

    let handle: { close?: () => void } | undefined;
    try {
      handle = serveStdio(() => opts.createServer(sessionId), {
        // 纪元策略。默认 'serve' —— 同一条连接上新旧两个纪元都服务。
        //
        // ⚠️ 别想当然改成 'reject'。实测(2026-08-31,Claude Code 2.1.251):
        // 同一个客户端走 **HTTP** 时会先发 server/discover 探测、能说 2026-07-28;
        // 但走 **stdio** 时直接发 initialize(2025-11-25)、**不探测**。
        // 而会话隔离恰恰只能走 stdio(shim 这条路)。
        // 于是 'reject' 会让所有工具直接连不上:
        //   -32022 Unsupported protocol version: 2025-11-25
        //
        // 关键在于:**隔离靠的是 socket,与协议纪元无关** —— 用 'serve' 一分不少。
        // 等客户端在 stdio 上也开始探测,同一份代码自动升到 2026-07-28,无需改动。
        // 想强制只收新协议(例如验证某个客户端是否已升级),设 PIPE_LEGACY=reject。
        legacy: (process.env['PIPE_LEGACY'] === 'reject' ? 'reject' : 'serve'),
        transport: new StdioServerTransport(socket, socket),  // 官方支持:自带 transport
        onerror: (e) => console.error(`[Pipe] ${sessionId.slice(0, 13)} ${e?.message ?? e}`),
      }) as { close?: () => void };
    } catch (e) {
      console.error('[Pipe] serveStdio 启动失败:', e);
      socket.destroy();
      return;
    }

    const cleanup = () => {
      try { handle?.close?.(); } catch { /* 已关 */ }
      // 版本探测连接从不调工具,releaseSession 对它是空操作 —— 惰性创建保证了这点
      opts.releaseSession(sessionId);
    };
    socket.once('close', cleanup);
    // socket 错误不该冒泡成 unhandled 'error' 把进程带走
    socket.on('error', () => { /* close 事件随后会到,统一在那里清理 */ });
  });

  srv.on('error', (e) => console.error('[Pipe] 监听错误:', e));
  srv.listen(endpoint, () => console.log(`[Pipe] 监听 ${endpoint}`));

  return {
    endpoint,
    close: () => {
      srv.close();
      if (process.platform !== 'win32') { try { fs.unlinkSync(endpoint); } catch { /* 无所谓 */ } }
    },
  };
}
