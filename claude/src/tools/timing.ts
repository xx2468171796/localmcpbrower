/**
 * 工具内部的等待 / 超时 / 取消 / 导航重试。
 *
 * 原则:工具里**每一次**可能卡住的等待都要有上限(Playwright 的 evaluate、pdf、keyboard.press 没有自带超时),
 * 并且调用方取消(MCP notifications/cancelled)时立刻停下 —— 不然 AI 早就放弃了,浏览器还在后台跑几十秒。
 * 纯函数为主(signal 显式传入),单测直接跑。
 */

import { ToolError } from '../errors.js';

/** 把调用方给的毫秒数夹到 [min, max],没给用默认值 */
export function clampMs(value: number | undefined, def: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return def;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function cancelledError(): ToolError {
  return new ToolError('CANCELLED', '调用方已取消本次请求');
}

/** 可被取消的 sleep:signal 触发时立即以 CANCELLED 拒绝 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    const onAbort = (): void => { clearTimeout(timer); reject(cancelledError()); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface TimeoutOptions {
  signal?: AbortSignal;
  /** 超时后做清理(如终止页面里还在跑的脚本);清理出错不影响结果 */
  onTimeout?: () => unknown;
}

/**
 * 给一个 Promise 加上限:超时以 TIMEOUT 拒绝,取消以 CANCELLED 拒绝。
 * 原 Promise 之后再失败也不会变成无主的 rejection。计时器一定清掉。
 */
export function withTimeout<T>(work: Promise<T>, ms: number, what: string, opts: TimeoutOptions = {}): Promise<T> {
  const { signal, onTimeout } = opts;
  work.catch(() => { /* 超时 / 取消之后的迟到失败没人等了,吞掉 */ });
  if (signal?.aborted) return Promise.reject(cancelledError());
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => finish(() => {
      try { void Promise.resolve(onTimeout?.()).catch(() => { /* 清理失败不影响结果 */ }); } catch { /* 同上 */ }
      reject(new ToolError('TIMEOUT', `${what}超时(${ms}ms)`));
    }), Math.max(0, ms));
    const onAbort = (): void => finish(() => reject(cancelledError()));
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then((v) => finish(() => resolve(v)), (e: unknown) => finish(() => reject(e)));
  });
}

/** 页面在导航(执行上下文被换掉)导致的一次性失败:重试即可 */
export function isNavigationRace(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed|context was destroyed|Frame was detached.*navigat/i.test(m);
}

/**
 * 执行 fn;因为页面正在跳转而失败时,先 settle(等新文档加载)再重试,最多 tries 次。
 * 其它错误原样抛出。
 */
export async function retryOnNavigation<T>(fn: () => Promise<T>, settle: () => Promise<unknown>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isNavigationRace(e)) throw e;
      last = e;
      await settle().catch(() => { /* settle 自己失败就直接再试 */ });
    }
  }
  throw last;
}

/**
 * 长任务(批量抓取 / 翻页)的时间预算:留出余量,赶在服务端统一调用期限(TOOL_DEADLINE_MS,默认 120 秒)
 * 之前**带着已抓到的部分结果**返回,而不是被一刀切成 TIMEOUT、什么都拿不到。
 */
export function longTaskBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env['TOOL_DEADLINE_MS'] ?? '').trim();
  const deadline = Number(raw);
  // 显式 0 = 不限期:批量 / 翻页按 30 分钟兜底(防跑飞),而不是悄悄落回默认的 2 分钟
  if (raw !== '' && deadline === 0) return 30 * 60_000;
  const total = Number.isFinite(deadline) && deadline > 0 ? deadline : 120_000;
  return Math.max(10_000, total - 15_000);
}
