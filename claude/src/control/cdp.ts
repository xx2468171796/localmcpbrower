/**
 * cdp_send:把 Chrome DevTools Protocol 直接交给 AI(第一层控制「CDP 全开放」)。
 *
 * 47 个工具覆盖不到的事(模拟设备 / 地理位置 / 网络限速、读性能指标、改下载行为、拿 DOM 快照……)
 * 不用等人加工具,AI 直接发 CDP 命令。命令发在**当前标签页**的 CDP 会话上。
 *
 * 只开放页面级的域(白名单),并单独挡掉能读写本机文件、打开 file://、绕过网站白名单的命令 ——
 * 否则一条 Page.navigate file:///…/.claude.json 就能读到本机的堡垒机密钥。设 ALLOW_BROWSER_CDP=1 才全部放开。
 */

import type { CDPSession, Page } from 'patchright';
import { getBrowserManager } from '../browser.js';
import { deskConfig } from '../desk/config.js';
import { deskGate } from '../desk/runtime.js';
import { ToolError, fail, failFrom } from '../errors.js';
import type { ToolResult } from '../types.js';
import { z } from 'zod';

export const CdpSendSchema = z.object({
  method: z.string().regex(/^[A-Z][A-Za-z]*\.[a-z][A-Za-z]*$/, '格式应为 Domain.command,如 Emulation.setGeolocationOverride'),
  params: z.record(z.string(), z.unknown()).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

/**
 * 默认开放的域(白名单,不是黑名单):都是「当前页面里」的能力,和 execute_js / 现有工具同一权限级别。
 * 不在表里的域(Browser / Target / SystemInfo / Storage / IO / Fetch / Tethering / ServiceWorker …)要 ALLOW_BROWSER_CDP=1。
 */
const PAGE_DOMAINS: ReadonlySet<string> = new Set([
  'Accessibility', 'Animation', 'Audits', 'CSS', 'DOM', 'DOMDebugger', 'DOMSnapshot', 'DOMStorage', 'Emulation',
  'IndexedDB', 'CacheStorage', 'Input', 'LayerTree', 'Log', 'Media', 'Network', 'Overlay', 'Page', 'Performance',
  'PerformanceTimeline', 'Runtime', 'Debugger', 'HeapProfiler', 'Profiler', 'WebAudio',
]);

/**
 * 白名单域里也要单独挡的命令:它们能越过本服务的文件 / 路径 / 白名单保护。
 *   - 读本机任意文件:DOM.setFileInputFiles、带 files 的 Input.dispatchDragEvent、Network.loadNetworkResource
 *   - 写任意位置:Page.setDownloadBehavior
 *   - 打开 file:// 或白名单外网站:Page.navigate 另查(见 checkPageCommand)
 *   - 关 / 崩页面:Page.close、Page.crash
 */
const DENIED = new Set(['DOM.setFileInputFiles', 'Network.loadNetworkResource', 'Page.setDownloadBehavior', 'Page.close', 'Page.crash']);

/** 页面级命令的额外检查;不放行抛 ToolError */
export function checkPageCommand(method: string, params: Record<string, unknown> | undefined): void {
  const domain = method.split('.')[0] ?? '';
  if (!PAGE_DOMAINS.has(domain) || DENIED.has(method)) {
    throw new ToolError('UNSUPPORTED', `${method} 会越过本服务的文件 / 网站保护或影响整个浏览器,默认不开放;确实需要请让人在这台服务上设 ALLOW_BROWSER_CDP=1`);
  }
  if (method === 'Input.dispatchDragEvent') {
    const files = (params?.['data'] as { files?: unknown } | undefined)?.files;
    if (Array.isArray(files) && files.length) throw new ToolError('UNSUPPORTED', '带本机文件的拖拽会绕过上传目录限制,不开放;上传请用 file_upload');
  }
  if (method === 'Page.navigate') {
    const url = String(params?.['url'] ?? '');
    if (!/^https?:\/\//i.test(url)) throw new ToolError('UNSUPPORTED', `Page.navigate 只许 http(s) 网址,收到「${url.slice(0, 80)}」`);
    deskGate.checkUrl(url);
  }
}

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
  try {
    if (!browserCdpAllowed()) checkPageCommand(method, params);
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
