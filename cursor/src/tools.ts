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

export async function takeScreenshot(input: unknown): Promise<ToolResult<ScreenshotResult>> {
  try {
    const parsed = ScreenshotSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const { name, fullPage } = parsed.data;
    const page = await getBrowserManager().getPage();
    const screenshotDir = ensureScreenshotDir();
    const fileName = name ?? `screenshot-${Date.now()}`;
    const filePath = path.join(screenshotDir, `${fileName}.png`);
    await page.screenshot({ path: filePath, fullPage, timeout: 30000, animations: 'disabled', scale: 'css' });
    return { success: true, data: { path: filePath, fullPage } };
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
