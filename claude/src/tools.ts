/**
 * MCP 工具定义 - 原子化浏览器操作能力
 */

import * as path from 'path';
import * as fs from 'fs';
import { getBrowserManager } from './browser.js';
import {
  NavigateSchema, ClickSchema, TypeSchema, ScreenshotSchema,
  ExecuteJsSchema, ScrollSchema, WaitForSelectorSchema,
  GetElementTextSchema, GetElementAttributeSchema, HoverSchema,
  SelectOptionSchema, FillFormSchema, GetPageContentSchema,
  PdfExportSchema, GetCookiesSchema, SetCookiesSchema,
  PageReportSchema, SetViewportSchema,
  ExtractLinksSchema, ExtractDataSchema, BatchFetchSchema,
  CrawlPagesSchema, WaitAndExtractSchema, SetBlockRulesSchema,
  SnapshotSchema, ExtractArticleSchema, DiscoverUrlsSchema
} from './schemas.js';
import { Readability } from '@mozilla/readability';
import { Defuddle } from 'defuddle/node';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import type {
  ToolResult, NavigateResult, ClickResult, TypeResult,
  ScreenshotResult, ExecuteJsResult, ConsoleLogEntry, NetworkRequestEntry
} from './types.js';

function ensureScreenshotDir(): string {
  const dir = path.resolve('storage/screenshots');
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
  return dir;
}

export async function navigate(input: unknown): Promise<ToolResult<NavigateResult>> {
  try {
    const parsed = NavigateSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { url } = parsed.data;
    const page = await getBrowserManager().getPage();
    await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
    // 'commit' 在文档 title 解析前就返回，需等 DOM 解析完成再读 title。
    // 慢页面用短超时兜底，避免 hang；超时后仍尝试用 document.title 兜底。
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    let title = await page.title().catch(() => '');
    if (!title) {
      title = await page.evaluate(() => document.title).catch(() => '') || '';
    }
    return { success: true, data: { url, title } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function setViewport(input: unknown): Promise<ToolResult<{ width: number; height: number }>> {
  try {
    const parsed = SetViewportSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { width, height } = parsed.data;
    const page = await getBrowserManager().getPage();
    await page.setViewportSize({ width, height });
    return { success: true, data: { width, height } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 把 ref 编号解析为 CSS 选择器；selector / ref 二选一 */
function resolveTarget(selector?: string, ref?: string): { ok: true; selector: string; fromRef: boolean } | { ok: false; error: string } {
  if (ref) return { ok: true, selector: `[data-mcp-ref="${ref}"]`, fromRef: true };
  if (selector) return { ok: true, selector, fromRef: false };
  return { ok: false, error: 'selector 与 ref 必须提供其一' };
}

/** 当目标来自 ref 时，校验该 ref 仍存在于 DOM；不存在则返回友好提示 */
async function checkRefAlive(
  page: import('patchright').Page,
  selector: string,
  fromRef: boolean,
  ref?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!fromRef) return { ok: true };
  const count = await page.locator(selector).count().catch(() => 0);
  if (count > 0) return { ok: true };
  return { ok: false, error: `ref ${ref ?? ''} 未找到(页面可能已重新渲染),请重新调用 snapshot 获取最新 ref` };
}

export async function click(input: unknown): Promise<ToolResult<ClickResult>> {
  try {
    const parsed = ClickSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const target = resolveTarget(parsed.data.selector, parsed.data.ref);
    if (!target.ok) return { success: false, error: target.error };
    const selector = target.selector;
    const page = await getBrowserManager().getPage();
    const refCheck = await checkRefAlive(page, selector, target.fromRef, parsed.data.ref);
    if (!refCheck.ok) return { success: false, error: refCheck.error };
    try {
      // 优先尝试正常点击（等待可见）
      await page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
      await page.click(selector, { timeout: 5000, noWaitAfter: true });
    } catch {
      // 元素隐藏或导航超时时，尝试 force 点击
      try {
        await page.click(selector, { force: true, timeout: 5000, noWaitAfter: true });
      } catch {
        // 最终 fallback: 通过 JS 直接点击
        await page.evaluate(`(function() {
          var sel = ${JSON.stringify(selector)};
          var el = document.querySelector(sel);
          if (el) el.click();
          else throw new Error('元素未找到: ' + sel);
        })()`);
      }
    }
    return { success: true, data: { selector, clicked: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function type(input: unknown): Promise<ToolResult<TypeResult>> {
  try {
    const parsed = TypeSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const target = resolveTarget(parsed.data.selector, parsed.data.ref);
    if (!target.ok) return { success: false, error: target.error };
    const selector = target.selector;
    const { text } = parsed.data;
    const page = await getBrowserManager().getPage();
    const refCheck = await checkRefAlive(page, selector, target.fromRef, parsed.data.ref);
    if (!refCheck.ok) return { success: false, error: refCheck.error };
    try {
      // 优先尝试正常填充（等待可见）
      await page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
      await page.fill(selector, text, { timeout: 5000 });
    } catch {
      // 元素隐藏时，尝试 force 填充
      try {
        await page.fill(selector, text, { force: true, timeout: 5000 });
      } catch {
        // 最终 fallback: 通过 JS 直接设置值
        await page.evaluate(`(function() {
          var sel = ${JSON.stringify(selector)};
          var el = document.querySelector(sel);
          if (!el) throw new Error('元素未找到: ' + sel);
          el.value = ${JSON.stringify(text)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        })()`);
      }
    }
    return { success: true, data: { selector, typed: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function takeScreenshot(input: unknown): Promise<ToolResult<ScreenshotResult & { base64?: string; format?: 'jpeg' | 'png' }>> {
  try {
    const parsed = ScreenshotSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { name, fullPage, format, quality } = parsed.data;
    const page = await getBrowserManager().getPage();
    const screenshotDir = ensureScreenshotDir();
    const fileName = name ?? `screenshot-${Date.now()}`;
    const ext = format === 'png' ? 'png' : 'jpg';
    const filePath = path.join(screenshotDir, `${fileName}.${ext}`);

    // 等待字体就绪，但用 300ms 超时兜底，避免 document.fonts.ready 永不 resolve 导致挂起
    await Promise.race([
      page.evaluate('document.fonts && document.fonts.ready').catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 300)),
    ]);

    const shotOpts = format === 'jpeg'
      ? { type: 'jpeg' as const, quality }
      : { type: 'png' as const };

    let buffer: Buffer;
    try {
      // 第一次尝试：正常截图，10 秒超时
      buffer = await page.screenshot({ path: filePath, fullPage, timeout: 10000, animations: 'disabled', scale: 'css', ...shotOpts });
    } catch {
      // 第二次尝试：不等待字体，缩小视口截图
      buffer = await page.screenshot({ path: filePath, fullPage: false, timeout: 10000, animations: 'disabled', scale: 'css', ...shotOpts });
    }
    const base64 = buffer.toString('base64');
    return { success: true, data: { path: filePath, fullPage, base64, format } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getConsoleLogs(): Promise<ToolResult<ConsoleLogEntry[]>> {
  try {
    return { success: true, data: getBrowserManager().getConsoleLogs() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getNetwork(): Promise<ToolResult<NetworkRequestEntry[]>> {
  try {
    return { success: true, data: getBrowserManager().getNetworkRequests() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function executeJs(input: unknown): Promise<ToolResult<ExecuteJsResult>> {
  try {
    const parsed = ExecuteJsSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { script } = parsed.data;
    const page = await getBrowserManager().getPage();
    // 用户脚本可能是：(a) 裸表达式 document.title，(b) 含顶层 return 的语句，
    // (c) 多语句脚本含顶层 return。后两者作为裸表达式传给 evaluate 会报
    // "Illegal return statement"。统一包成异步函数体即可让 return 合法。
    // 裸表达式则直接 return 它，保持原有返回值语义。
    const trimmed = script.trim();
    const looksLikeStatements = /\breturn\b/.test(trimmed) || /[;\n]/.test(trimmed);
    const wrappedScript = looksLikeStatements
      ? `(async () => { ${script}\n})()`
      : `(async () => { return (${script}\n); })()`;
    let result: unknown;
    try {
      result = await page.evaluate(wrappedScript);
    } catch (err) {
      // 极少数裸表达式被误判（如对象字面量），回退为直接求值
      if (!looksLikeStatements) {
        result = await page.evaluate(script);
      } else {
        throw err;
      }
    }
    return { success: true, data: { result } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function scroll(input: unknown): Promise<ToolResult<{ scrolled: boolean }>> {
  try {
    const parsed = ScrollSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { x, y, selector } = parsed.data;
    const page = await getBrowserManager().getPage();
    if (selector) {
      await page.locator(selector).scrollIntoViewIfNeeded({ timeout: 3000 });
    } else {
      await page.evaluate(`window.scrollTo(${x ?? 0}, ${y ?? 0})`);
    }
    return { success: true, data: { scrolled: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function goBack(): Promise<ToolResult<NavigateResult>> {
  try {
    const page = await getBrowserManager().getPage();
    await page.goBack({ timeout: 10000, waitUntil: 'commit' });
    return { success: true, data: { url: page.url(), title: await page.title() } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function goForward(): Promise<ToolResult<NavigateResult>> {
  try {
    const page = await getBrowserManager().getPage();
    await page.goForward({ timeout: 10000, waitUntil: 'commit' });
    return { success: true, data: { url: page.url(), title: await page.title() } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function hover(input: unknown): Promise<ToolResult<{ hovered: boolean }>> {
  try {
    const parsed = HoverSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const target = resolveTarget(parsed.data.selector, parsed.data.ref);
    if (!target.ok) return { success: false, error: target.error };
    const selector = target.selector;
    const page = await getBrowserManager().getPage();
    const refCheck = await checkRefAlive(page, selector, target.fromRef, parsed.data.ref);
    if (!refCheck.ok) return { success: false, error: refCheck.error };
    await page.hover(selector, { timeout: 5000 });
    return { success: true, data: { hovered: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function waitForSelector(input: unknown): Promise<ToolResult<{ found: boolean }>> {
  try {
    const parsed = WaitForSelectorSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { selector, state, timeout } = parsed.data;
    const page = await getBrowserManager().getPage();
    await page.waitForSelector(selector, { state, timeout });
    return { success: true, data: { found: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getElementText(input: unknown): Promise<ToolResult<{ text: string }>> {
  try {
    const parsed = GetElementTextSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { selector } = parsed.data;
    const page = await getBrowserManager().getPage();
    const text = await page.locator(selector).textContent({ timeout: 5000 }) ?? '';
    return { success: true, data: { text } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getElementAttribute(input: unknown): Promise<ToolResult<{ value: string | null }>> {
  try {
    const parsed = GetElementAttributeSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { selector, attribute } = parsed.data;
    const page = await getBrowserManager().getPage();
    const value = await page.locator(selector).getAttribute(attribute, { timeout: 5000 });
    return { success: true, data: { value } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function selectOption(input: unknown): Promise<ToolResult<{ selected: boolean }>> {
  try {
    const parsed = SelectOptionSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { selector, value, label } = parsed.data;
    const page = await getBrowserManager().getPage();
    if (value) { await page.selectOption(selector, { value }, { timeout: 5000 }); }
    else if (label) { await page.selectOption(selector, { label }, { timeout: 5000 }); }
    return { success: true, data: { selected: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function fillForm(input: unknown): Promise<ToolResult<{ filled: number }>> {
  try {
    const parsed = FillFormSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { fields } = parsed.data;
    const page = await getBrowserManager().getPage();
    let filled = 0;
    for (const field of fields) {
      if (field.type === 'select') {
        await page.selectOption(field.selector, field.value, { timeout: 3000 });
      } else if (field.type === 'checkbox') {
        const checked = field.value === 'true';
        if (checked) { await page.check(field.selector, { timeout: 3000 }); }
        else { await page.uncheck(field.selector, { timeout: 3000 }); }
      } else {
        await page.fill(field.selector, field.value, { timeout: 3000 });
      }
      filled++;
    }
    return { success: true, data: { filled } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getPageContent(input: unknown): Promise<ToolResult<{ content: string }>> {
  try {
    const parsed = GetPageContentSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { type: contentType, selector } = parsed.data;
    const page = await getBrowserManager().getPage();
    let content: string;
    if (selector) {
      const element = page.locator(selector);
      content = contentType === 'html'
        ? await element.innerHTML({ timeout: 5000 })
        : await element.textContent({ timeout: 5000 }) ?? '';
    } else {
      content = contentType === 'html'
        ? await page.content()
        : await page.evaluate('document.body.innerText');
    }
    return { success: true, data: { content } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function pdfExport(input: unknown): Promise<ToolResult<{ path: string }>> {
  try {
    const parsed = PdfExportSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { path: pdfPath } = parsed.data;
    const page = await getBrowserManager().getPage();
    const dir = path.dirname(pdfPath);
    if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); }
    await page.pdf({ path: pdfPath, printBackground: true, format: 'A4' });
    return { success: true, data: { path: pdfPath } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getCookies(input: unknown): Promise<ToolResult<{ cookies: unknown[] }>> {
  try {
    const parsed = GetCookiesSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { name } = parsed.data;
    const context = await getBrowserManager().getContext();
    const cookies = await context.cookies();
    const filtered = name ? cookies.filter(c => c.name === name) : cookies;
    return { success: true, data: { cookies: filtered } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function setCookies(input: unknown): Promise<ToolResult<{ set: number }>> {
  try {
    const parsed = SetCookiesSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { cookies } = parsed.data;
    const context = await getBrowserManager().getContext();
    await context.addCookies(cookies.map(c => ({
      name: c.name, value: c.value,
      domain: c.domain ?? 'localhost', path: c.path ?? '/',
      expires: c.expires, httpOnly: c.httpOnly, secure: c.secure
    })));
    return { success: true, data: { set: cookies.length } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function generatePageReport(input: unknown): Promise<ToolResult<unknown>> {
  try {
    const parsed = PageReportSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { includeLinks, includeForms, includeImages } = parsed.data;
    const page = await getBrowserManager().getPage();
    const report: Record<string, unknown> = {
      url: page.url(), title: await page.title(), timestamp: new Date().toISOString()
    };
    report.stats = await page.evaluate(`({ elements: document.querySelectorAll('*').length, scripts: document.querySelectorAll('script').length, styles: document.querySelectorAll('link[rel="stylesheet"], style').length })`);
    if (includeLinks) {
      report.links = await page.evaluate(`(() => { const links = Array.from(document.querySelectorAll('a[href]')); const current = window.location.hostname; return { total: links.length, internal: links.filter(a => a.hostname === current).length, external: links.filter(a => a.hostname !== current && a.hostname !== '').length, anchors: links.filter(a => a.getAttribute('href')?.startsWith('#')).length }; })()`);
    }
    if (includeForms) {
      report.forms = await page.evaluate(`({ total: document.querySelectorAll('form').length, inputs: document.querySelectorAll('input').length, buttons: document.querySelectorAll('button, input[type="submit"]').length })`);
    }
    if (includeImages) {
      report.images = await page.evaluate(`(() => { const images = Array.from(document.querySelectorAll('img')); return { total: images.length, withAlt: images.filter(img => img.alt && img.alt.trim() !== '').length, withoutAlt: images.filter(img => !img.alt || img.alt.trim() === '').length }; })()`);
    }
    return { success: true, data: report };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ==================== New Tools ====================

// Keyboard press
export async function keyboardPress(input: unknown): Promise<ToolResult<{ key: string; pressed: boolean }>> {
  try {
    const { key } = input as { key: string };
    if (!key) return { success: false, error: 'key is required' };
    const page = await getBrowserManager().getPage();
    await page.keyboard.press(key);
    return { success: true, data: { key, pressed: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Drag and drop
export async function dragAndDrop(input: unknown): Promise<ToolResult<{ dragged: boolean }>> {
  try {
    const { source, target } = input as { source: string; target: string };
    if (!source || !target) return { success: false, error: 'source and target selectors are required' };
    const page = await getBrowserManager().getPage();
    await page.dragAndDrop(source, target, { timeout: 5000 });
    return { success: true, data: { dragged: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// File upload
export async function fileUpload(input: unknown): Promise<ToolResult<{ uploaded: boolean; filePath: string }>> {
  try {
    const { selector, filePath } = input as { selector: string; filePath: string };
    if (!selector || !filePath) return { success: false, error: 'selector and filePath are required' };
    const page = await getBrowserManager().getPage();
    const fileInput = page.locator(selector);
    await fileInput.setInputFiles(filePath);
    return { success: true, data: { uploaded: true, filePath } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Multi-tab: list tabs
export async function listTabs(): Promise<ToolResult<{ tabs: { index: number; url: string; title: string }[] }>> {
  try {
    const context = await getBrowserManager().getContext();
    const pages = context.pages();
    const tabs = await Promise.all(pages.map(async (p, i) => ({
      index: i,
      url: p.url(),
      title: await p.title().catch(() => '')
    })));
    return { success: true, data: { tabs } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Multi-tab: new tab
export async function newTab(input: unknown): Promise<ToolResult<{ index: number; url: string }>> {
  try {
    const { url } = (input as { url?: string }) ?? {};
    const context = await getBrowserManager().getContext();
    const page = await context.newPage();
    // 新标签页创建后立即设为当前活动页，符合"新建标签页自动获得焦点"的直觉；
    // 放在 goto 之前，这样即便跳转超时，后续操作仍作用于这个新标签页而非旧的。
    getBrowserManager().setActivePage(page);
    if (url) await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
    const pages = context.pages();
    return { success: true, data: { index: pages.indexOf(page), url: page.url() } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Multi-tab: switch tab
export async function switchTab(input: unknown): Promise<ToolResult<{ index: number; url: string; title: string }>> {
  try {
    const { index } = input as { index: number };
    if (index === undefined) return { success: false, error: 'index is required' };
    const context = await getBrowserManager().getContext();
    const pages = context.pages();
    if (index < 0 || index >= pages.length) return { success: false, error: `Tab index ${index} out of range (0-${pages.length - 1})` };
    const page = pages[index]!;
    await page.bringToFront();
    getBrowserManager().setActivePage(page);
    return { success: true, data: { index, url: page.url(), title: await page.title() } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Multi-tab: close tab
export async function closeTab(input: unknown): Promise<ToolResult<{ closed: boolean; remaining: number }>> {
  try {
    const { index } = input as { index: number };
    if (index === undefined) return { success: false, error: 'index is required' };
    const context = await getBrowserManager().getContext();
    const pages = context.pages();
    if (index < 0 || index >= pages.length) return { success: false, error: `Tab index ${index} out of range` };
    if (pages.length <= 1) return { success: false, error: 'Cannot close the last tab' };
    await pages[index]!.close();
    const remaining = context.pages();
    const nextPage = remaining[Math.min(index, remaining.length - 1)];
    if (nextPage) getBrowserManager().setActivePage(nextPage);
    return { success: true, data: { closed: true, remaining: remaining.length } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Network intercept
// 已注册的拦截 handler，按 urlPattern 索引；同一 pattern 重复调用时先 unroute 旧 handler，避免叠加
const interceptHandlers = new Map<string, { regex: RegExp; handler: (route: import('patchright').Route) => void }>();

export async function interceptRequests(input: unknown): Promise<ToolResult<{ intercepting: boolean; urlPattern: string; action: string }>> {
  try {
    const { urlPattern, action } = input as { urlPattern: string; action: string };
    if (!urlPattern || !action) return { success: false, error: 'urlPattern and action are required' };
    const page = await getBrowserManager().getPage();
    // 支持 glob 模式（如 *.css）和正则字符串两种输入
    let regex: RegExp;
    try {
      regex = new RegExp(urlPattern);
    } catch {
      const globToRegex = urlPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      regex = new RegExp(globToRegex);
    }

    const prev = interceptHandlers.get(urlPattern);
    if (prev) {
      await page.unroute(prev.regex, prev.handler).catch(() => {});
      interceptHandlers.delete(urlPattern);
    }

    let handler: (route: import('patchright').Route) => void;
    if (action === 'block') {
      handler = route => route.abort();
    } else if (action === 'log') {
      handler = route => {
        console.log(`[Intercept] ${route.request().method()} ${route.request().url()}`);
        route.continue();
      };
    } else if (action === 'modify') {
      handler = route => route.continue();
    } else {
      return { success: false, error: `Unknown action: ${action}. Use block/log/modify` };
    }
    await page.route(regex, handler);
    interceptHandlers.set(urlPattern, { regex, handler });
    return { success: true, data: { intercepting: true, urlPattern, action } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ============================================================
// 爬虫工具
// ============================================================

/** 广告域名黑名单 */
const AD_DOMAINS = ['doubleclick.net','googlesyndication.com','adservice.google','amazon-adsystem.com','facebook.com/tr','analytics.google','googletagmanager.com','hotjar.com','clarity.ms'];

// 挂在 context 上的当前屏蔽规则 handler；重复调用 set_block_rules 时先 unroute，避免叠加
let activeBlockHandler: ((route: import('patchright').Route) => void) | null = null;

/** 设置请求拦截规则（屏蔽图片/广告，加速爬取）。挂在 context 上，对所有标签页（含后开的）生效 */
export async function setBlockRules(input: unknown): Promise<ToolResult<{ active: boolean; rules: object }>> {
  try {
    const parsed = SetBlockRulesSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { blockImages, blockMedia, blockFonts, blockAds, customPatterns } = parsed.data;
    const context = await getBrowserManager().getContext();

    if (activeBlockHandler) {
      await context.unroute('**/*', activeBlockHandler).catch(() => {});
      activeBlockHandler = null;
    }

    const handler = (route: import('patchright').Route) => {
      const url = route.request().url();
      const resourceType = route.request().resourceType();

      if (blockImages && ['image', 'imageset'].includes(resourceType)) { route.abort(); return; }
      if (blockMedia && ['media', 'websocket'].includes(resourceType)) { route.abort(); return; }
      if (blockFonts && resourceType === 'font') { route.abort(); return; }
      if (blockAds && AD_DOMAINS.some(d => url.includes(d))) { route.abort(); return; }
      if (customPatterns.some(p => url.includes(p))) { route.abort(); return; }
      route.continue();
    };
    await context.route('**/*', handler);
    activeBlockHandler = handler;

    return { success: true, data: { active: true, rules: { blockImages, blockMedia, blockFonts, blockAds, customPatterns } } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 提取页面所有链接 */
export async function extractLinks(input: unknown): Promise<ToolResult<{ links: Array<{ text: string; href: string; title?: string }> }>> {
  try {
    const parsed = ExtractLinksSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { selector, filter, limit } = parsed.data;
    const page = await getBrowserManager().getPage();

    const scope = selector ?? 'body';
    const filterStr = filter ?? '';
    const links = await page.evaluate(`(function() {
      var container = document.querySelector(${JSON.stringify(scope)}) || document.documentElement;
      var anchors = Array.from(container.querySelectorAll('a[href]'));
      var result = [];
      var filter = ${JSON.stringify(filterStr)};
      var limit = ${limit};
      for (var i = 0; i < anchors.length && result.length < limit; i++) {
        var a = anchors[i];
        var href = a.href;
        if (!href || href.startsWith('javascript:') || href === '#') continue;
        if (filter && !href.includes(filter)) continue;
        result.push({ text: (a.textContent || '').trim(), href: href, title: a.title || undefined });
      }
      return result;
    })()`);

    return { success: true, data: { links: links as Array<{ text: string; href: string; title?: string }> } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 提取结构化数据（列表/表格） */
export async function extractData(input: unknown): Promise<ToolResult<{ items: Array<Record<string, string>>; total: number }>> {
  try {
    const parsed = ExtractDataSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { itemSelector, fields, limit } = parsed.data;
    const page = await getBrowserManager().getPage();

    const fieldsJson = JSON.stringify(fields);
    const items = await page.evaluate(`(function() {
      var fields = ${fieldsJson};
      var containers = Array.from(document.querySelectorAll(${JSON.stringify(itemSelector)})).slice(0, ${limit});
      return containers.map(function(container) {
        var item = {};
        fields.forEach(function(field) {
          var el = container.querySelector(field.selector);
          if (!el) { item[field.name] = ''; return; }
          if (field.type === 'html') { item[field.name] = el.innerHTML.trim(); }
          else if (field.type === 'attr' && field.attribute) { item[field.name] = el.getAttribute(field.attribute) || ''; }
          else { item[field.name] = (el.textContent || '').trim(); }
        });
        return item;
      });
    })()`);

    const result = items as Array<Record<string, string>>;
    return { success: true, data: { items: result, total: result.length } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 等待动态内容加载后提取 */
export async function waitAndExtract(input: unknown): Promise<ToolResult<{ items: string[]; total: number }>> {
  try {
    const parsed = WaitAndExtractSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { waitSelector, extractSelector, attribute, timeout } = parsed.data;
    const page = await getBrowserManager().getPage();

    await page.waitForSelector(waitSelector, { timeout, state: 'visible' });

    const attrStr = attribute ?? '';
    const items = await page.evaluate(`(function() {
      var attr = ${JSON.stringify(attrStr)};
      return Array.from(document.querySelectorAll(${JSON.stringify(extractSelector)})).map(function(el) {
        return attr ? (el.getAttribute(attr) || '') : (el.textContent || '').trim();
      }).filter(Boolean);
    })()`);

    const result = items as string[];
    return { success: true, data: { items: result, total: result.length } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 批量抓取多个 URL */
export async function batchFetch(input: unknown): Promise<ToolResult<{ results: Array<{ url: string; title?: string; content?: string; success: boolean; error?: string }> }>> {
  try {
    const parsed = BatchFetchSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { urls, waitFor, extractSelector, delay } = parsed.data;
    const page = await getBrowserManager().getPage();
    const results: Array<{ url: string; title?: string; content?: string; success: boolean; error?: string }> = [];

    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: 'commit', timeout: 15000 });
        if (waitFor) {
          await page.waitForSelector(waitFor, { timeout: 8000, state: 'visible' }).catch(() => {});
        }
        const title = await page.title().catch(() => '');
        let content: string | undefined;
        if (extractSelector) {
          content = await page.evaluate(`(function() {
            var el = document.querySelector(${JSON.stringify(extractSelector)});
            return el ? (el.textContent || '').trim() : '';
          })()`).then(v => v as string).catch(() => undefined);
        }
        results.push({ url, title, content, success: true });
      } catch (err) {
        results.push({ url, success: false, error: err instanceof Error ? err.message : String(err) });
      }
      if (delay > 0 && urls.indexOf(url) < urls.length - 1) {
        await new Promise(r => setTimeout(r, delay));
      }
    }

    return { success: true, data: { results } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 分页爬取 */
export async function crawlPages(input: unknown): Promise<ToolResult<{ items: Array<Record<string, string>>; pages: number; total: number }>> {
  try {
    const parsed = CrawlPagesSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { startUrl, nextPageSelector, itemSelector, fields, maxPages, delay } = parsed.data;
    const page = await getBrowserManager().getPage();
    const allItems: Array<Record<string, string>> = [];
    let pageCount = 0;

    await page.goto(startUrl, { waitUntil: 'commit', timeout: 15000 });

    while (pageCount < maxPages) {
      pageCount++;
      // 提取当前页数据
      const fieldsJson = JSON.stringify(fields);
      const items = await page.evaluate(`(function() {
        var fields = ${fieldsJson};
        return Array.from(document.querySelectorAll(${JSON.stringify(itemSelector)})).map(function(container) {
          var item = {};
          fields.forEach(function(field) {
            var el = container.querySelector(field.selector);
            if (!el) { item[field.name] = ''; return; }
            if (field.type === 'html') { item[field.name] = el.innerHTML.trim(); }
            else if (field.type === 'attr' && field.attribute) { item[field.name] = el.getAttribute(field.attribute) || ''; }
            else { item[field.name] = (el.textContent || '').trim(); }
          });
          return item;
        });
      })()`);

      allItems.push(...(items as Array<Record<string, string>>));

      // 找下一页
      const hasNext = await page.$(nextPageSelector).then(el => !!el).catch(() => false);
      if (!hasNext || pageCount >= maxPages) break;

      try {
        await page.click(nextPageSelector, { force: true, noWaitAfter: true, timeout: 5000 });
        await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
      } catch {
        break;
      }
    }

    return { success: true, data: { items: allItems, pages: pageCount, total: allItems.length } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** ARIA 快照：返回页面无障碍树式大纲，并为可交互元素打上 data-mcp-ref */
export async function snapshot(input: unknown): Promise<ToolResult<{ snapshot: string; refCount: number; truncated: boolean }>> {
  try {
    const parsed = SnapshotSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { interactiveOnly, maxChars, deep } = parsed.data;
    const page = await getBrowserManager().getPage();
    const cap = maxChars ?? 12000;

    const result = await page.evaluate(`(function() {
      var interactiveOnly = ${interactiveOnly};
      var cap = ${cap};
      var INTERACTIVE_ROLES = ['button','link','checkbox','menuitem','tab','switch','radio','option','treeitem'];
      var lines = [];
      var refCount = 0;
      var truncated = false;
      var totalLen = 0;

      function isVisible(el) {
        if (!(el instanceof Element)) return false;
        var style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) return false;
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
      function isInteractive(el) {
        var tag = el.tagName.toLowerCase();
        if (['a','button','input','select','textarea'].indexOf(tag) !== -1) return true;
        var role = el.getAttribute('role');
        if (role && INTERACTIVE_ROLES.indexOf(role) !== -1) return true;
        if (el.hasAttribute('onclick')) return true;
        // 框架无语义可点击元素：cursor:pointer / tabindex>=0
        try {
          if (window.getComputedStyle(el).cursor === 'pointer') return true;
        } catch (e) { /* noop */ }
        if (el.hasAttribute('tabindex')) {
          var ti = parseInt(el.getAttribute('tabindex'), 10);
          if (!isNaN(ti) && ti >= 0) return true;
        }
        return false;
      }
      function roleOf(el) {
        var role = el.getAttribute('role');
        if (role) return role;
        var tag = el.tagName.toLowerCase();
        if (tag === 'a') return 'link';
        if (tag === 'button') return 'button';
        if (tag === 'select') return 'combobox';
        if (tag === 'textarea') return 'textbox';
        if (tag === 'input') {
          var t = (el.getAttribute('type') || 'text').toLowerCase();
          if (t === 'checkbox') return 'checkbox';
          if (t === 'radio') return 'radio';
          if (t === 'submit' || t === 'button') return 'button';
          return 'textbox';
        }
        if (/^h[1-6]$/.test(tag)) return 'heading';
        return '';
      }
      function nameOf(el) {
        var n = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt') || '';
        if (!n) {
          if (el.tagName.toLowerCase() === 'input' && el.value) n = el.value;
          else n = (el.textContent || '').replace(/\\s+/g, ' ').trim();
        }
        if (n.length > 80) n = n.slice(0, 80) + '…';
        return n.replace(/"/g, "'");
      }
      function emit(depth, txt) {
        if (totalLen >= cap) { truncated = true; return; }
        var line = new Array(depth + 1).join('  ') + txt;
        lines.push(line);
        totalLen += line.length + 1;
      }
      function walk(node, depth) {
        if (truncated || depth > 25) return;
        for (var i = 0; i < node.children.length; i++) {
          if (truncated) return;
          var el = node.children[i];
          var tag = el.tagName.toLowerCase();
          if (['script','style','noscript','svg','head','meta','link'].indexOf(tag) !== -1) continue;
          if (!isVisible(el)) continue;
          var meaningful = isInteractive(el) || /^h[1-6]$/.test(tag) || el.hasAttribute('role');
          var role = roleOf(el);
          if (meaningful && role) {
            var refStr = '';
            if (isInteractive(el)) {
              refCount++;
              var ref = 'e' + refCount;
              el.setAttribute('data-mcp-ref', ref);
              refStr = ' [ref=' + ref + ']';
            }
            if (!interactiveOnly || isInteractive(el)) {
              emit(depth, role + ' "' + nameOf(el) + '"' + refStr);
            }
            walk(el, depth + 1);
          } else if (!interactiveOnly) {
            // 叶子可见文本节点
            var ownText = '';
            for (var j = 0; j < el.childNodes.length; j++) {
              var cn = el.childNodes[j];
              if (cn.nodeType === 3) ownText += cn.textContent;
            }
            ownText = ownText.replace(/\\s+/g, ' ').trim();
            if (ownText && el.children.length === 0) {
              if (ownText.length > 120) ownText = ownText.slice(0, 120) + '…';
              emit(depth, 'text "' + ownText.replace(/"/g, "'") + '"');
            } else {
              walk(el, depth);
            }
          } else {
            walk(el, depth);
          }
        }
      }
      // 清除上一次快照的 ref 标记
      var prev = document.querySelectorAll('[data-mcp-ref]');
      for (var k = 0; k < prev.length; k++) prev[k].removeAttribute('data-mcp-ref');
      walk(document.body, 0);
      return { snapshot: lines.join('\\n'), refCount: refCount, truncated: truncated };
    })()`);

    const r = result as { snapshot: string; refCount: number; truncated: boolean };
    let deepLines: string[] = [];
    let deepRefCount = 0;

    // 深度 CDP 扫描：找出仅通过 addEventListener 绑定 click/mousedown 的元素
    if (deep) {
      try {
        const session = await page.context().newCDPSession(page);
        const deadline = Date.now() + 4000; // 整体上限 4 秒
        const CAND_QUERY = 'div,span,li,td,th,section,article,header,footer,nav,p,img,svg,a';
        try {
          // 把候选元素挂到一个全局数组，后续按下标用 CDP 取 objectId
          const candCount = await page.evaluate(`(function() {
            window.__mcpDeepCands = [];
            var els = document.querySelectorAll(${JSON.stringify(CAND_QUERY)});
            for (var i = 0; i < els.length && window.__mcpDeepCands.length < 400; i++) {
              var el = els[i];
              if (el.hasAttribute('data-mcp-ref')) continue;
              var style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
              var rect = el.getBoundingClientRect();
              if (rect.width < 8 || rect.height < 8 || rect.width > 1600 || rect.height > 900) continue;
              window.__mcpDeepCands.push(el);
            }
            return window.__mcpDeepCands.length;
          })()`) as number;

          for (let idx = 0; idx < candCount; idx++) {
            if (Date.now() > deadline) break;
            try {
              // 通过 CDP Runtime.evaluate 直接拿到该元素的 objectId
              const evalRes = await session.send('Runtime.evaluate', {
                expression: `window.__mcpDeepCands[${idx}]`,
                returnByValue: false,
              }).catch(() => null) as { result?: { objectId?: string } } | null;
              const objId = evalRes?.result?.objectId;
              if (!objId) continue;
              const listeners = await session.send('DOMDebugger.getEventListeners', { objectId: objId })
                .catch(() => null) as { listeners?: Array<{ type: string }> } | null;
              await session.send('Runtime.releaseObject', { objectId: objId }).catch(() => {});
              if (listeners?.listeners?.some(l => l.type === 'click' || l.type === 'mousedown')) {
                deepRefCount++;
                const ref = 'd' + deepRefCount;
                const label = await page.evaluate(`(function() {
                  var el = window.__mcpDeepCands[${idx}];
                  if (!el || el.hasAttribute('data-mcp-ref')) return null;
                  el.setAttribute('data-mcp-ref', '${ref}');
                  var n = el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').replace(/\\s+/g,' ').trim();
                  return n.slice(0, 80);
                })()`).catch(() => '') as string | null;
                if (label === null) { deepRefCount--; continue; }
                deepLines.push('clickable "' + String(label).replace(/"/g, "'") + '" [ref=' + ref + ']');
              }
            } catch (e) { /* 单个元素失败忽略 */ }
          }
        } finally {
          await page.evaluate('delete window.__mcpDeepCands').catch(() => {});
          await session.detach().catch(() => {});
        }
      } catch (e) {
        // CDP 路径任何异常都优雅降级，不影响快照主结果
        deepLines = [];
      }
    }

    let snap = r.truncated ? r.snapshot + '\n\n[... 已截断，可调大 maxChars 或设置 interactiveOnly:true]' : r.snapshot;
    if (deepLines.length > 0) {
      snap += '\n\n[深度扫描发现 ' + deepLines.length + ' 个事件监听可点击元素]\n' + deepLines.join('\n');
    }
    return { success: true, data: { snapshot: snap, refCount: r.refCount + deepRefCount, truncated: r.truncated } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 提取页面主正文为干净的 Markdown（剥离导航/广告/样板） */
export async function extractArticle(input: unknown): Promise<ToolResult<{
  title: string; byline: string | null; excerpt: string | null;
  length: number; markdown: string; textPreview: string;
}>> {
  try {
    const parsed = ExtractArticleSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { url } = parsed.data;
    const page = await getBrowserManager().getPage();
    if (url) {
      await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
      // commit 阶段 DOM 还没解析完，直接 content() 会拿到半成品页面
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    }

    const html = await page.content();
    const pageUrl = page.url();

    // 首选 defuddle（Readability 的现代替代：多轮清洗、脚注/代码块标准化、直接出 Markdown）
    try {
      const dom = new JSDOM(html, { url: pageUrl });
      const result = await Defuddle(dom, pageUrl, { markdown: true });
      if (result.content && result.wordCount > 0) {
        const text = result.content.replace(/\s+/g, ' ').trim();
        return {
          success: true,
          data: {
            title: result.title ?? '',
            byline: result.author || null,
            excerpt: result.description || null,
            length: result.wordCount,
            markdown: result.content,
            textPreview: text.slice(0, 300),
          },
        };
      }
    } catch { /* defuddle 失败则回退 Readability */ }

    // 兜底：Readability + Turndown
    const dom = new JSDOM(html, { url: pageUrl });
    const article = new Readability(dom.window.document).parse();
    if (!article || !article.content) {
      return { success: false, error: '该页面不是文章，或无法提取主正文（defuddle 与 Readability 均返回空）' };
    }
    const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
    const markdown = turndown.turndown(article.content);
    const text = (article.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      success: true,
      data: {
        title: article.title ?? '',
        byline: article.byline ?? null,
        excerpt: article.excerpt ?? null,
        length: article.length ?? markdown.length,
        markdown,
        textPreview: text.slice(0, 300),
      },
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 站点 URL 发现：走 sitemap.xml + robots.txt + 页面链接，快速探明站点页面地址 */
export async function discoverUrls(input: unknown): Promise<ToolResult<{
  urls: string[]; total: number; fromSitemap: number; fromLinks: number; truncated: boolean;
}>> {
  try {
    const parsed = DiscoverUrlsSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { url, maxUrls, sameDomainOnly, includeSitemap } = parsed.data;
    const page = await getBrowserManager().getPage();
    const request = page.context().request;

    const rootOrigin = new URL(url).origin;
    const rootHost = new URL(url).hostname;
    const sitemapUrls = new Set<string>();
    const linkUrls = new Set<string>();

    /** 抓取文本，8 秒超时，失败返回空 */
    const fetchText = async (target: string): Promise<string> => {
      try {
        const resp = await request.get(target, { timeout: 8000, failOnStatusCode: false });
        if (!resp.ok()) return '';
        return await resp.text();
      } catch {
        return '';
      }
    };

    /** 解析 sitemap XML 中的 <loc> */
    const parseLocs = (xml: string): string[] => {
      const out: string[] = [];
      const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(xml)) !== null) {
        if (m[1]) out.push(m[1].trim());
      }
      return out;
    };

    if (includeSitemap) {
      let sitemapFetches = 0;
      const sitemapQueue: string[] = [];

      // robots.txt 中的 Sitemap: 行
      const robots = await fetchText(`${rootOrigin}/robots.txt`);
      if (robots) {
        for (const line of robots.split(/\r?\n/)) {
          const m = line.match(/^\s*sitemap:\s*(\S+)/i);
          if (m && m[1]) sitemapQueue.push(m[1].trim());
        }
      }
      // 默认 sitemap.xml
      sitemapQueue.push(`${rootOrigin}/sitemap.xml`);

      // 至多抓取 ~5 个 sitemap，支持 sitemap-index 下钻一层
      while (sitemapQueue.length > 0 && sitemapFetches < 5) {
        const sm = sitemapQueue.shift()!;
        sitemapFetches++;
        const xml = await fetchText(sm);
        if (!xml) continue;
        const locs = parseLocs(xml);
        // sitemap-index：<loc> 指向其它 .xml sitemap
        const childSitemaps = locs.filter(l => /\.xml(\?|$)/i.test(l));
        const isIndex = /<sitemapindex/i.test(xml) || (childSitemaps.length > 0 && childSitemaps.length === locs.length);
        if (isIndex) {
          for (const child of childSitemaps) {
            if (sitemapFetches + sitemapQueue.length < 5) sitemapQueue.push(child);
          }
        } else {
          for (const l of locs) sitemapUrls.add(l);
        }
      }
    }

    // 当前页面的 <a href>
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 8000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
      const hrefs = await page.evaluate(`Array.from(document.querySelectorAll('a[href]')).map(function(a){ return a.href; })`) as string[];
      for (const h of hrefs) linkUrls.add(h);
    } catch { /* 页面抓取失败不影响 sitemap 结果 */ }

    // 合并、去重、过滤
    const isHttp = (u: string) => /^https?:\/\//i.test(u);
    const seen = new Set<string>();
    const merged: string[] = [];
    let fromSitemap = 0;
    let fromLinks = 0;
    for (const [src, set] of [['sitemap', sitemapUrls], ['links', linkUrls]] as const) {
      for (const raw of set) {
        if (!isHttp(raw)) continue;
        let host: string;
        try { host = new URL(raw).hostname; } catch { continue; }
        if (sameDomainOnly && host !== rootHost) continue;
        if (seen.has(raw)) continue;
        seen.add(raw);
        merged.push(raw);
        if (src === 'sitemap') fromSitemap++; else fromLinks++;
      }
    }

    const truncated = merged.length > maxUrls;
    const urls = merged.slice(0, maxUrls);
    return { success: true, data: { urls, total: urls.length, fromSitemap, fromLinks, truncated } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
