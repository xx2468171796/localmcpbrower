/**
 * 会话上下文 —— 用 AsyncLocalStorage 隐式携带 sessionId。
 *
 * 为什么不给工具函数加 sessionId 参数:15 个工具签名全改一遍既大又易漏,
 * 而 ALS 能让 database.ts 在任意深度直接读到"当前请求属于哪个会话"。
 *
 * stdio 模式下没有 store,回落到固定的 __stdio__ —— 单进程单会话,
 * 行为与改造前完全一致(向后兼容的关键)。
 *
 * 注:mcp-database 是独立 npm 包,不能从浏览器侧 claude/src 导入,故自带一份同构实现。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface McpSessionContext {
  sessionId: string;
}

export const mcpCtx = new AsyncLocalStorage<McpSessionContext>();

/** stdio(以及任何没有 ALS store 的调用路径)使用的固定会话标识 */
export const STDIO_SESSION_ID = '__stdio__';

export function currentSessionId(): string {
  return mcpCtx.getStore()?.sessionId ?? STDIO_SESSION_ID;
}
