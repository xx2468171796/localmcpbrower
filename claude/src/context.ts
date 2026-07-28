/**
 * MCP 调用上下文(AsyncLocalStorage)
 *
 * 为什么用 ALS 而不是给工具函数加 sessionId 参数:
 * 44 个工具函数签名里都没有 sessionId,逐个改签名改动面极大且极易漏改一处
 * 导致「A 会话操作到 B 会话的页面」这类隐蔽串台。改用 Node 原生 AsyncLocalStorage
 * 隐式携带 —— server.ts 在每次工具调用最外层 run 一次,BrowserManager 内部按需读取,
 * 工具函数签名一律不动(零侵入)。
 *
 * 向后兼容:stdio 传输只有一个会话,且不经过 mcpCtx.run 包裹 → getStore() 为空,
 * 回落到固定的 __stdio__,退化成改造前的单会话行为。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface McpCallContext {
  /** MCP 会话 ID(HTTP 传输由 transport 分配;stdio 恒为 STDIO_SESSION_ID) */
  sessionId: string;
}

/** stdio(以及任何未经 mcpCtx.run 包裹的内部调用)使用的固定会话 ID */
export const STDIO_SESSION_ID = '__stdio__';

export const mcpCtx = new AsyncLocalStorage<McpCallContext>();

/** 当前调用所属的会话 ID;无上下文时回落单会话语义 */
export function currentSessionId(): string {
  return mcpCtx.getStore()?.sessionId ?? STDIO_SESSION_ID;
}

/** 在指定会话上下文中执行(server.ts 的工具注册包装函数用) */
export function runInSession<R>(sessionId: string, fn: () => R): R {
  return mcpCtx.run({ sessionId }, fn);
}
