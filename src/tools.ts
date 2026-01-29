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
  ExecuteJsSchema
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

/** 点击元素 */
export async function click(input: unknown): Promise<ToolResult<ClickResult>> {
  try {
    const parsed = ClickSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { selector } = parsed.data;
    const page = await getBrowserManager().getPage();
    
    // 减少等待超时，快速失败
    await page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
    await page.click(selector, { timeout: 3000, noWaitAfter: true });

    return {
      success: true,
      data: { selector, clicked: true }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** 输入文本 */
export async function type(input: unknown): Promise<ToolResult<TypeResult>> {
  try {
    const parsed = TypeSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const { selector, text } = parsed.data;
    const page = await getBrowserManager().getPage();
    
    // 快速定位并输入
    await page.waitForSelector(selector, { timeout: 3000, state: 'visible' });
    await page.fill(selector, text, { timeout: 3000, noWaitAfter: true });

    return {
      success: true,
      data: { selector, typed: true }
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
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

    // 使用 jpeg 格式和较低质量以加快速度
    await page.screenshot({
      path: filePath,
      fullPage,
      timeout: 10000,
      animations: 'disabled'
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
