/**
 * 工具错误码:给编排(以后的 n8n)和管理服务判断失败原因用,文字说明仍给人和 AI 看。
 *
 * 两条来源:
 *   1. 新代码明确知道原因时用 fail(code, message) 直接给码;
 *   2. 老代码只返回 { success:false, error: 文字 },由 server.ts 的统一包装用 classifyError() 按文字归类补码,
 *      所以 98 处老的失败返回不用逐个改。
 * 码一旦发出就是契约:只增不改名。
 */

import type { ToolErrorResult } from './types.js';

export const ERROR_CODES = [
  'INVALID_ARGS',          // 参数校验没过
  'TIMEOUT',               // 超时(工具内部的等待、或统一调用期限)
  'NAVIGATION_FAILED',     // 打不开网址:DNS、拒绝连接、证书、被中断
  'ELEMENT_NOT_FOUND',     // 选择器 / ref 找不到元素
  'ELEMENT_NOT_ACTIONABLE',// 找到了但不可见 / 被遮挡 / 不可编辑
  'NO_PAGE',               // 没有可用标签页或页面已关闭
  'BROWSER_CLOSED',        // 浏览器 / 上下文已关闭(崩溃或被回收)
  'SCRIPT_ERROR',          // 页面脚本(execute_js / run_script)抛错
  'CANCELLED',             // 客户端取消了这次调用
  'PATH_DENIED',           // 文件路径越出允许的目录
  'DESK_PAUSED',           // 工位被人接管(暂停)中
  'DOMAIN_BLOCKED',        // 网址不在工位白名单里
  'SECRET_UNAVAILABLE',    // 堡垒机取不到资产(没配密钥 / 无权 / 不存在)
  'SECRET_ORIGIN_MISMATCH',// 当前页面站点和资产登记的地址对不上,拒绝填写
  'SECRET_PENDING_APPROVAL',// 资产每次使用要主人批准,等待超时(批准后再调即可)
  'CDP_ERROR',             // cdp_send 的 CDP 命令报错
  'UNSUPPORTED',           // 当前形态不支持(如无图形界面弹不出窗口)
  'INTERNAL',              // 其它未归类的错误
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** 新代码给明确原因时用 */
export function fail(code: ErrorCode, error: string): ToolErrorResult {
  return { success: false, error, code };
}

/** 抛出带码的错误:在深层函数里用,由工具外层 catch 转成 fail() */
export class ToolError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * 去掉 Playwright 报错末尾的「Call log:」调用日志:里面会原样带着 fill("<输入内容>") / type("<…>"),
 * 输入框内容(可能是密码)不能借报错回到 AI 或进时间线。
 */
export function stripCallLog(message: string): string {
  const i = message.search(/\n?\s*Call log:/i);
  return i >= 0 ? message.slice(0, i).trimEnd() : message;
}

/** 同 failFrom,但先去掉调用日志(输入类工具用) */
export function failFromQuiet(err: unknown): ToolErrorResult {
  const r = failFrom(err);
  return { ...r, error: stripCallLog(r.error) };
}

/** catch 块统一出口:带码错误保留码,其它按文字归类 */
export function failFrom(err: unknown): ToolErrorResult {
  if (err instanceof ToolError) return fail(err.code, err.message);
  const message = err instanceof Error ? err.message : String(err);
  return fail(classifyError(message, err), message);
}

/**
 * 按错误文字 / 类型归类(patchright 的报错是英文,本仓库自己的报错是中文,两种都认)。
 * 顺序有意义:先认最具体的。
 */
export function classifyError(message: string, err?: unknown): ErrorCode {
  const name = err instanceof Error ? err.name : '';
  const m = message;
  if (name === 'AbortError' || /aborted|已取消|cancell?ed by client/i.test(m)) return 'CANCELLED';
  if (name === 'TimeoutError' || /timeout|timed out|超时/i.test(m)) return 'TIMEOUT';
  if (/参数验证失败|必须提供其一|invalid (arg|param)|Input validation error/i.test(m)) return 'INVALID_ARGS';
  if (/net::ERR_|NS_ERROR_|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_CERT|navigation (to|failed)|Navigation failed/i.test(m)) return 'NAVIGATION_FAILED';
  if (/(Target|Browser|Context) (page, context or browser )?(has been |is )?closed|browser has disconnected|上下文已关闭|浏览器已关闭/i.test(m)) return 'BROWSER_CLOSED';
  if (/no (active )?page|没有(可用的)?(标签页|页面)|page (has been )?closed/i.test(m)) return 'NO_PAGE';
  if (/not visible|not enabled|not editable|intercepts pointer events|outside of the viewport|不可见|被遮挡|不可编辑/i.test(m)) return 'ELEMENT_NOT_ACTIONABLE';
  if (/未找到|找不到|not found|no element|waiting for (locator|selector)|strict mode violation/i.test(m)) return 'ELEMENT_NOT_FOUND';
  if (/Evaluation failed|ReferenceError|TypeError|SyntaxError|脚本(执行)?(出错|失败)/i.test(m)) return 'SCRIPT_ERROR';
  if (/路径(越|不允许)|path (outside|denied)/i.test(m)) return 'PATH_DENIED';
  return 'INTERNAL';
}
