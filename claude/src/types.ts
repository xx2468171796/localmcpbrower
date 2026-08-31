/**
 * TypeScript 类型定义
 */

/** 控制台日志条目 */
export interface ConsoleLogEntry {
  type: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  timestamp: number;
}

/** 网络请求条目 */
export interface NetworkRequestEntry {
  url: string;
  method: string;
  status: number | null;
  resourceType: string;
  timestamp: number;
}

/** 工具执行成功结果 */
export interface ToolSuccessResult<T> {
  success: true;
  data: T;
}

/** 工具执行失败结果 */
export interface ToolErrorResult {
  success: false;
  error: string;
}

/** 工具执行结果联合类型 */
export type ToolResult<T> = ToolSuccessResult<T> | ToolErrorResult;

/** 浏览器管理器配置 */
export interface BrowserConfig {
  headless: boolean;
  userDataDir: string;
  viewportWidth: number;
  viewportHeight: number;
  devtools: boolean;
  slowMo: number;
}

/** 导航结果 */
export interface NavigateResult {
  url: string;
  title: string;
}

/** 点击结果 */
export interface ClickResult {
  selector: string;
  clicked: boolean;
}

/** 输入结果 */
export interface TypeResult {
  selector: string;
  typed: boolean;
}

/** 截图结果 */
export interface ScreenshotResult {
  path: string;
  fullPage: boolean;
}

/** 执行 JS 结果 */
export interface ExecuteJsResult {
  result: unknown;
}

/** 健康检查结果 */
export interface HealthCheckResult {
  status: 'ok' | 'error';
  browserAlive: boolean;
  uptime: number;
  /**
   * HTTP 传输层的活跃会话数。
   *
   * ⚠️ **只统计 HTTP 腿**。pipe 腿(纯 2026-07-28)的会话由 socket 生命周期管理,
   * 不进这个计数,所以纯 pipe 使用时它恒为 0 —— 这是正常的,不是回收有漏。
   */
  sessions?: number;
  /**
   * 真正持有浏览器标签页的会话数(两条腿合计)。
   *
   * ⚠️ 原注释写「与 sessions 对不上即说明回收有漏」—— 那条不变式**在 pipe 腿下永久失效**
   * (pipe 会话不计入 sessions,必然对不上)。照旧监控会一直误报。
   * 要判断回收有没有漏,看这个值在所有客户端断开后是否回落到 0。
   */
  browserSessions?: number;
}
