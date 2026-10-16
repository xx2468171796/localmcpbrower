/**
 * MCP 工具定义 - 原子化浏览器操作能力
 *
 * 按职责拆在 tools/ 下(交互、脚本、提取、批量抓取、快照、文件);本文件留导航 / 读取 / 标签页 / 工作区 / 人工接管,
 * 并把全部工具从这里统一导出 —— server.ts 只 import './tools.js'。
 * 约定:参数先过 Zod(失败 INVALID_ARGS);失败一律 failFrom(error) 带错误码;每步等待有上限并跟随调用方取消。
 */

import type { Page } from 'patchright';
import { getBrowserManager } from './browser.js';
import { fail, failFrom, ToolError } from './errors.js';
import { currentSignal, throwIfCancelled } from './context.js';
import {
  NavigateSchema, WaitForSelectorSchema, GetElementTextSchema, GetElementAttributeSchema,
  GetPageContentSchema, GetCookiesSchema, SetCookiesSchema, PageReportSchema, SetViewportSchema,
  NewTabSchema, TabIndexSchema, SpaceNameSchema, SpaceNewSchema, WaitForHumanSchema,
} from './schemas.js';
import type { ToolResult, NavigateResult, ConsoleLogEntry, NetworkRequestEntry } from './types.js';
import { parseInput, settle, sig, targetFrame } from './tools/common.js';
import { sleep, withTimeout } from './tools/timing.js';

export { click, type, hover, selectOption, fillForm, keyboardPress, dragAndDrop, fileUpload, scroll } from './tools/interact.js';
export { executeJs, runScript } from './tools/script.js';
export { extractLinks, extractData, waitAndExtract, extractArticle, setBlockRules, interceptRequests } from './tools/extract.js';
export { batchFetch, crawlPages, discoverUrls } from './tools/crawl.js';
export { snapshot } from './tools/snapshot.js';
export { takeScreenshot, pdfExport } from './tools/files.js';

const navFailed = (e: unknown): ToolError =>
  e instanceof ToolError ? e : new ToolError(/Timeout/i.test(String(e)) ? 'TIMEOUT' : 'NAVIGATION_FAILED', e instanceof Error ? e.message : String(e));

/** 读标题:页面忙(同步脚本卡住)时不让工具跟着卡死 */
const titleOf = (page: Page): Promise<string> => withTimeout(page.title(), 3000, '读标题').catch(() => '');

export async function navigate(input: unknown): Promise<ToolResult<NavigateResult & { requestedUrl: string; status: number | null; download?: boolean }>> {
  try {
    const { url } = parseInput(NavigateSchema, input);
    const page = await getBrowserManager().getPage();
    let status: number | null = null;
    try {
      const resp = await page.goto(url, { ...sig(), waitUntil: 'commit', timeout: 30000 });
      status = resp?.status() ?? null;
    } catch (e) {
      // 直接指向文件的网址:Chromium 当下载处理,goto 报「Download is starting」—— 这不是打不开
      if (e instanceof Error && /Download is starting/i.test(e.message)) {
        return { success: true, data: { url: page.url(), requestedUrl: url, title: await titleOf(page), status: null, download: true } };
      }
      throw navFailed(e);
    }
    // 'commit' 在文档 title 解析前就返回,需等 DOM 解析完成再读 title;慢页面 10 秒兜底
    await settle(page);
    // url 给跳转(重定向)后的真实地址;原来请求的放 requestedUrl
    return { success: true, data: { url: page.url(), requestedUrl: url, title: await titleOf(page), status } };
  } catch (error) {
    return failFrom(error);
  }
}

export async function setViewport(input: unknown): Promise<ToolResult<{ width: number; height: number }>> {
  try {
    const { width, height } = parseInput(SetViewportSchema, input);
    const page = await getBrowserManager().getPage();
    await page.setViewportSize({ width, height });
    return { success: true, data: { width, height } };
  } catch (error) {
    return failFrom(error);
  }
}

export async function getConsoleLogs(): Promise<ToolResult<ConsoleLogEntry[]>> {
  try {
    // 先把页面里攒着的日志排空取回 —— 主世界的 console 捕获把日志攒在页面里,得由这边主动来取(见 browser.ts drainPageLogs / inject.ts)。
    // ⚠️ 边界(不是 bug):execute_js / run_script 跑在隔离世界,它们内部的 console.log 不经过主世界劫持,不会出现在这里。
    await withTimeout(getBrowserManager().drainPageLogs(), 5000, '读取页面日志').catch(() => { /* 先给已有的 */ });
    return { success: true, data: getBrowserManager().getConsoleLogs() };
  } catch (error) {
    return failFrom(error);
  }
}

export async function getNetwork(): Promise<ToolResult<NetworkRequestEntry[]>> {
  try {
    return { success: true, data: getBrowserManager().getNetworkRequests() };
  } catch (error) {
    return failFrom(error);
  }
}

/** 后退 / 前进:没有历史可走时如实说 moved=false(以前照样报成功,AI 以为已经回到上一页) */
async function history(dir: 'back' | 'forward'): Promise<ToolResult<NavigateResult & { moved: boolean }>> {
  try {
    const page = await getBrowserManager().getPage();
    const opts = { ...sig(), timeout: 10000, waitUntil: 'commit' as const };
    const before = page.url();
    const resp = await (dir === 'back' ? page.goBack(opts) : page.goForward(opts)).catch((e: unknown) => { throw navFailed(e); });
    await settle(page, 5000);
    const moved = resp !== null || page.url() !== before;
    return { success: true, data: { url: page.url(), title: await titleOf(page), moved } };
  } catch (error) {
    return failFrom(error);
  }
}

export function goBack(): Promise<ToolResult<NavigateResult & { moved: boolean }>> { return history('back'); }
export function goForward(): Promise<ToolResult<NavigateResult & { moved: boolean }>> { return history('forward'); }

export async function waitForSelector(input: unknown): Promise<ToolResult<{ found: boolean }>> {
  try {
    const { selector, state, timeout } = parseInput(WaitForSelectorSchema, input);
    const page = await getBrowserManager().getPage();
    // 超大 timeout 夹到 5 分钟:等待不该比调用期限还长
    await page.waitForSelector(selector, { state, timeout: Math.min(Math.max(0, timeout), 300_000), ...sig() });
    return { success: true, data: { found: true } };
  } catch (error) {
    return failFrom(error);
  }
}

/**
 * 读元素(文本 / 属性 / HTML)的公共部分:穿透 iframe;选择器匹配多个时取第一个并报 count
 * (以前 locator 严格模式,匹配到 2 个就报「strict mode violation」)。
 */
async function firstMatch(selector: string): Promise<{ loc: ReturnType<Page['locator']>; count: number }> {
  const page = await getBrowserManager().getPage();
  const frame = await targetFrame(page, selector, false);
  const all = frame.locator(selector);
  await all.first().waitFor({ state: 'attached', timeout: 5000, ...sig() })
    .catch((e: unknown) => { throw new ToolError('ELEMENT_NOT_FOUND', `元素未找到: ${selector}(${e instanceof Error ? e.message.split('\n')[0] : String(e)})`); });
  return { loc: all.first(), count: await all.count() };
}

export async function getElementText(input: unknown): Promise<ToolResult<{ text: string; count: number }>> {
  try {
    const { selector } = parseInput(GetElementTextSchema, input);
    const { loc, count } = await firstMatch(selector);
    const text = await loc.textContent({ timeout: 5000, ...sig() }) ?? '';
    return { success: true, data: { text, count } };
  } catch (error) {
    return failFrom(error);
  }
}

export async function getElementAttribute(input: unknown): Promise<ToolResult<{ value: string | null; count: number }>> {
  try {
    const { selector, attribute } = parseInput(GetElementAttributeSchema, input);
    const { loc, count } = await firstMatch(selector);
    const value = await loc.getAttribute(attribute, { timeout: 5000, ...sig() });
    return { success: true, data: { value, count } };
  } catch (error) {
    return failFrom(error);
  }
}

export async function getPageContent(input: unknown): Promise<ToolResult<{ content: string }>> {
  try {
    const { type: contentType, selector } = parseInput(GetPageContentSchema, input);
    let content: string;
    if (selector) {
      const { loc } = await firstMatch(selector);
      content = contentType === 'html'
        ? await loc.innerHTML({ timeout: 5000, ...sig() })
        : await loc.textContent({ timeout: 5000, ...sig() }) ?? '';
    } else {
      const page = await getBrowserManager().getPage();
      // body 可能不存在(XML / SVG 文档):以前直接 TypeError
      content = contentType === 'html'
        ? await withTimeout(page.content(), 15_000, '读取页面 HTML')
        : await withTimeout(page.evaluate('(document.body || document.documentElement).innerText') as Promise<string>, 15_000, '读取页面文本');
    }
    return { success: true, data: { content } };
  } catch (error) {
    return failFrom(error);
  }
}

export async function getCookies(input: unknown): Promise<ToolResult<{ cookies: unknown[] }>> {
  try {
    const { name } = parseInput(GetCookiesSchema, input);
    const context = await getBrowserManager().getContext();
    const cookies = await context.cookies();
    return { success: true, data: { cookies: name ? cookies.filter((c) => c.name === name) : cookies } };
  } catch (error) {
    return failFrom(error);
  }
}

export async function setCookies(input: unknown): Promise<ToolResult<{ set: number }>> {
  try {
    const { cookies } = parseInput(SetCookiesSchema, input);
    const page = await getBrowserManager().getPage();
    const current = page.url();
    const pageIsHttp = /^https?:\/\//i.test(current);
    const list = cookies.map((c) => {
      const extra = { expires: c.expires, httpOnly: c.httpOnly, secure: c.secure };
      if (c.domain) return { name: c.name, value: c.value, domain: c.domain, path: c.path ?? '/', ...extra };
      // 没给 domain:落到当前页面的站点(以前默认 'localhost',在任何真实网站上都不生效)
      if (!pageIsHttp) throw new ToolError('INVALID_ARGS', `Cookie ${c.name} 没给 domain,当前页面也不是 http(s) 网址,无法确定归属站点`);
      const u = new URL(current);
      return { name: c.name, value: c.value, domain: u.hostname, path: c.path ?? '/', ...extra };
    });
    await page.context().addCookies(list);
    return { success: true, data: { set: cookies.length } };
  } catch (error) {
    return failFrom(error);
  }
}

const REPORT_SRC = {
  stats: `({ elements: document.querySelectorAll('*').length, scripts: document.querySelectorAll('script').length, styles: document.querySelectorAll('link[rel="stylesheet"], style').length })`,
  links: `(() => { const links = Array.from(document.querySelectorAll('a[href]')); const current = window.location.hostname; return { total: links.length, internal: links.filter(a => a.hostname === current).length, external: links.filter(a => a.hostname !== current && a.hostname !== '').length, anchors: links.filter(a => a.getAttribute('href')?.startsWith('#')).length }; })()`,
  forms: `({ total: document.querySelectorAll('form').length, inputs: document.querySelectorAll('input').length, buttons: document.querySelectorAll('button, input[type="submit"]').length })`,
  images: `(() => { const images = Array.from(document.querySelectorAll('img')); return { total: images.length, withAlt: images.filter(img => img.alt && img.alt.trim() !== '').length, withoutAlt: images.filter(img => !img.alt || img.alt.trim() === '').length }; })()`,
};

export async function generatePageReport(input: unknown): Promise<ToolResult<unknown>> {
  try {
    const { includeLinks, includeForms, includeImages } = parseInput(PageReportSchema, input);
    const page = await getBrowserManager().getPage();
    const run = (src: string): Promise<unknown> => withTimeout(page.evaluate(src), 10_000, '页面报告');
    const report: Record<string, unknown> = { url: page.url(), title: await titleOf(page), timestamp: new Date().toISOString() };
    report.stats = await run(REPORT_SRC.stats);
    if (includeLinks) report.links = await run(REPORT_SRC.links);
    if (includeForms) report.forms = await run(REPORT_SRC.forms);
    if (includeImages) report.images = await run(REPORT_SRC.images);
    return { success: true, data: report };
  } catch (error) {
    return failFrom(error);
  }
}

// ------------------------------------------------------------
// 多标签页:一律只作用于**调用方会话自己的标签页**。
// ------------------------------------------------------------

export async function listTabs(): Promise<ToolResult<{ tabs: { index: number; url: string; title: string; active: boolean }[] }>> {
  try {
    const bm = getBrowserManager();
    const pages = await bm.getSessionPages();
    const activeIndex = bm.getActiveTabIndex();
    const tabs = await Promise.all(pages.map(async (p, i) => ({ index: i, url: p.url(), title: await titleOf(p), active: i === activeIndex })));
    return { success: true, data: { tabs } };
  } catch (error) {
    return failFrom(error);
  }
}

export async function newTab(input: unknown): Promise<ToolResult<{ index: number; url: string; title?: string }>> {
  try {
    // 网址同 navigate 只认 http(s):以前这里不校验,file:// 能从新标签页打开
    const { url } = parseInput(NewTabSchema, input);
    // openTab 内部已把新标签页设为本会话的活跃页(在 goto 之前),跳转超时后续操作也作用于新页
    const { page, index } = await getBrowserManager().openTab();
    if (url) {
      await page.goto(url, { ...sig(), waitUntil: 'commit', timeout: 30000 }).catch((e: unknown) => { throw navFailed(e); });
      await settle(page);
    }
    return { success: true, data: { index, url: page.url(), title: await titleOf(page) } };
  } catch (error) {
    return failFrom(error);
  }
}

export async function switchTab(input: unknown): Promise<ToolResult<{ index: number; url: string; title: string }>> {
  try {
    const { index } = parseInput(TabIndexSchema, input);
    const page = await getBrowserManager().activateTab(index).catch((e: unknown) => {
      throw new ToolError('INVALID_ARGS', e instanceof Error ? e.message : String(e));
    });
    await withTimeout(page.bringToFront(), 5000, '切到前台').catch(() => { /* 无头下无所谓 */ });
    return { success: true, data: { index, url: page.url(), title: await titleOf(page) } };
  } catch (error) {
    return failFrom(error);
  }
}

export async function closeTab(input: unknown): Promise<ToolResult<{ closed: boolean; remaining: number }>> {
  try {
    const { index } = parseInput(TabIndexSchema, input);
    const remaining = await getBrowserManager().closeTabAt(index).catch((e: unknown) => {
      throw new ToolError('INVALID_ARGS', e instanceof Error ? e.message : String(e));
    });
    return { success: true, data: { closed: true, remaining } };
  } catch (error) {
    return failFrom(error);
  }
}

// ============================================================
// Task Spaces:并行隔离工作区
// ============================================================

export async function spaceList(): Promise<ToolResult<{
  active: string; spaces: { name: string; active: boolean; alive: boolean; headed: boolean; url: string | null }[];
}>> {
  try {
    const bm = getBrowserManager();
    return { success: true, data: { active: bm.getActiveSpace(), spaces: bm.listSpaces() } };
  } catch (error) {
    return failFrom(error);
  }
}

export async function spaceNew(input: unknown): Promise<ToolResult<{
  name: string; created: boolean; headed: boolean; reason?: string; active: string; proxy: string | null; humanize: boolean | null; restarted?: boolean;
}>> {
  try {
    const { name, headed, proxy, humanize } = parseInput(SpaceNewSchema, input);
    const res = await getBrowserManager().createSpace(name, headed, {
      ...(proxy !== undefined ? { proxy } : {}), ...(humanize !== undefined ? { humanize } : {}),
    });
    return { success: true, data: { ...res, active: getBrowserManager().getActiveSpace() } };
  } catch (error) {
    return failFrom(error);
  }
}

export async function spaceSwitch(input: unknown): Promise<ToolResult<{ name: string; active: string }>> {
  try {
    const { name } = parseInput(SpaceNameSchema, input);
    const res = await getBrowserManager().switchSpace(name);
    return { success: true, data: { ...res, active: getBrowserManager().getActiveSpace() } };
  } catch (error) {
    return failFrom(error);
  }
}

export async function spaceClose(input: unknown): Promise<ToolResult<{ closed: boolean; active: string }>> {
  try {
    const { name } = parseInput(SpaceNameSchema, input);
    return { success: true, data: await getBrowserManager().closeSpace(name) };
  } catch (error) {
    return failFrom(error);
  }
}

/** 收起可见窗口:当前工作区换回无头(登录态、标签页网址原样带过去) */
export async function hideWindow(): Promise<ToolResult<{ headed: boolean; switched: boolean; restored: string[]; reason?: string }>> {
  try {
    return { success: true, data: await getBrowserManager().ensureHeadless() };
  } catch (error) {
    return failFrom(error);
  }
}

type HumanCheck = { appears?: string | undefined; disappears?: string | undefined; urlChanges: boolean; startUrl: string };

/** 一轮检查:满足任一判据返回原因,否则 null。每步限时,页面卡住也不会把轮询拖死 */
async function humanDone(page: Page, c: HumanCheck): Promise<string | null> {
  const url = page.url();
  if (c.urlChanges && url && url !== c.startUrl) return `网址已变化:${c.startUrl} → ${url}`;
  const has = (sel: string): Promise<boolean | null> =>
    withTimeout(page.$(sel).then((el) => !!el), 2000, '检查元素').catch(() => null);
  if (c.appears && (await has(c.appears)) === true) return `元素已出现:${c.appears}`;
  if (c.disappears && (await has(c.disappears)) === false) return `元素已消失:${c.disappears}`;
  return null;
}

/**
 * 等人工在可见窗口里处理完(扫码登录 / 验证码 / 风控确认)。
 * 不用 elicitation(bypassPermissions 下会被客户端静默拒绝),改成盯页面变化:出现 / 消失 / 网址变化。
 * 每轮重取当前活跃页(人可能中途换标签页);当前是无头时(show 默认 true)先换成有窗口的。
 */
export async function waitForHuman(input: unknown): Promise<ToolResult<{
  reason: string; elapsedSec: number; url: string; title: string;
  headed: boolean; switchedToHeaded: boolean; showNote?: string;
}>> {
  try {
    const { appears, disappears, urlChanges, timeoutSec, show } = parseInput(WaitForHumanSchema, input);
    const bm = getBrowserManager();
    const mode = await showForHuman(show);
    const extra = { headed: mode.headed, switchedToHeaded: mode.switched, ...(mode.reason ? { showNote: mode.reason } : {}) };
    const startUrl = await bm.getPage().then((p) => p.url()).catch(() => '');
    const t0 = Date.now();
    const deadline = t0 + timeoutSec * 1000;
    while (Date.now() < deadline) {
      throwIfCancelled();
      await sleep(700, currentSignal());   // 够快让人无感,又不至于把 CPU 打满
      const page = await bm.getPage().catch(() => null);
      if (!page || page.isClosed()) continue;
      const reason = await humanDone(page, { appears, disappears, urlChanges, startUrl });
      if (reason) {
        return { success: true, data: { reason, elapsedSec: Math.round((Date.now() - t0) / 1000), url: page.url(), title: await titleOf(page), ...extra } };
      }
    }
    const page = await bm.getPage().catch(() => null);
    const url = page && !page.isClosed() ? page.url() : '';
    // 超时是正常结局之一(人没来得及处理):如实返回 TIMEOUT,调用方决定再等一轮还是放弃
    const shown = mode.headed ? (mode.switched ? '已弹出可见窗口,' : '') : `没有可见窗口(${mode.reason ?? '当前是无头'}),`;
    return fail('TIMEOUT', `等待 ${timeoutSec}s 后人工操作仍未完成(${shown}当前网址:${url || '未知'})。可加大 timeoutSec 再等,或确认判定条件是否写对。`);
  } catch (error) {
    return failFrom(error);
  }
}

/**
 * 要人工之前把窗口亮出来(wait_for_human / request_human 共用)。
 * show=false 只报告现状不换。换不成不算失败,结果里 headed=false + reason 如实告诉 AI;
 * 别的调用正占着浏览器时 ensureHeaded 抛错,由调用方转成失败。
 */
export async function showForHuman(show: boolean): Promise<{ headed: boolean; switched: boolean; reason?: string }> {
  const bm = getBrowserManager();
  if (!show) return { headed: bm.isHeaded(), switched: false };
  const r = await bm.ensureHeaded();
  return { headed: r.headed, switched: r.switched, ...(r.reason ? { reason: r.reason } : {}) };
}
