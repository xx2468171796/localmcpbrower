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
  SnapshotSchema, ExtractArticleSchema
} from './schemas.js';
import { Readability } from '@mozilla/readability';
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
    const title = await page.title();
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
function resolveTarget(selector?: string, ref?: string): { ok: true; selector: string } | { ok: false; error: string } {
  if (ref) return { ok: true, selector: `[data-mcp-ref="${ref}"]` };
  if (selector) return { ok: true, selector };
  return { ok: false, error: 'selector 与 ref 必须提供其一' };
}

export async function click(input: unknown): Promise<ToolResult<ClickResult>> {
  try {
    const parsed = ClickSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const target = resolveTarget(parsed.data.selector, parsed.data.ref);
    if (!target.ok) return { success: false, error: target.error };
    const selector = target.selector;
    const page = await getBrowserManager().getPage();
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
          var el = document.querySelector('${selector.replace(/'/g, "\\'")}');
          if (el) el.click();
          else throw new Error('元素未找到: ${selector.replace(/'/g, "\\'")}');
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
        const escapedSelector = selector.replace(/'/g, "\\'");
        const escapedText = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        await page.evaluate(`(function() {
          var el = document.querySelector('${escapedSelector}');
          if (!el) throw new Error('元素未找到: ${escapedSelector}');
          el.value = '${escapedText}';
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

export async function takeScreenshot(input: unknown): Promise<ToolResult<ScreenshotResult & { base64?: string }>> {
  try {
    const parsed = ScreenshotSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { name, fullPage } = parsed.data;
    const page = await getBrowserManager().getPage();
    const screenshotDir = ensureScreenshotDir();
    const fileName = name ?? `screenshot-${Date.now()}`;
    const filePath = path.join(screenshotDir, `${fileName}.png`);

    // 先等待页面稳定（最多 2 秒），忽略超时
    await page.evaluate('document.fonts && document.fonts.ready').catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 500));

    let buffer: Buffer;
    try {
      // 第一次尝试：正常截图，10 秒超时
      buffer = await page.screenshot({ path: filePath, fullPage, timeout: 10000, animations: 'disabled', scale: 'css' });
    } catch {
      // 第二次尝试：不等待字体，缩小视口截图
      buffer = await page.screenshot({ path: filePath, fullPage: false, timeout: 10000, animations: 'disabled', scale: 'css' });
    }
    const base64 = buffer.toString('base64');
    return { success: true, data: { path: filePath, fullPage, base64 } };
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
    const wrappedScript = script.trimStart().startsWith('return ') ? `(() => { ${script} })()` : script;
    const result = await page.evaluate(wrappedScript);
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

    if (action === 'block') {
      await page.route(regex, route => route.abort());
    } else if (action === 'log') {
      await page.route(regex, route => {
        console.log(`[Intercept] ${route.request().method()} ${route.request().url()}`);
        route.continue();
      });
    } else if (action === 'modify') {
      await page.route(regex, route => route.continue());
    } else {
      return { success: false, error: `Unknown action: ${action}. Use block/log/modify` };
    }
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

/** 全局请求拦截状态 */
let blockRulesActive = false;

/** 设置请求拦截规则（屏蔽图片/广告，加速爬取） */
export async function setBlockRules(input: unknown): Promise<ToolResult<{ active: boolean; rules: object }>> {
  try {
    const parsed = SetBlockRulesSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { blockImages, blockMedia, blockFonts, blockAds, customPatterns } = parsed.data;
    const page = await getBrowserManager().getPage();

    await page.route('**/*', (route) => {
      const url = route.request().url();
      const resourceType = route.request().resourceType();

      if (blockImages && ['image', 'imageset'].includes(resourceType)) { route.abort(); return; }
      if (blockMedia && ['media', 'websocket'].includes(resourceType)) { route.abort(); return; }
      if (blockFonts && resourceType === 'font') { route.abort(); return; }
      if (blockAds && AD_DOMAINS.some(d => url.includes(d))) { route.abort(); return; }
      if (customPatterns.some(p => url.includes(p))) { route.abort(); return; }
      route.continue();
    });

    blockRulesActive = true;
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
      var container = document.querySelector('${scope.replace(/'/g, "\\'")}') || document.documentElement;
      var anchors = Array.from(container.querySelectorAll('a[href]'));
      var result = [];
      var filter = '${filterStr.replace(/'/g, "\\'")}';
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
      var attr = '${attrStr.replace(/'/g, "\\'")}';
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
    const { interactiveOnly, maxChars } = parsed.data;
    const page = await getBrowserManager().getPage();
    const cap = maxChars ?? 12000;

    const result = await page.evaluate(`(function() {
      var interactiveOnly = ${interactiveOnly};
      var cap = ${cap};
      var INTERACTIVE_ROLES = ['button','link','checkbox','menuitem','tab','switch'];
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
    const snap = r.truncated ? r.snapshot + '\n\n[... 已截断，可调大 maxChars 或设置 interactiveOnly:true]' : r.snapshot;
    return { success: true, data: { snapshot: snap, refCount: r.refCount, truncated: r.truncated } };
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
    if (url) await page.goto(url, { waitUntil: 'commit', timeout: 30000 });

    const html = await page.content();
    const pageUrl = page.url();
    const dom = new JSDOM(html, { url: pageUrl });
    const article = new Readability(dom.window.document).parse();
    if (!article || !article.content) {
      return { success: false, error: '该页面不是文章，或无法提取主正文（Readability 返回空）' };
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

export const toolRegistry = {
  // ============================================================
  // 基础操作
  // ============================================================
  navigate: { name: 'navigate', description: '跳转至指定网址', inputSchema: { type: 'object', properties: { url: { type: 'string', description: '要跳转的 URL' } }, required: ['url'] }, handler: navigate },
  click: { name: 'click', description: '点击页面元素（自动 fallback: 正常→force→JS）', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' } }, required: ['selector'] }, handler: click },
  type: { name: 'type', description: '在输入框输入文本（自动 fallback: 正常→force→JS）', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' }, text: { type: 'string', description: '要输入的文本' } }, required: ['selector', 'text'] }, handler: type },
  hover: { name: 'hover', description: '鼠标悬停到元素上', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' } }, required: ['selector'] }, handler: hover },
  scroll: { name: 'scroll', description: '滚动页面（x/y 坐标或滚动到指定元素）', inputSchema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, selector: { type: 'string' } } }, handler: scroll },
  keyboard_press: { name: 'keyboard_press', description: '按下键盘按键（如 Enter/Tab/Escape）', inputSchema: { type: 'object', properties: { key: { type: 'string', description: '按键名称，如 Enter/Tab/Escape/ArrowDown' } }, required: ['key'] }, handler: keyboardPress },
  drag_and_drop: { name: 'drag_and_drop', description: '拖拽元素', inputSchema: { type: 'object', properties: { source: { type: 'string', description: '源元素 CSS 选择器' }, target: { type: 'string', description: '目标元素 CSS 选择器' } }, required: ['source', 'target'] }, handler: dragAndDrop },
  select_option: { name: 'select_option', description: '选择下拉框选项', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] }, handler: selectOption },
  fill_form: { name: 'fill_form', description: '批量填写表单（一次填多个字段）', inputSchema: { type: 'object', properties: { fields: { type: 'array', items: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] } } }, required: ['fields'] }, handler: fillForm },
  file_upload: { name: 'file_upload', description: '上传文件', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, filePath: { type: 'string' } }, required: ['selector', 'filePath'] }, handler: fileUpload },
  wait_for_selector: { name: 'wait_for_selector', description: '等待元素出现/消失（适合动态页面）', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, state: { type: 'string', enum: ['visible','hidden','attached','detached'], default: 'visible' }, timeout: { type: 'number', default: 10000 } }, required: ['selector'] }, handler: waitForSelector },
  go_back: { name: 'go_back', description: '浏览器后退', inputSchema: { type: 'object', properties: {} }, handler: goBack },
  go_forward: { name: 'go_forward', description: '浏览器前进', inputSchema: { type: 'object', properties: {} }, handler: goForward },
  set_viewport: { name: 'set_viewport', description: '设置浏览器视口大小', inputSchema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } }, required: ['width', 'height'] }, handler: setViewport },
  // ============================================================
  // 数据提取
  // ============================================================
  get_page_content: { name: 'get_page_content', description: '获取页面完整 HTML 内容', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: '可选，只获取指定元素的内容' } } }, handler: getPageContent },
  get_element_text: { name: 'get_element_text', description: '获取元素文本内容', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] }, handler: getElementText },
  get_element_attribute: { name: 'get_element_attribute', description: '获取元素属性值（如 href/src/value）', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, attribute: { type: 'string' } }, required: ['selector', 'attribute'] }, handler: getElementAttribute },
  get_cookies: { name: 'get_cookies', description: '获取当前页面 cookies', inputSchema: { type: 'object', properties: { name: { type: 'string', description: '可选，指定 cookie 名称' } } }, handler: getCookies },
  set_cookies: { name: 'set_cookies', description: '设置 cookies', inputSchema: { type: 'object', properties: { cookies: { type: 'array', items: { type: 'object' } } }, required: ['cookies'] }, handler: setCookies },
  get_console_logs: { name: 'get_console_logs', description: '获取页面 console 输出', inputSchema: { type: 'object', properties: {} }, handler: getConsoleLogs },
  get_network: { name: 'get_network', description: '获取网络请求记录', inputSchema: { type: 'object', properties: {} }, handler: getNetwork },
  execute_js: { name: 'execute_js', description: '执行自定义 JavaScript 并返回结果', inputSchema: { type: 'object', properties: { script: { type: 'string', description: 'JavaScript 代码（支持 return 语句）' } }, required: ['script'] }, handler: executeJs },
  generate_page_report: { name: 'generate_page_report', description: '生成页面结构分析报告（链接/图片/表单统计）', inputSchema: { type: 'object', properties: {} }, handler: generatePageReport },
  // ============================================================
  // 截图 & 导出
  // ============================================================
  take_screenshot: { name: 'take_screenshot', description: '截取当前页面截图（返回 base64 图片）', inputSchema: { type: 'object', properties: { name: { type: 'string', description: '截图文件名（不含扩展名）' }, fullPage: { type: 'boolean', description: '是否截全页，默认 false' } } }, handler: takeScreenshot },
  pdf_export: { name: 'pdf_export', description: '将页面导出为 PDF', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '保存路径' }, fullPage: { type: 'boolean', default: true } }, required: ['path'] }, handler: pdfExport },
  intercept_requests: { name: 'intercept_requests', description: '拦截并修改网络请求', inputSchema: { type: 'object', properties: { urlPattern: { type: 'string' }, action: { type: 'string', enum: ['block','log','modify'], default: 'log' } }, required: ['urlPattern'] }, handler: interceptRequests },
  // ============================================================
  // 多标签页管理
  // ============================================================
  list_tabs: { name: 'list_tabs', description: '列出所有打开的标签页', inputSchema: { type: 'object', properties: {} }, handler: listTabs },
  new_tab: { name: 'new_tab', description: '打开新标签页', inputSchema: { type: 'object', properties: { url: { type: 'string', description: '可选，新标签页要打开的 URL' } } }, handler: newTab },
  switch_tab: { name: 'switch_tab', description: '切换到指定标签页', inputSchema: { type: 'object', properties: { index: { type: 'number', description: '标签页索引（从 0 开始）' } }, required: ['index'] }, handler: switchTab },
  close_tab: { name: 'close_tab', description: '关闭指定标签页', inputSchema: { type: 'object', properties: { index: { type: 'number', description: '标签页索引（从 0 开始）' } }, required: ['index'] }, handler: closeTab },
  // ============================================================
  // 爬虫工具（高性能批量采集）
  // ============================================================
  set_block_rules: { name: 'set_block_rules', description: '【爬虫加速】屏蔽图片/广告/字体请求，爬取速度提升 3-5 倍。爬虫任务开始前必须先调用此工具', inputSchema: { type: 'object', properties: { blockImages: { type: 'boolean', default: true }, blockMedia: { type: 'boolean', default: true }, blockFonts: { type: 'boolean', default: true }, blockAds: { type: 'boolean', default: true }, customPatterns: { type: 'array', items: { type: 'string' }, default: [] } } }, handler: setBlockRules },
  extract_links: { name: 'extract_links', description: '【爬虫】提取页面所有链接，支持 CSS 范围限定和 URL 关键词过滤', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: '限定范围的 CSS 选择器，如 .article-list' }, filter: { type: 'string', description: 'URL 过滤关键词，如 /product/' }, limit: { type: 'number', default: 100 } } }, handler: extractLinks },
  extract_data: { name: 'extract_data', description: '【爬虫】按 CSS 选择器批量提取结构化数据（列表/表格），支持多字段映射', inputSchema: { type: 'object', properties: { itemSelector: { type: 'string', description: '每条数据的容器选择器，如 .product-item' }, fields: { type: 'array', items: { type: 'object', properties: { name: { type: 'string', description: '字段名' }, selector: { type: 'string', description: '相对于 item 的子选择器' }, attribute: { type: 'string', description: '提取属性，如 href/src' }, type: { type: 'string', enum: ['text','html','attr'], default: 'text' } }, required: ['name','selector'] } }, limit: { type: 'number', default: 200 } }, required: ['itemSelector','fields'] }, handler: extractData },
  wait_and_extract: { name: 'wait_and_extract', description: '【爬虫】等待动态内容加载后提取，适合 SPA/懒加载/Ajax 页面', inputSchema: { type: 'object', properties: { waitSelector: { type: 'string', description: '等待此元素出现后再提取' }, extractSelector: { type: 'string', description: '要提取内容的选择器' }, attribute: { type: 'string', description: '提取属性，不填则取文本' }, timeout: { type: 'number', default: 10000 } }, required: ['waitSelector','extractSelector'] }, handler: waitAndExtract },
  batch_fetch: { name: 'batch_fetch', description: '【爬虫】批量抓取多个 URL（最多20个），支持内容提取和请求间隔控制', inputSchema: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' }, description: 'URL 列表，最多20个' }, waitFor: { type: 'string', description: '每页等待此选择器出现' }, extractSelector: { type: 'string', description: '提取内容的选择器' }, delay: { type: 'number', default: 500, description: '每次请求间隔(ms)，防封号' } }, required: ['urls'] }, handler: batchFetch },
  crawl_pages: { name: 'crawl_pages', description: '【爬虫】自动分页爬取，自动点击下一页并汇总所有数据，适合商品列表/新闻列表等', inputSchema: { type: 'object', properties: { startUrl: { type: 'string', description: '起始 URL' }, nextPageSelector: { type: 'string', description: '下一页按钮的 CSS 选择器' }, itemSelector: { type: 'string', description: '每条数据的容器选择器' }, fields: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, selector: { type: 'string' }, attribute: { type: 'string' }, type: { type: 'string', enum: ['text','html','attr'], default: 'text' } }, required: ['name','selector'] } }, maxPages: { type: 'number', default: 5, description: '最多爬取页数' }, delay: { type: 'number', default: 800, description: '翻页间隔(ms)' } }, required: ['startUrl','nextPageSelector','itemSelector','fields'] }, handler: crawlPages }
} as const;

export type ToolName = keyof typeof toolRegistry;
