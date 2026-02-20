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
  PageReportSchema, SetViewportSchema
} from './schemas.js';
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

export async function click(input: unknown): Promise<ToolResult<ClickResult>> {
  try {
    const parsed = ClickSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { selector } = parsed.data;
    const page = await getBrowserManager().getPage();
    await page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
    await page.click(selector, { timeout: 3000 });
    return { success: true, data: { selector, clicked: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function type(input: unknown): Promise<ToolResult<TypeResult>> {
  try {
    const parsed = TypeSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { selector, text } = parsed.data;
    const page = await getBrowserManager().getPage();
    await page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
    await page.fill(selector, text, { timeout: 3000 });
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
    const buffer = await page.screenshot({ path: filePath, fullPage, timeout: 30000, animations: 'disabled', scale: 'css' });
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
    const result = await page.evaluate(script);
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
    const { selector } = parsed.data;
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
    const regex = new RegExp(urlPattern);

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

export const toolRegistry = {
  navigate: { name: 'navigate', description: '跳转至指定网址', inputSchema: { type: 'object', properties: { url: { type: 'string', description: '要跳转的 URL' } }, required: ['url'] }, handler: navigate },
  click: { name: 'click', description: '点击页面元素', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' } }, required: ['selector'] }, handler: click },
  type: { name: 'type', description: '在输入框中输入文本', inputSchema: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器' }, text: { type: 'string', description: '要输入的文本' } }, required: ['selector', 'text'] }, handler: type },
  take_screenshot: { name: 'take_screenshot', description: '截取当前页面截图', inputSchema: { type: 'object', properties: { name: { type: 'string', description: '截图文件名' }, fullPage: { type: 'boolean', description: '是否全屏截图' } } }, handler: takeScreenshot },
  get_console_logs: { name: 'get_console_logs', description: '获取页面 console 输出', inputSchema: { type: 'object', properties: {} }, handler: getConsoleLogs },
  get_network: { name: 'get_network', description: '获取网络请求状态', inputSchema: { type: 'object', properties: {} }, handler: getNetwork },
  execute_js: { name: 'execute_js', description: '执行自定义 JavaScript', inputSchema: { type: 'object', properties: { script: { type: 'string', description: 'JavaScript 代码' } }, required: ['script'] }, handler: executeJs }
} as const;

export type ToolName = keyof typeof toolRegistry;
