/**
 * 每次工具调用的统一流水线(监测层 + 控制层的挂钩点,server.ts 的 humanizeOutput 调它):
 *   记「开始」→ 过闸门(暂停 / 白名单)→ 在调用期限内执行 → 补错误码 → 记「结束」。
 * HTTP 腿、pipe 腿、stdio 的所有工具调用都经过这里,所以时间线和接管对它们一视同仁。
 */

import { ToolError, classifyError, type ErrorCode } from '../errors.js';
import { summarizeArgs } from './events.js';
import { deskGate, deskRing } from './runtime.js';
import { deskConfig } from './config.js';

export interface CallMeta {
  tool: string;
  session: string;
  args: unknown;
  signal?: AbortSignal;
}

/** 工具结果里的原始外形 { success, data, error, code } */
export interface RawResult {
  success: boolean;
  data?: unknown;
  error?: string;
  code?: ErrorCode;
  recycled?: boolean;
}

/** 参数里出现的网址(navigate / new_tab 的 url,batch_fetch 的 urls,流程步骤的 args.url) */
export function urlsIn(args: unknown, depth = 0): string[] {
  if (!args || typeof args !== 'object' || depth > 3) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if ((k === 'url' || k === 'startUrl') && typeof v === 'string') out.push(v);
    else if (k === 'urls' && Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === 'string'));
    else if (k === 'steps' && Array.isArray(v)) for (const s of v) out.push(...urlsIn((s as { args?: unknown })?.args, depth + 1));
  }
  return out;
}

/** 调用前:闸门 + 白名单。不放行抛 ToolError */
export async function preflight(meta: CallMeta): Promise<void> {
  await deskGate.admit(meta.tool, meta.signal);
  for (const u of urlsIn(meta.args)) deskGate.checkUrl(u);
}

/** 在期限内跑完;超时返回 TIMEOUT(工具本身可能还在收尾,各工具自己的超时会让它结束) */
export async function withDeadline<T>(p: Promise<T>, tool: string, ms = deskConfig.toolDeadlineMs): Promise<T> {
  if (!ms) return p;
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ToolError('TIMEOUT', `${tool} 超过 ${Math.round(ms / 1000)} 秒没有完成,已放弃等待`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 失败结果补上错误码(老代码只给文字) */
export function withCode(r: RawResult): RawResult {
  if (r.success || r.code) return r;
  return { ...r, code: classifyError(r.error ?? '') };
}

export function errorOf(e: unknown): RawResult {
  if (e instanceof ToolError) return { success: false, error: e.message, code: e.code };
  const msg = e instanceof Error ? e.message : String(e);
  return { success: false, error: msg, code: classifyError(msg, e) };
}

/** 记开始,返回「记结束」的函数 */
export function trackCall(meta: CallMeta): (r: RawResult | null, ms: number) => void {
  const callId = deskRing.newCallId();
  deskRing.push({ kind: 'call_start', callId, session: meta.session, tool: meta.tool, args: summarizeArgs(meta.args) });
  return (r, ms) => {
    const url = (r?.data as { url?: unknown } | undefined)?.url;
    deskRing.push({
      kind: 'call_end', callId, session: meta.session, tool: meta.tool, ms: Math.round(ms),
      ok: r?.success ?? false,
      ...(r && !r.success ? { code: r.code, error: (r.error ?? '').slice(0, 300) } : {}),
      ...(typeof url === 'string' ? { url } : {}),
    });
  };
}
