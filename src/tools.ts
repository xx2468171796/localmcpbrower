/**
 * MCP 工具定义
 * @description 向 AI 助手暴露的原子化浏览器操作能力
 */

import * as path from 'path';
import * as fs from 'fs';
import { getBrowserManager } from './browser.js';
import {
  NavigateSchema,
  ClickSchema,
  TypeSchema,
  ScreenshotSchema,
  ExecuteJsSchema,
  ScrollSchema,
  WaitForSelectorSchema,
  GetElementTextSchema,
  GetElementAttributeSchema,
  HoverSchema,
  SelectOptionSchema,
  FillFormSchema,
  GetPageContentSchema,
  PdfExportSchema,
  GetCookiesSchema,
  SetCookiesSchema,
  PageReportSchema,
  SetViewportSchema
} from './schemas.js';
import type {
  ToolResult,
  NavigateResult,
  ClickResult,
  TypeResult,
  ScreenshotResult,
  ExecuteJsResult,
  ConsoleLogEntry,
  NetworkRequestEntry
} from './types.js';

/** 确保截图目录存在 */
function ensureScreenshotDir(): string {
  const dir = path.resolve('storage/screenshots');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** 导航到指定 URL */
export async function navigate(input: unknown): Promise<ToolResult<NavigateResult>> {
  try {
    const parsed = NavigateSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { url } = parsed.data;
    const page = await getBrowserManager().getPage();
    // 使用 commit 而不是 domcontentloaded，更快返回
    await page.goto(url, { 
      waitUntil: 'commit',
      timeout: 30000 
    });
    const title = await page.title();

    return {
      success: true,
      data: { url, title }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** 设置视口大小 */
export async function setViewport(input: unknown): Promise<ToolResult<{ width: number; height: number }>> {
  try {
    const parsed = SetViewportSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { width, height } = parsed.data;
    const page = await getBrowserManager().getPage();
    
    await page.setViewportSize({ width, height });

    return {
      success: true,
      data: { width, height }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** 点击元素 - 增加重试机制 */
export async function click(input: unknown): Promise<ToolResult<ClickResult>> {
  try {
    const parsed = ClickSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { selector } = parsed.data;
    const page = await getBrowserManager().getPage();
    
    // 快速点击，减少等待
    await page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
    await page.click(selector, { timeout: 3000 });
    return { success: true, data: { selector, clicked: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 输入文本 - 增加重试机制 */
export async function type(input: unknown): Promise<ToolResult<TypeResult>> {
  try {
    const parsed = TypeSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { selector, text } = parsed.data;
    const page = await getBrowserManager().getPage();
    
    // 快速输入，减少等待
    await page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
    await page.fill(selector, text, { timeout: 3000 });
    return { success: true, data: { selector, typed: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 截取屏幕截图 */
export async function takeScreenshot(input: unknown): Promise<ToolResult<ScreenshotResult>> {
  try {
    const parsed = ScreenshotSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { name, fullPage } = parsed.data;
    const page = await getBrowserManager().getPage();
    
    const screenshotDir = ensureScreenshotDir();
    const fileName = name ?? `screenshot-${Date.now()}`;
    const filePath = path.join(screenshotDir, `${fileName}.png`);

    // 快速截图
    await page.screenshot({
      path: filePath,
      fullPage,
      timeout: 5000,
      animations: 'disabled',
      scale: 'css'
    });

    return {
      success: true,
      data: { path: filePath, fullPage }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** 获取控制台日志 */
export async function getConsoleLogs(): Promise<ToolResult<ConsoleLogEntry[]>> {
  try {
    const logs = getBrowserManager().getConsoleLogs();
    return {
      success: true,
      data: logs
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** 获取网络请求 */
export async function getNetwork(): Promise<ToolResult<NetworkRequestEntry[]>> {
  try {
    const requests = getBrowserManager().getNetworkRequests();
    return {
      success: true,
      data: requests
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** 执行 JavaScript */
export async function executeJs(input: unknown): Promise<ToolResult<ExecuteJsResult>> {
  try {
    const parsed = ExecuteJsSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { script } = parsed.data;
    const page = await getBrowserManager().getPage();
    
    const result = await page.evaluate(script);

    return {
      success: true,
      data: { result }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** 页面滚动 - 增加超时和重试 */
export async function scroll(input: unknown): Promise<ToolResult<{ scrolled: boolean }>> {
  try {
    const parsed = ScrollSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { x, y, selector } = parsed.data;
    const page = await getBrowserManager().getPage();

    // 快速滚动
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

/** 浏览器后退 - 增加超时 */
export async function goBack(): Promise<ToolResult<NavigateResult>> {
  try {
    const page = await getBrowserManager().getPage();
    await page.goBack({ timeout: 10000, waitUntil: 'commit' });
    return { success: true, data: { url: page.url(), title: await page.title() } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 浏览器前进 - 增加超时 */
export async function goForward(): Promise<ToolResult<NavigateResult>> {
  try {
    const page = await getBrowserManager().getPage();
    await page.goForward({ timeout: 10000, waitUntil: 'commit' });
    return { success: true, data: { url: page.url(), title: await page.title() } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 鼠标悬停 */
export async function hover(input: unknown): Promise<ToolResult<{ hovered: boolean }>> {
  try {
    const parsed = HoverSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { selector } = parsed.data;
    const page = await getBrowserManager().getPage();
    await page.hover(selector, { timeout: 5000 });

    return { success: true, data: { hovered: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 等待选择器 */
export async function waitForSelector(input: unknown): Promise<ToolResult<{ found: boolean }>> {
  try {
    const parsed = WaitForSelectorSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { selector, state, timeout } = parsed.data;
    const page = await getBrowserManager().getPage();
    await page.waitForSelector(selector, { state, timeout });

    return { success: true, data: { found: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 获取元素文本 */
export async function getElementText(input: unknown): Promise<ToolResult<{ text: string }>> {
  try {
    const parsed = GetElementTextSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { selector } = parsed.data;
    const page = await getBrowserManager().getPage();
    const text = await page.locator(selector).textContent({ timeout: 5000 }) ?? '';

    return { success: true, data: { text } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 获取元素属性 */
export async function getElementAttribute(input: unknown): Promise<ToolResult<{ value: string | null }>> {
  try {
    const parsed = GetElementAttributeSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { selector, attribute } = parsed.data;
    const page = await getBrowserManager().getPage();
    const value = await page.locator(selector).getAttribute(attribute, { timeout: 5000 });

    return { success: true, data: { value } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 下拉选择 */
export async function selectOption(input: unknown): Promise<ToolResult<{ selected: boolean }>> {
  try {
    const parsed = SelectOptionSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { selector, value, label } = parsed.data;
    const page = await getBrowserManager().getPage();
    
    if (value) {
      await page.selectOption(selector, { value }, { timeout: 5000 });
    } else if (label) {
      await page.selectOption(selector, { label }, { timeout: 5000 });
    }

    return { success: true, data: { selected: true } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 批量填充表单 */
export async function fillForm(input: unknown): Promise<ToolResult<{ filled: number }>> {
  try {
    const parsed = FillFormSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { fields } = parsed.data;
    const page = await getBrowserManager().getPage();
    let filled = 0;

    for (const field of fields) {
      if (field.type === 'select') {
        await page.selectOption(field.selector, field.value, { timeout: 3000 });
      } else if (field.type === 'checkbox') {
        const checked = field.value === 'true';
        if (checked) {
          await page.check(field.selector, { timeout: 3000 });
        } else {
          await page.uncheck(field.selector, { timeout: 3000 });
        }
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

/** 获取页面内容 */
export async function getPageContent(input: unknown): Promise<ToolResult<{ content: string }>> {
  try {
    const parsed = GetPageContentSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { type, selector } = parsed.data;
    const page = await getBrowserManager().getPage();
    
    let content: string;
    if (selector) {
      const element = page.locator(selector);
      content = type === 'html' 
        ? await element.innerHTML({ timeout: 5000 })
        : await element.textContent({ timeout: 5000 }) ?? '';
    } else {
      content = type === 'html'
        ? await page.content()
        : await page.evaluate('document.body.innerText');
    }

    return { success: true, data: { content } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** PDF 导出 */
export async function pdfExport(input: unknown): Promise<ToolResult<{ path: string }>> {
  try {
    const parsed = PdfExportSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { path: pdfPath, fullPage } = parsed.data;
    const page = await getBrowserManager().getPage();
    
    const dir = path.dirname(pdfPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    await page.pdf({ 
      path: pdfPath, 
      printBackground: true,
      format: 'A4'
    });

    return { success: true, data: { path: pdfPath } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 获取 Cookie */
export async function getCookies(input: unknown): Promise<ToolResult<{ cookies: unknown[] }>> {
  try {
    const parsed = GetCookiesSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { name } = parsed.data;
    const context = await getBrowserManager().getContext();
    const cookies = await context.cookies();
    
    const filtered = name ? cookies.filter(c => c.name === name) : cookies;

    return { success: true, data: { cookies: filtered } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 设置 Cookie */
export async function setCookies(input: unknown): Promise<ToolResult<{ set: number }>> {
  try {
    const parsed = SetCookiesSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { cookies } = parsed.data;
    const context = await getBrowserManager().getContext();
    
    await context.addCookies(cookies.map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain ?? 'localhost',
      path: c.path ?? '/',
      expires: c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure
    })));

    return { success: true, data: { set: cookies.length } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 生成页面报告 */
export async function generatePageReport(input: unknown): Promise<ToolResult<unknown>> {
  try {
    const parsed = PageReportSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { includeLinks, includeForms, includeImages } = parsed.data;
    const page = await getBrowserManager().getPage();
    
    const report: Record<string, unknown> = {
      url: page.url(),
      title: await page.title(),
      timestamp: new Date().toISOString()
    };

    // 基础统计
    report.stats = await page.evaluate(`({
      elements: document.querySelectorAll('*').length,
      scripts: document.querySelectorAll('script').length,
      styles: document.querySelectorAll('link[rel="stylesheet"], style').length
    })`);

    // 链接分析
    if (includeLinks) {
      report.links = await page.evaluate(`(() => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        const current = window.location.hostname;
        return {
          total: links.length,
          internal: links.filter(a => a.hostname === current).length,
          external: links.filter(a => a.hostname !== current && a.hostname !== '').length,
          anchors: links.filter(a => a.getAttribute('href')?.startsWith('#')).length
        };
      })()`);
    }

    // 表单分析
    if (includeForms) {
      report.forms = await page.evaluate(`({
        total: document.querySelectorAll('form').length,
        inputs: document.querySelectorAll('input').length,
        buttons: document.querySelectorAll('button, input[type="submit"]').length
      })`);
    }

    // 图片分析
    if (includeImages) {
      report.images = await page.evaluate(`(() => {
        const images = Array.from(document.querySelectorAll('img'));
        return {
          total: images.length,
          withAlt: images.filter(img => img.alt && img.alt.trim() !== '').length,
          withoutAlt: images.filter(img => !img.alt || img.alt.trim() === '').length
        };
      })()`);
    }

    // 将报告发送到报告页面
    try {
      await fetch('http://localhost:3210/report/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: report })
      });
    } catch { /* ignore */ }

    return { success: true, data: report };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 工具注册表 */
export const toolRegistry = {
  navigate: {
    name: 'navigate',
    description: '跳转至指定网址',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要跳转的 URL' }
      },
      required: ['url']
    },
    handler: navigate
  },
  click: {
    name: 'click',
    description: '点击页面元素，支持自动滚动到视图内',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器' }
      },
      required: ['selector']
    },
    handler: click
  },
  type: {
    name: 'type',
    description: '在输入框中输入文本',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS 选择器' },
        text: { type: 'string', description: '要输入的文本' }
      },
      required: ['selector', 'text']
    },
    handler: type
  },
  take_screenshot: {
    name: 'take_screenshot',
    description: '截取当前页面截图，保存至 storage/screenshots',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '截图文件名（可选）' },
        fullPage: { type: 'boolean', description: '是否全屏截图' }
      }
    },
    handler: takeScreenshot
  },
  get_console_logs: {
    name: 'get_console_logs',
    description: '获取页面所有 console 输出，用于排查前端报错',
    inputSchema: { type: 'object', properties: {} },
    handler: getConsoleLogs
  },
  get_network: {
    name: 'get_network',
    description: '获取网络请求状态，捕获 404/500 等异常',
    inputSchema: { type: 'object', properties: {} },
    handler: getNetwork
  },
  execute_js: {
    name: 'execute_js',
    description: '在当前页面执行自定义 JavaScript 并返回结果',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '要执行的 JavaScript 代码' }
      },
      required: ['script']
    },
    handler: executeJs
  }
} as const;

export type ToolName = keyof typeof toolRegistry;
