/**
 * Express + Streamable HTTP + MCP 服务入口
 * Claude Code 版本（支持 stdio 与 Streamable HTTP 双传输）
 */

// stdio 模式必须在任何其它代码运行前，把 stdout 日志重定向到 stderr，
// 否则会污染 JSON-RPC 数据流。
const STDIO = process.argv.includes('--stdio') || process.env['MCP_TRANSPORT'] === 'stdio';
if (STDIO) {
  console.log = (...a: unknown[]) => console.error(...a);
  console.info = (...a: unknown[]) => console.error(...a);
}

import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { isInitializeRequest, type ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { getBrowserManager } from './browser.js';
import * as tools from './tools.js';
import type { HealthCheckResult } from './types.js';
import {
  NavigateSchema, ClickSchema, TypeSchema, ScreenshotSchema,
  ExecuteJsSchema, ScrollSchema, WaitForSelectorSchema,
  GetElementTextSchema, GetElementAttributeSchema, HoverSchema,
  SelectOptionSchema, FillFormSchema, GetPageContentSchema,
  PdfExportSchema, GetCookiesSchema, SetCookiesSchema,
  PageReportSchema, SetViewportSchema,
  KeyboardPressSchema, DragAndDropSchema, FileUploadSchema,
  NewTabSchema, TabIndexSchema, InterceptRequestsSchema,
  ExtractLinksSchema, ExtractDataSchema, BatchFetchSchema,
  CrawlPagesSchema, WaitAndExtractSchema, SetBlockRulesSchema
} from './schemas.js';

const PORT = parseInt(process.env['PORT'] ?? '3211', 10);
const startTime = Date.now();
const SERVER_VERSION = '2.0.0';

// Session management
const SESSION_TTL = 30 * 60 * 1000;
const MAX_SESSIONS = 20;
const transports: Map<string, { transport: StreamableHTTPServerTransport; lastAccess: number }> = new Map();

function cleanupSessions(): void {
  const now = Date.now();
  for (const [sid, entry] of transports) {
    if (now - entry.lastAccess > SESSION_TTL) {
      entry.transport.close?.();
      transports.delete(sid);
      console.log(`[Session] Expired: ${sid}`);
    }
  }
}
setInterval(cleanupSessions, 5 * 60 * 1000);

// Direct tool handler map for sessionless requests (HTTP compatibility)
const directToolHandlers: Record<string, (args: unknown) => Promise<unknown>> = {
  navigate: async (a) => text(await tools.navigate(a)),
  set_viewport: async (a) => text(await tools.setViewport(a)),
  go_back: async () => text(await tools.goBack()),
  go_forward: async () => text(await tools.goForward()),
  click: async (a) => text(await tools.click(a)),
  type: async (a) => text(await tools.type(a)),
  hover: async (a) => text(await tools.hover(a)),
  scroll: async (a) => text(await tools.scroll(a)),
  select_option: async (a) => text(await tools.selectOption(a)),
  fill_form: async (a) => text(await tools.fillForm(a)),
  keyboard_press: async (a) => text(await tools.keyboardPress(a)),
  drag_and_drop: async (a) => text(await tools.dragAndDrop(a)),
  file_upload: async (a) => text(await tools.fileUpload(a)),
  take_screenshot: async (a) => {
    const result = await tools.takeScreenshot(a);
    if (result.success && result.data.base64) {
      return { content: [
        { type: 'image' as const, data: result.data.base64, mimeType: 'image/png' as const },
        { type: 'text' as const, text: JSON.stringify({ success: true, data: { path: result.data.path, fullPage: result.data.fullPage } }) }
      ] };
    }
    return text(result);
  },
  get_console_logs: async () => text(await tools.getConsoleLogs()),
  get_network: async () => text(await tools.getNetwork()),
  execute_js: async (a) => text(await tools.executeJs(a)),
  wait_for_selector: async (a) => text(await tools.waitForSelector(a)),
  get_element_text: async (a) => text(await tools.getElementText(a)),
  get_element_attribute: async (a) => text(await tools.getElementAttribute(a)),
  get_page_content: async (a) => text(await tools.getPageContent(a)),
  get_cookies: async (a) => text(await tools.getCookies(a)),
  set_cookies: async (a) => text(await tools.setCookies(a)),
  pdf_export: async (a) => text(await tools.pdfExport(a)),
  generate_page_report: async (a) => text(await tools.generatePageReport(a)),
  list_tabs: async () => text(await tools.listTabs()),
  new_tab: async (a) => text(await tools.newTab(a)),
  switch_tab: async (a) => text(await tools.switchTab(a)),
  close_tab: async (a) => text(await tools.closeTab(a)),
  intercept_requests: async (a) => text(await tools.interceptRequests(a)),
  set_block_rules: async (a) => text(await tools.setBlockRules(a)),
  extract_links: async (a) => text(await tools.extractLinks(a)),
  extract_data: async (a) => text(await tools.extractData(a)),
  wait_and_extract: async (a) => text(await tools.waitAndExtract(a)),
  batch_fetch: async (a) => text(await tools.batchFetch(a)),
  crawl_pages: async (a) => text(await tools.crawlPages(a)),
};

/** Handle tools/call directly without MCP session */
async function handleDirectToolCall(body: { id: unknown; params?: { name?: string; arguments?: unknown } }, res: Response): Promise<boolean> {
  const toolName = body.params?.name;
  const toolArgs = body.params?.arguments ?? {};
  if (!toolName || !directToolHandlers[toolName]) {
    res.json({ jsonrpc: '2.0', error: { code: -32601, message: `Unknown tool: ${toolName}` }, id: body.id });
    return true;
  }
  try {
    const result = await directToolHandlers[toolName]!(toolArgs);
    res.json({ jsonrpc: '2.0', result, id: body.id });
  } catch (error) {
    res.json({ jsonrpc: '2.0', error: { code: -32603, message: error instanceof Error ? error.message : String(error) }, id: body.id });
  }
  return true;
}

// Helper to wrap tool results
function text(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'claudemcp-browser', version: SERVER_VERSION });

  // === Navigation ===
  server.registerTool('navigate', {
    title: '打开网页',
    description: '在当前标签页跳转到指定网址并等待加载完成。爬虫标准流程的第二步（先 set_block_rules 再 navigate）。静态页跳转后可直接操作，SPA/动态页需配合 wait_for_selector。',
    inputSchema: NavigateSchema.shape,
    annotations: { title: '打开网页', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  }, async (args) => text(await tools.navigate(args)));

  server.registerTool('set_viewport', {
    title: '设置视口',
    description: '设置浏览器窗口的宽高像素，用于测试响应式布局或模拟特定设备分辨率。',
    inputSchema: SetViewportSchema.shape,
    annotations: { title: '设置视口', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.setViewport(args)));

  server.registerTool('go_back', {
    title: '后退',
    description: '浏览器历史后退一页，等同于点击浏览器返回按钮。',
    annotations: { title: '后退', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } satisfies ToolAnnotations,
  }, async () => text(await tools.goBack()));

  server.registerTool('go_forward', {
    title: '前进',
    description: '浏览器历史前进一页，等同于点击浏览器前进按钮。',
    annotations: { title: '前进', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } satisfies ToolAnnotations,
  }, async () => text(await tools.goForward()));

  // === Interaction ===
  server.registerTool('click', {
    title: '点击元素',
    description: '点击页面元素，内置三级 fallback（正常→force→JS），无需手动重试。若仍失败可改用 execute_js 直接操作 DOM。',
    inputSchema: ClickSchema.shape,
    annotations: { title: '点击元素', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.click(args)));

  server.registerTool('type', {
    title: '输入文本',
    description: '在输入框中输入文本，内置三级 fallback（正常→force→JS）。批量填表请改用 fill_form，效率更高。',
    inputSchema: TypeSchema.shape,
    annotations: { title: '输入文本', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.type(args)));

  server.registerTool('hover', {
    title: '悬停元素',
    description: '将鼠标悬停在元素上，用于触发 hover 菜单、提示框或懒加载内容。',
    inputSchema: HoverSchema.shape,
    annotations: { title: '悬停元素', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.hover(args)));

  server.registerTool('scroll', {
    title: '滚动页面',
    description: '滚动页面到指定 x/y 坐标，或滚动到某元素可见处。用于触发滚动懒加载内容。',
    inputSchema: ScrollSchema.shape,
    annotations: { title: '滚动页面', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.scroll(args)));

  server.registerTool('select_option', {
    title: '选择下拉项',
    description: '在 select 下拉框中按 value 或可见文本选中选项。',
    inputSchema: SelectOptionSchema.shape,
    annotations: { title: '选择下拉项', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.selectOption(args)));

  server.registerTool('fill_form', {
    title: '批量填表',
    description: '一次性批量填写多个表单字段（文本框/下拉框/复选框）。需要填写 2 个以上字段时优先用本工具，避免多次调用 type。',
    inputSchema: FillFormSchema.shape,
    annotations: { title: '批量填表', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.fillForm(args)));

  server.registerTool('keyboard_press', {
    title: '按键',
    description: '按下键盘按键，如 Enter、Tab、Escape、方向键。用于提交表单或键盘导航。',
    inputSchema: KeyboardPressSchema.shape,
    annotations: { title: '按键', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.keyboardPress(args)));

  server.registerTool('drag_and_drop', {
    title: '拖拽元素',
    description: '将源元素拖拽到目标元素位置，用于排序、看板移动等交互。',
    inputSchema: DragAndDropSchema.shape,
    annotations: { title: '拖拽元素', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.dragAndDrop(args)));

  server.registerTool('file_upload', {
    title: '上传文件',
    description: '向 input[type=file] 元素上传本地文件，需提供文件的本地绝对路径。',
    inputSchema: FileUploadSchema.shape,
    annotations: { title: '上传文件', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.fileUpload(args)));

  // === Observation ===
  server.registerTool('take_screenshot', {
    title: '页面截图',
    description: '截取当前页面并返回 base64 图片。截图较慢（约 1 秒），仅在需要视觉验证、调试定位或返回图片给用户时使用。读取页面内容请改用 get_page_content 或 extract_data，更快。',
    inputSchema: ScreenshotSchema.shape,
    annotations: { title: '页面截图', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => {
    const result = await tools.takeScreenshot(args);
    if (result.success && result.data.base64) {
      return { content: [
        { type: 'image' as const, data: result.data.base64, mimeType: 'image/png' as const },
        { type: 'text' as const, text: JSON.stringify({ success: true, data: { path: result.data.path, fullPage: result.data.fullPage } }) }
      ] };
    }
    return text(result);
  });

  server.registerTool('get_console_logs', {
    title: '控制台日志',
    description: '获取页面累计的 console 输出（log/warn/error 等），用于调试前端报错。',
    annotations: { title: '控制台日志', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async () => text(await tools.getConsoleLogs()));

  server.registerTool('get_network', {
    title: '网络请求记录',
    description: '获取页面累计的网络请求记录（URL、方法、状态码），用于排查接口或资源加载问题。',
    annotations: { title: '网络请求记录', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async () => text(await tools.getNetwork()));

  server.registerTool('execute_js', {
    title: '执行 JS',
    description: '在页面上下文执行自定义 JavaScript 并返回结果。当 click/type 三级 fallback 仍失败、或需要复杂 DOM 操作时使用。提取链接请优先用 extract_links。',
    inputSchema: ExecuteJsSchema.shape,
    annotations: { title: '执行 JS', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.executeJs(args)));

  server.registerTool('wait_for_selector', {
    title: '等待元素',
    description: '等待指定元素出现/隐藏。SPA/React/Vue 等动态页面在 navigate 后应先等待关键元素再操作，避免拿到空数据。静态页面无需调用。',
    inputSchema: WaitForSelectorSchema.shape,
    annotations: { title: '等待元素', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.waitForSelector(args)));

  // === Content extraction ===
  server.registerTool('get_element_text', {
    title: '获取元素文本',
    description: '获取单个元素的文本内容。提取列表/表格等多条数据时请改用 extract_data，避免多次调用。',
    inputSchema: GetElementTextSchema.shape,
    annotations: { title: '获取元素文本', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.getElementText(args)));

  server.registerTool('get_element_attribute', {
    title: '获取元素属性',
    description: '获取单个元素的指定属性值，如 href、src、data-* 等。',
    inputSchema: GetElementAttributeSchema.shape,
    annotations: { title: '获取元素属性', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.getElementAttribute(args)));

  server.registerTool('get_page_content', {
    title: '获取页面内容',
    description: '获取页面 HTML 或纯文本内容，可用 selector 限定范围。读取简单页面内容的首选，比 take_screenshot 更快更省。',
    inputSchema: GetPageContentSchema.shape,
    annotations: { title: '获取页面内容', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.getPageContent(args)));

  server.registerTool('get_cookies', {
    title: '获取 Cookie',
    description: '获取当前页面的 Cookie，可按名称过滤。用于检查登录态或调试会话。',
    inputSchema: GetCookiesSchema.shape,
    annotations: { title: '获取 Cookie', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  }, async (args) => text(await tools.getCookies(args)));

  server.registerTool('set_cookies', {
    title: '设置 Cookie',
    description: '向浏览器写入 Cookie，常用于注入登录态后再访问需要鉴权的页面。',
    inputSchema: SetCookiesSchema.shape,
    annotations: { title: '设置 Cookie', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  }, async (args) => text(await tools.setCookies(args)));

  // === Export & report ===
  server.registerTool('pdf_export', {
    title: '导出 PDF',
    description: '将当前页面导出为 PDF 文件并保存到指定路径。',
    inputSchema: PdfExportSchema.shape,
    annotations: { title: '导出 PDF', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.pdfExport(args)));

  server.registerTool('generate_page_report', {
    title: '页面分析报告',
    description: '生成页面结构分析报告（链接/表单/图片清单），用于快速了解页面整体结构、规划爬虫选择器。',
    inputSchema: PageReportSchema.shape,
    annotations: { title: '页面分析报告', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.generatePageReport(args)));

  // === Multi-tab ===
  server.registerTool('list_tabs', {
    title: '列出标签页',
    description: '列出当前所有打开的标签页及索引，配合 switch_tab 使用。',
    annotations: { title: '列出标签页', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async () => text(await tools.listTabs()));

  server.registerTool('new_tab', {
    title: '新建标签页',
    description: '打开一个新标签页（可指定网址）。需要同时保持多个页面时用多标签页，比反复 navigate 更快。',
    inputSchema: NewTabSchema.shape,
    annotations: { title: '新建标签页', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } satisfies ToolAnnotations,
  }, async (args) => text(await tools.newTab(args)));

  server.registerTool('switch_tab', {
    title: '切换标签页',
    description: '按索引切换当前活动标签页，后续操作都作用于该标签页。',
    inputSchema: TabIndexSchema.shape,
    annotations: { title: '切换标签页', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.switchTab(args)));

  server.registerTool('close_tab', {
    title: '关闭标签页',
    description: '按索引关闭指定标签页，释放资源。',
    inputSchema: TabIndexSchema.shape,
    annotations: { title: '关闭标签页', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.closeTab(args)));

  // === Network intercept ===
  server.registerTool('intercept_requests', {
    title: '拦截请求',
    description: '按 URL 模式拦截/记录/修改网络请求。需要按规则屏蔽图片/广告加速爬取时，优先用更简单的 set_block_rules。',
    inputSchema: InterceptRequestsSchema.shape,
    annotations: { title: '拦截请求', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.interceptRequests(args)));

  // === 爬虫工具 ===
  server.registerTool('set_block_rules', {
    title: '爬虫加速屏蔽',
    description: '爬虫加速：屏蔽图片/广告/字体请求，爬取数据前第一步调用，速度提升 3-5 倍。标准爬虫流程的起点。',
    inputSchema: SetBlockRulesSchema.shape,
    annotations: { title: '爬虫加速屏蔽', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.setBlockRules(args)));

  server.registerTool('extract_links', {
    title: '提取链接',
    description: '提取页面所有链接，支持范围限定和 URL 关键词过滤。比手写 execute_js querySelectorAll 更可靠。批量抓取详情页前先用它收集链接。',
    inputSchema: ExtractLinksSchema.shape,
    annotations: { title: '提取链接', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  }, async (args) => text(await tools.extractLinks(args)));

  server.registerTool('extract_data', {
    title: '提取结构化数据',
    description: '按 CSS 选择器批量提取结构化数据（列表/表格），支持多字段映射。提取多条数据的首选，胜过多次 get_element_text。动态/Ajax 页面请改用 wait_and_extract，否则可能拿到空数据。',
    inputSchema: ExtractDataSchema.shape,
    annotations: { title: '提取结构化数据', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.extractData(args)));

  server.registerTool('wait_and_extract', {
    title: '等待并提取',
    description: '等待动态内容加载完成后再提取，适合 SPA/懒加载/Ajax 页面。waitSelector 设为数据容器，避免直接 extract_data 拿到空数据。',
    inputSchema: WaitAndExtractSchema.shape,
    annotations: { title: '等待并提取', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, async (args) => text(await tools.waitAndExtract(args)));

  server.registerTool('batch_fetch', {
    title: '批量抓取 URL',
    description: '批量抓取多个不同 URL（最多 20 个），支持内容提取和请求间隔。胜过循环 navigate + get_page_content。建议 delay 设 500-1000ms 防封号。',
    inputSchema: BatchFetchSchema.shape,
    annotations: { title: '批量抓取 URL', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  }, async (args) => text(await tools.batchFetch(args)));

  server.registerTool('crawl_pages', {
    title: '自动翻页爬取',
    description: '自动分页爬取：自动点击下一页并汇总所有数据，内置翻页等待。胜过手动循环 click + extract_data。建议 delay 设 800-1500ms 防封号。',
    inputSchema: CrawlPagesSchema.shape,
    annotations: { title: '自动翻页爬取', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } satisfies ToolAnnotations,
  }, async (args) => text(await tools.crawlPages(args)));

  return server;
}

function createApp(): express.Application {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
    if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  // Rate limiter: 100 req/s per IP
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  app.use((req: Request, res: Response, next: NextFunction) => {
    const ip = req.ip ?? 'unknown';
    const now = Date.now();
    const entry = requestCounts.get(ip);
    if (!entry || now > entry.resetAt) {
      requestCounts.set(ip, { count: 1, resetAt: now + 1000 });
    } else {
      entry.count++;
      if (entry.count > 100) { res.status(429).json({ error: 'Too many requests' }); return; }
    }
    next();
  });

  // Health
  app.get('/health', async (_req: Request, res: Response) => {
    const bm = getBrowserManager();
    const result: HealthCheckResult = {
      status: bm.isAlive() ? 'ok' : 'error',
      browserAlive: bm.isAlive(),
      uptime: Date.now() - startTime,
      sessions: transports.size
    };
    res.json(result);
  });

  let requestCount = 0;
  app.get('/connections', async (_req: Request, res: Response) => {
    res.json({ mode: 'session', sessions: transports.size, requestCount, uptime: Math.floor((Date.now() - startTime) / 1000) + 's' });
  });

  // MCP POST
  app.post('/mcp', async (req: Request, res: Response) => {
    requestCount++;
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const isInit = isInitializeRequest(req.body);
      console.log(`[MCP] POST sid=${sessionId ? sessionId.slice(0, 8) + '...' : 'none'} init=${isInit} method=${req.body?.method ?? '?'} sessions=${transports.size}`);
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        // Known session
        const entry = transports.get(sessionId)!;
        entry.lastAccess = Date.now();
        transport = entry.transport;
      } else if (isInit) {
        // Initialize request (with or without stale session ID) → new session
        if (transports.size >= MAX_SESSIONS) {
          cleanupSessions();
          if (transports.size >= MAX_SESSIONS) {
            res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many sessions' }, id: null });
            return;
          }
        }
        const eventStore = new InMemoryEventStore();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          eventStore,
          onsessioninitialized: (sid) => {
            transports.set(sid, { transport, lastAccess: Date.now() });
            console.log(`[Session] New: ${sid} (total: ${transports.size})`);
          }
        });
        transport.onclose = () => {
          const sid = [...transports.entries()].find(([_, e]) => e.transport === transport)?.[0];
          if (sid) { transports.delete(sid); console.log(`[Session] Closed: ${sid}`); }
        };
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
      } else {
        // No valid session + not initialize → handle directly
        const method = req.body?.method;
        if (method === 'tools/call') {
          console.log(`[MCP] Direct tool call: ${req.body?.params?.name}`);
          await handleDirectToolCall(req.body, res);
          return;
        } else if (method === 'tools/list') {
          console.log('[MCP] Direct tools/list');
          const toolsList = Object.keys(directToolHandlers).map(name => ({ name }));
          res.json({ jsonrpc: '2.0', result: { tools: toolsList }, id: req.body?.id });
          return;
        } else {
          res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: `No session for method: ${method}` }, id: req.body?.id });
          return;
        }
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] Error:', error);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });

  // MCP GET (SSE streaming)
  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      transports.get(sessionId)!.lastAccess = Date.now();
      await transports.get(sessionId)!.transport.handleRequest(req, res);
    } else {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null });
    }
  });

  // MCP DELETE
  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.transport.handleRequest(req, res);
    } else {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null });
    }
  });

  return app;
}

function listenWithRetry(app: express.Application, host: string, port: number, retries: number): void {
  const server = app.listen(port, host, () => {
    console.log('========================================');
    console.log(`  Claude Code MCP Browser Bridge v${SERVER_VERSION}`);
    console.log(`  http://${host}:${port}`);
    console.log(`  MCP: http://${host}:${port}/mcp`);
    console.log('========================================');
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.log(`[Server] Port ${port} in use, retrying in 2s...`);
      setTimeout(() => listenWithRetry(app, host, port, retries - 1), 2000);
    } else { console.error('[Server] Failed:', err.message); process.exit(1); }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[Server] Shutting down...');
    for (const [sid, entry] of transports) { try { entry.transport.close?.(); } catch {} transports.delete(sid); }
    try { await getBrowserManager().close(); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function killPortProcess(port: number): Promise<void> {
  try {
    const { execSync } = await import('child_process');
    if (process.platform === 'win32') {
      const output = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8', timeout: 5000 });
      const pids = new Set<string>();
      for (const line of output.trim().split('\n')) {
        const m = line.trim().match(/\s+(\d+)$/);
        if (m && m[1] && m[1] !== String(process.pid)) pids.add(m[1]);
      }
      for (const pid of pids) {
        try { execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 }); } catch {}
      }
    } else {
      const output = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf-8', timeout: 5000 });
      for (const pid of output.trim().split('\n')) {
        if (pid && pid !== String(process.pid)) {
          try { execSync(`kill -9 ${pid}`, { timeout: 5000 }); } catch {}
        }
      }
    }
  } catch {}
}

/** stdio 传输入口：供 Claude Code 原生 MCP 客户端使用 */
async function runStdio(): Promise<void> {
  // 预热浏览器，失败不阻塞，首个请求会重试
  try {
    await getBrowserManager().getContext();
    console.error('[Server] Browser ready (stdio mode)');
  } catch {
    console.error('[Server] Browser start failed, will retry on first request');
  }
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error(`[Server] Claude Code MCP Browser v${SERVER_VERSION} ready on stdio`);
}

/** HTTP 传输入口：Express + Streamable HTTP */
async function runHttp(): Promise<void> {
  await killPortProcess(PORT);
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('[Server] Starting browser...');
  try { await getBrowserManager().getContext(); console.log('[Server] Browser ready'); }
  catch { console.error('[Server] Browser start failed, will retry on first request'); }
  const app = createApp();
  listenWithRetry(app, process.env['HOST'] ?? '0.0.0.0', PORT, 3);
}

async function main(): Promise<void> {
  if (STDIO) {
    await runStdio();
  } else {
    await runHttp();
  }
}

main().catch((error) => { console.error('[Server] Startup failed:', error); process.exit(1); });
