/**
 * cdp_send:把 Chrome DevTools Protocol 直接交给 AI(第一层控制「CDP 全开放」)。
 *
 * 47 个工具覆盖不到的事(模拟设备 / 地理位置 / 网络限速、读性能指标、改下载行为、拿 DOM 快照……)
 * 不用等人加工具,AI 直接发 CDP 命令。命令发在**当前标签页**的 CDP 会话上。
 *
 * 浏览器级的命令会影响整个浏览器甚至关掉它(Browser.close / Target.closeTarget / SystemInfo.*),
 * 默认不许发,设 ALLOW_BROWSER_CDP=1 才放开。
 */

import type { CDPSession, Page } from 'patchright';
import { getBrowserManager } from '../browser.js';
import { deskConfig } from '../desk/config.js';
import { ToolError, fail, failFrom } from '../errors.js';
import type { ToolResult } from '../types.js';
import { z } from 'zod';

export const CdpSendSchema = z.object({
  method: z.string().regex(/^[A-Z][A-Za-z]*\.[a-z][A-Za-z]*$/, '格式应为 Domain.command,如 Emulation.setGeolocationOverride'),
  params: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

/** 会动到整个浏览器的域 / 命令:需要 ALLOW_BROWSER_CDP */
const BROWSER_LEVEL = /^(Browser|Target|SystemInfo|Tethering|Storage)\.|^Page\.(close|crash)$/;

const sessions = new WeakMap<Page, Promise<CDPSession>>();

function sessionFor(page: Page): Promise<CDPSession> {
  let s = sessions.get(page);
  if (!s) {
    s = page.context().newCDPSession(page);
    sessions.set(page, s);
    // 会话建失败不要缓存坏结果,下次重建
    s.catch(() => sessions.delete(page));
  }
  return s;
}

export function browserCdpAllowed(): boolean {
  return deskConfig.allowBrowserCdp;
}

export async function cdpSend(input: unknown): Promise<ToolResult<{ method: string; result: unknown }>> {
  const parsed = CdpSendSchema.safeParse(input);
  if (!parsed.success) return fail('INVALID_ARGS', `参数验证失败: ${parsed.error.message}`);
  const { method, params, timeoutMs = 30_000 } = parsed.data;
  if (BROWSER_LEVEL.test(method) && !browserCdpAllowed()) {
    return fail('UNSUPPORTED', `${method} 会影响整个浏览器,默认不开放;确实需要请让人在这台服务上设 ALLOW_BROWSER_CDP=1`);
  }
  try {
    const page = await getBrowserManager().getPage();
    const session = await sessionFor(page);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ToolError('TIMEOUT', `${method} ${timeoutMs}ms 内没有返回`)), timeoutMs);
    });
    try {
      // CDP 命令名在运行时校验过格式;patchright 的类型只认已知命令名,这里按协议原样转发
      const send = session.send.bind(session) as (m: string, p?: Record<string, unknown>) => Promise<unknown>;
      const result = await Promise.race([send(method, params), timeout]);
      return { success: true, data: { method, result } };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    if (e instanceof ToolError) return fail(e.code, e.message);
    const r = failFrom(e);
    // CDP 自己的报错(方法不存在、参数不对)单独归一类,方便 AI 判断是「命令写错了」而不是页面问题
    return /Protocol error|method was not found|Invalid parameters/i.test(r.error) ? fail('CDP_ERROR', r.error) : r;
  }
}
