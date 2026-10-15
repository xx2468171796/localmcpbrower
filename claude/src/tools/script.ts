/**
 * 页面脚本:execute_js / run_script。
 *
 * 都跑在 patchright 的**隔离世界**(看不到页面自己的全局变量,DOM 共享)。
 * 两者都有 timeoutMs(默认 30 秒,最多 300 秒):以前脚本里 await 一个永远不 resolve 的 Promise、
 * 或写了死循环,工具就永远不返回,还会占着在途计数让空闲回收和自动更新一直等。
 * 超时后若渲染进程仍被同步代码占着,用 CDP Runtime.terminateExecution 把它停掉,后续工具才用得了这页。
 */

import type { CDPSession, Page } from 'patchright';
import { getBrowserManager } from '../browser.js';
import { failFrom, ToolError } from '../errors.js';
import { currentSignal } from '../context.js';
import { EGO_HELPER_SRC } from '../injected.js';
import { ExecuteJsSchema, RunScriptSchema } from '../schemas.js';
import type { ToolResult, ExecuteJsResult } from '../types.js';
import { parseInput } from './common.js';
import { clampMs, withTimeout } from './timing.js';

export const SCRIPT_TIMEOUT_DEFAULT = 30_000;
export const SCRIPT_TIMEOUT_MAX = 300_000;

/**
 * 超时清理:页面还卡在同步代码里(探针 1 秒内回不来)才终止,免得误杀下一段正常脚本。
 * CDP 会话必须在脚本开跑**之前**就连好:渲染线程被死循环占住后,新会话的消息根本得不到处理(实测),
 * 只有已连上的会话发的 Runtime.terminateExecution 会被 V8 当中断立即执行。
 */
async function stopRunawayScript(page: Page, session: CDPSession | null): Promise<void> {
  if (!session) return;
  const alive = await withTimeout(page.evaluate('1'), 1000, '探针').then(() => true, () => false);
  if (alive) return;
  await withTimeout(session.send('Runtime.terminateExecution'), 3000, '终止脚本').catch(() => { /* 尽力而为 */ });
}

/** 带上限跑一段页面脚本;页面脚本自己抛的错归为 SCRIPT_ERROR */
async function runBounded(page: Page, source: string, timeoutMs: number, what: string): Promise<unknown> {
  const session = await withTimeout(page.context().newCDPSession(page), 3000, '连接 CDP').catch(() => null);
  try {
    return await withTimeout(page.evaluate(source), timeoutMs, what, { signal: currentSignal() });
  } catch (e) {
    if (e instanceof ToolError) {
      if (e.code === 'TIMEOUT') {
        await stopRunawayScript(page, session);
        throw new ToolError('TIMEOUT', `${what}超过 ${timeoutMs}ms 没结束(可用 timeoutMs 调大,最多 ${SCRIPT_TIMEOUT_MAX})`);
      }
      if (e.code === 'CANCELLED') await stopRunawayScript(page, session);
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    // 脚本自己抛的(含语法错)→ SCRIPT_ERROR;页面关了 / 跳走了之类交给统一归类
    if (!/(Target|page|context|browser)[^\n]*(has been )?closed|Execution context was destroyed|Cannot find context|disconnected/i.test(msg)) {
      throw new ToolError('SCRIPT_ERROR', msg);
    }
    throw e;
  } finally {
    void session?.detach().catch(() => { /* 页面可能已关 */ });
  }
}

const isSyntaxError = (e: unknown): boolean =>
  e instanceof ToolError && e.code === 'SCRIPT_ERROR' && /SyntaxError/.test(e.message);

/**
 * 用户脚本可能是:(a) 裸表达式 document.title,(b) 含顶层 return 的语句,(c) 多语句无 return(要最后一个表达式的值)。
 *  - 有 return → 包成 async 函数体;
 *  - 没 return → 先当表达式 `return (脚本)`;是语法错(多语句 / 末尾分号)再当经典脚本求值(拿最后一个表达式的值),
 *    还是语法错(顶层 await)再包成 async 函数体。
 * **只在语法错时换写法重试**:语法错发生在执行之前,重试不会把副作用做两遍;
 * 以前任何错误都重试一遍,运行时报错的脚本(比如先 fetch 再抛错)会被执行两次。
 */
export async function executeJs(input: unknown): Promise<ToolResult<ExecuteJsResult>> {
  try {
    const { script, timeoutMs } = parseInput(ExecuteJsSchema, input);
    const ms = clampMs(timeoutMs, SCRIPT_TIMEOUT_DEFAULT, 100, SCRIPT_TIMEOUT_MAX);
    const page = await getBrowserManager().getPage();
    const asBody = `(async () => { ${script}\n})()`;
    if (/\breturn\b/.test(script)) {
      return { success: true, data: { result: await runBounded(page, asBody, ms, '脚本') } };
    }
    const attempts = [`(async () => { return (${script}\n); })()`, script, asBody];
    let last: unknown;
    for (const src of attempts) {
      try {
        return { success: true, data: { result: await runBounded(page, src, ms, '脚本') } };
      } catch (e) {
        if (!isSyntaxError(e)) throw e;
        last = e;
      }
    }
    throw last;
  } catch (error) {
    return failFrom(error);
  }
}

/**
 * 在页面上下文里一次性执行一段脚本,脚本内可直接调用 __ego.* 助手
 * (snapshot/click/fill/waitFor/text/attr/... 见 injected.ts),把 snapshot→
 * 操作→等待→读结果压进「一次 MCP 往返」,大幅省 token 与延迟。
 * 支持顶层 await 与顶层 return;返回值 JSON 序列化后回传。
 */
export async function runScript(input: unknown): Promise<ToolResult<{ result: unknown }>> {
  try {
    const { script, timeoutMs } = parseInput(RunScriptSchema, input);
    const ms = clampMs(timeoutMs, SCRIPT_TIMEOUT_DEFAULT, 100, SCRIPT_TIMEOUT_MAX);
    const page = await getBrowserManager().getPage();
    // 前置幂等注入 __ego,再把用户脚本包进 async IIFE 让顶层 await/return 合法
    const wrapped = `(async () => {\n${EGO_HELPER_SRC}\nreturn await (async () => {\n${script}\n})();\n})()`;
    return { success: true, data: { result: await runBounded(page, wrapped, ms, 'run_script 脚本') } };
  } catch (error) {
    return failFrom(error);
  }
}
