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

/**
 * 进度上报器。由 server.ts 的 wrap 从 MCP 请求上下文构造后放进 ALS,
 * 深层工具函数用 reportProgress() 调用 —— 与 sessionId 同样是**零侵入**:
 * 44 个工具函数签名一个都不用改。
 *
 * 客户端没给 progressToken 时,wrap 不会放这个字段,reportProgress() 静默 no-op。
 */
export type ProgressReporter = (progress: number, total?: number, message?: string) => void;

export interface McpCallContext {
  /** MCP 会话 ID(HTTP 传输由 transport 分配;stdio 恒为 STDIO_SESSION_ID) */
  sessionId: string;
  /** 本次调用的进度上报器;客户端未请求进度时为 undefined */
  progress?: ProgressReporter;
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

/**
 * 上报当前工具调用的进度。
 *
 * 长任务(crawl_pages 最多 50 页、batch_fetch 多 URL、discover_urls 全站探测)
 * 原本对调用方是完全黑盒 —— 只能等,等到超时也不知道卡在第几步。
 *
 * **故意做成"发射后不管"**:进度通知失败绝不能让工具本身失败。
 * 客户端没请求进度、连接已断、通知被拒 —— 一律静默吞掉。
 */
export function reportProgress(progress: number, total?: number, message?: string): void {
  try {
    mcpCtx.getStore()?.progress?.(progress, total, message);
  } catch {
    /* 进度是锦上添花,永远不该影响主流程 */
  }
}
