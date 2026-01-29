/**
 * TypeScript 类型定义
 * @description 定义项目中使用的所有类型
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

/** SSE 消息格式 */
export interface SSEMessage {
  event: 'tool_result' | 'error' | 'heartbeat';
  data: {
    id: string;
    result?: unknown;
    error?: string;
  };
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
}
