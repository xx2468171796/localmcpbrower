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
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer, isInitializeRequest } from "@modelcontextprotocol/server";
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import { z } from 'zod';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { BoundedEventStore } from './eventStore.js';
import { getBrowserManager } from './browser.js';
import { mcpCtx, STDIO_SESSION_ID, type ProgressReporter } from './context.js';
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
  CrawlPagesSchema, WaitAndExtractSchema, SetBlockRulesSchema,
  SnapshotSchema, ExtractArticleSchema, DiscoverUrlsSchema,
  RunScriptSchema, SpaceNameSchema
} from './schemas.js';

const PORT = parseInt(process.env['PORT'] ?? '3211', 10);
const startTime = Date.now();
const SERVER_VERSION = '2.2.0';

// ============================================================
// HTTP 安全参数
// 浏览器里存着**已登录的公司系统会话**，HTTP 端口等于把这些会话的控制权暴露出去。
// 因此默认只绑 127.0.0.1；要跨机共享必须显式设 HOST，且此时强制要求 token。
// ============================================================
// ?? 只对 null/undefined 回落：HOST 被设成空串时会绑到全部网卡，而 allowedHosts 里存的是
// ':PORT'，永远匹配不上真实 Host 头 → 所有请求 403，极难排查。用 || + trim 一并挡掉空串/空白。
const HOST = (process.env['HOST'] || '').trim() || '127.0.0.1';
const AUTH_TOKEN = (process.env['MCP_AUTH_TOKEN'] ?? '').trim();

/** 是否本机回环地址（含 IPv6 与 127.0.0.0/8 全段） */
function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1' || /^127\./.test(h);
}

/**
 * Host / Origin 白名单：同一份同时喂给 SDK 的 DNS rebinding 防护与 CORS 中间件，
 * 避免两处规则漂移。显式绑定到其它地址时把该地址也放进去，否则自己都连不上。
 */
function buildAllowLists(): { hosts: string[]; origins: string[] } {
  const hosts = new Set<string>();
  const origins = new Set<string>();
  for (const h of ['127.0.0.1', 'localhost', '[::1]']) {
    hosts.add(`${h}:${PORT}`);
    origins.add(`http://${h}:${PORT}`);
  }
  hosts.add(`${HOST}:${PORT}`);
  origins.add(`http://${HOST}:${PORT}`);
  for (const extra of (process.env['MCP_ALLOWED_HOSTS'] ?? '').split(',')) {
    const v = extra.trim();
    if (v) hosts.add(v);
  }
  for (const extra of (process.env['MCP_ALLOWED_ORIGINS'] ?? '').split(',')) {
    const v = extra.trim();
    if (v) origins.add(v);
  }
  return { hosts: [...hosts], origins: [...origins] };
}
const ALLOWED = buildAllowLists();

/** 定长比较，避免 token 校验被计时侧信道逐字节试出来 */
function tokenMatches(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(AUTH_TOKEN);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * 可选 Bearer 鉴权：设了 MCP_AUTH_TOKEN 就校验，未设则跳过（本机 loopback 场景）。
 * V1 默认不开，但代码内置 —— 跨机是既定终局，retrofit 鉴权要动全部路由与客户端配置。
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!AUTH_TOKEN) { next(); return; }
  const raw = (req.headers.authorization ?? '').trim();
  const m = /^Bearer\s+(.+)$/i.exec(raw);
  const token = m?.[1]?.trim();
  if (!token || !tokenMatches(token)) {
    res.header('WWW-Authenticate', 'Bearer');
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    return;
  }
  next();
}

// 服务级使用说明:支持 instructions 的 MCP 客户端(Claude Code / Codex 等)会把这段
// 注入 AI 上下文,让 AI 不读文档也知道工具间的正确配合方式。保持精炼,别堆细节。
const SERVER_INSTRUCTIONS = `本地浏览器操控 MCP。工具配合要点:
- 爬取标准流程:set_block_rules(屏蔽图片/广告,提速 3-5 倍)→ navigate → 动态页先 wait_for_selector → extract_data / extract_links。
- 了解页面结构首选 snapshot(无障碍树,带 ref 编号,token 极低);take_screenshot 仅用于视觉验证。
- 操作元素优先传 snapshot 返回的 ref(免写 CSS 选择器);页面重渲染后 ref 失效,交互失败就重新 snapshot。
- 批量场景:多个不同 URL 用 batch_fetch,自动翻页用 crawl_pages,爬大站前先 discover_urls 探明地址。
- 新闻/博客/文档类页面用 extract_article 直接拿干净 Markdown 正文。
- 填 2 个以上表单字段用 fill_form;click/type 内置三级 fallback,仍失败改 execute_js 直接操作 DOM。
- 多步交互(填表→点击→等待→读结果)优先用 run_script 一次跑完:脚本里调 __ego.click/fill/waitFor/snapshot,省去多次往返。
- snapshot/click/type/hover 已能穿透 iframe(含跨域),iframe 内元素同样带 ref、可直接操作。
- 需要并行多任务或多账号隔离时用 space_new 开独立工作区(cookie/登录态互不干扰),space_switch 切换,space_list 查看。`;

// Session management
const SESSION_TTL = 30 * 60 * 1000;
const MAX_SESSIONS = 20;
const transports: Map<string, { transport: NodeStreamableHTTPServerTransport; lastAccess: number }> = new Map();

/** 会话下线统一出口：关掉它名下的全部标签页并清空日志缓冲，避免死会话白占浏览器资源 */
function releaseSession(sid: string): void {
  transports.delete(sid);
  void getBrowserManager().closeSession(sid).catch((e) => {
    console.error(`[Session] 回收 ${sid} 的页面失败:`, e);
  });
}

function cleanupSessions(): void {
  const now = Date.now();
  for (const [sid, entry] of transports) {
    if (now - entry.lastAccess > SESSION_TTL) {
      entry.transport.close?.();
      releaseSession(sid);
      console.log(`[Session] Expired: ${sid}`);
    }
  }
}
// 仅 HTTP 模式需要定期清理 session；unref 避免阻止进程自然退出
if (!STDIO) setInterval(cleanupSessions, 5 * 60 * 1000).unref();

// Helper to wrap tool results
function text(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

// 同时返回文本与 structuredContent（用于设置了 outputSchema 的工具）
function structured(result: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

// 复用的工具结果信封 outputSchema —— 对应 ToolResult<T> 形状
const ResultEnvelope = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});

/** 工具 handler 的最宽签名 —— 只用于 wrap 的泛型约束，不参与实际类型推导 */
type ToolHandler = (...args: never[]) => unknown;

/**
 * HTTP 模式下每个会话一个独立 McpServer 实例，sessionId 直接闭包捕获。
 * 全部 44 个 handler 统一套一层 mcpCtx.run，让 BrowserManager 在调用链任意深度
 * 都能读到「这次调用属于哪个会话」，工具函数签名一律不动（零侵入）。
 * stdio 传入默认值 → 与改造前的单会话行为完全一致。
 */
function createMcpServer(sessionId: string = STDIO_SESSION_ID): McpServer {
  const server = new McpServer(
    { name: 'claudemcp-browser', title: '本地浏览器操控', version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  /**
   * 从 MCP 请求上下文里取出进度上报器。
   *
   * 客户端要进度时会在请求的 `_meta.progressToken` 里带一个令牌;没带就说明它不关心,
   * 此时返回 undefined,reportProgress() 自动 no-op(不白白构造通知)。
   *
   * 通知走 `ctx.mcpReq.notify` 而不是全局 server.notification —— 前者是**请求级**的,
   * 传输层才能把这条进度和当初那个 tools/call 关联起来;用全局的会丢失关联。
   */
  const progressOf = (ctx: unknown): ProgressReporter | undefined => {
    const req = (ctx as { mcpReq?: {
      _meta?: { progressToken?: string | number };
      notify?: (n: { method: string; params?: Record<string, unknown> }) => Promise<void>;
    } } | undefined)?.mcpReq;
    const progressToken = req?._meta?.progressToken;
    const notify = req?.notify;
    if (progressToken === undefined || typeof notify !== 'function') return undefined;
    return (progress, total, message) => {
      // 故意不 await:进度是旁路,不能拖慢主流程,更不能因为它失败而让工具失败
      void notify({
        method: 'notifications/progress',
        params: { progressToken, progress, ...(total !== undefined ? { total } : {}), ...(message ? { message } : {}) },
      }).catch(() => { /* 连接可能已断 —— 静默 */ });
    };
  };

  const wrap = <T extends ToolHandler>(fn: T): T =>
    ((...args: unknown[]) =>
      mcpCtx.run(
        { sessionId, progress: progressOf(args[1]) },
        () => (fn as unknown as (...a: unknown[]) => unknown)(...args),
      )) as unknown as T;

  // === Navigation ===
  server.registerTool('navigate', {
    title: '打开网页',
    description: '在当前标签页跳转到指定网址并等待加载完成。爬虫标准流程的第二步（先 set_block_rules 再 navigate）。静态页跳转后可直接操作，SPA/动态页需配合 wait_for_selector。',
    inputSchema: NavigateSchema,
    annotations: { title: '打开网页', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.navigate(args))));

  server.registerTool('set_viewport', {
    title: '设置视口',
    description: '设置浏览器窗口的宽高像素，用于测试响应式布局或模拟特定设备分辨率。',
    inputSchema: SetViewportSchema,
    annotations: { title: '设置视口', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.setViewport(args))));

  server.registerTool('go_back', {
    title: '后退',
    description: '浏览器历史后退一页，等同于点击浏览器返回按钮。',
    annotations: { title: '后退', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } satisfies ToolAnnotations,
  }, wrap(async () => text(await tools.goBack())));

  server.registerTool('go_forward', {
    title: '前进',
    description: '浏览器历史前进一页，等同于点击浏览器前进按钮。',
    annotations: { title: '前进', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } satisfies ToolAnnotations,
  }, wrap(async () => text(await tools.goForward())));

  // === Interaction ===
  server.registerTool('click', {
    title: '点击元素',
    description: '点击页面元素，内置三级 fallback（正常→force→JS），无需手动重试。若仍失败可改用 execute_js 直接操作 DOM。',
    inputSchema: ClickSchema,
    annotations: { title: '点击元素', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.click(args))));

  server.registerTool('type', {
    title: '输入文本',
    description: '在输入框中输入文本，内置三级 fallback（正常→force→JS）。批量填表请改用 fill_form，效率更高。',
    inputSchema: TypeSchema,
    annotations: { title: '输入文本', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.type(args))));

  server.registerTool('hover', {
    title: '悬停元素',
    description: '将鼠标悬停在元素上，用于触发 hover 菜单、提示框或懒加载内容。',
    inputSchema: HoverSchema,
    annotations: { title: '悬停元素', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.hover(args))));

  server.registerTool('scroll', {
    title: '滚动页面',
    description: '滚动页面到指定 x/y 坐标，或滚动到某元素可见处。用于触发滚动懒加载内容。',
    inputSchema: ScrollSchema,
    annotations: { title: '滚动页面', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.scroll(args))));

  server.registerTool('select_option', {
    title: '选择下拉项',
    description: '在 select 下拉框中按 value 或可见文本选中选项。',
    inputSchema: SelectOptionSchema,
    annotations: { title: '选择下拉项', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.selectOption(args))));

  server.registerTool('fill_form', {
    title: '批量填表',
    description: '一次性批量填写多个表单字段（文本框/下拉框/复选框）。需要填写 2 个以上字段时优先用本工具，避免多次调用 type。',
    inputSchema: FillFormSchema,
    annotations: { title: '批量填表', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.fillForm(args))));

  server.registerTool('keyboard_press', {
    title: '按键',
    description: '按下键盘按键，如 Enter、Tab、Escape、方向键。用于提交表单或键盘导航。',
    inputSchema: KeyboardPressSchema,
    annotations: { title: '按键', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.keyboardPress(args))));

  server.registerTool('drag_and_drop', {
    title: '拖拽元素',
    description: '将源元素拖拽到目标元素位置，用于排序、看板移动等交互。',
    inputSchema: DragAndDropSchema,
    annotations: { title: '拖拽元素', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.dragAndDrop(args))));

  server.registerTool('file_upload', {
    title: '上传文件',
    description: '向 input[type=file] 元素上传本地文件，需提供文件的本地绝对路径。',
    inputSchema: FileUploadSchema,
    annotations: { title: '上传文件', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.fileUpload(args))));

  // === Observation ===
  server.registerTool('take_screenshot', {
    title: '页面截图',
    description: '截取当前页面并返回 base64 图片。截图较慢（约 1 秒），仅在需要视觉验证、调试定位或返回图片给用户时使用。读取页面内容请改用 get_page_content 或 extract_data，更快。',
    inputSchema: ScreenshotSchema,
    annotations: { title: '页面截图', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => {
    const result = await tools.takeScreenshot(args);
    if (result.success && result.data.base64) {
      const mimeType = result.data.format === 'png' ? 'image/png' : 'image/jpeg';
      return { content: [
        { type: 'image' as const, data: result.data.base64, mimeType },
        { type: 'text' as const, text: JSON.stringify({ success: true, data: { path: result.data.path, fullPage: result.data.fullPage } }) }
      ] };
    }
    return text(result);
  }));

  server.registerTool('get_console_logs', {
    title: '控制台日志',
    description: '获取页面累计的 console 输出（log/warn/error 等），用于调试前端报错。',
    outputSchema: ResultEnvelope,
    annotations: { title: '控制台日志', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async () => structured(await tools.getConsoleLogs())));

  server.registerTool('get_network', {
    title: '网络请求记录',
    description: '获取页面累计的网络请求记录（URL、方法、状态码），用于排查接口或资源加载问题。',
    outputSchema: ResultEnvelope,
    annotations: { title: '网络请求记录', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async () => structured(await tools.getNetwork())));

  server.registerTool('execute_js', {
    title: '执行 JS',
    description: '在页面上下文执行自定义 JavaScript 并返回结果。当 click/type 三级 fallback 仍失败、或需要复杂 DOM 操作时使用。提取链接请优先用 extract_links。',
    inputSchema: ExecuteJsSchema,
    annotations: { title: '执行 JS', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.executeJs(args))));

  server.registerTool('run_script', {
    title: '一次跑完脚本',
    description: '在页面里一次性执行一段 JS，脚本内可直接用 __ego 助手：__ego.snapshot()/click(selOrRef)/fill(selOrRef,val)/waitFor(sel,ms)/text(sel)/attr(sel,name)/exists(sel)/check/select/sleep/$/$$。适合「填表→点击→等待→读结果」这类多步交互，把多次 MCP 往返压成一次，显著省 token 与延迟。selOrRef 同时支持 CSS 选择器和 snapshot 的 ref（如 e5）。支持顶层 await 与 return。',
    inputSchema: RunScriptSchema,
    annotations: { title: '一次跑完脚本', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.runScript(args))));

  server.registerTool('wait_for_selector', {
    title: '等待元素',
    description: '等待指定元素出现/隐藏。SPA/React/Vue 等动态页面在 navigate 后应先等待关键元素再操作，避免拿到空数据。静态页面无需调用。',
    inputSchema: WaitForSelectorSchema,
    annotations: { title: '等待元素', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.waitForSelector(args))));

  // === Content extraction ===
  server.registerTool('get_element_text', {
    title: '获取元素文本',
    description: '获取单个元素的文本内容。提取列表/表格等多条数据时请改用 extract_data，避免多次调用。',
    inputSchema: GetElementTextSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '获取元素文本', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.getElementText(args))));

  server.registerTool('get_element_attribute', {
    title: '获取元素属性',
    description: '获取单个元素的指定属性值，如 href、src、data-* 等。',
    inputSchema: GetElementAttributeSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '获取元素属性', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.getElementAttribute(args))));

  server.registerTool('get_page_content', {
    title: '获取页面内容',
    description: '获取页面 HTML 或纯文本内容，可用 selector 限定范围。读取简单页面内容的首选，比 take_screenshot 更快更省。',
    inputSchema: GetPageContentSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '获取页面内容', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.getPageContent(args))));

  server.registerTool('get_cookies', {
    title: '获取 Cookie',
    description: '获取当前页面的 Cookie，可按名称过滤。用于检查登录态或调试会话。',
    inputSchema: GetCookiesSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '获取 Cookie', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.getCookies(args))));

  server.registerTool('set_cookies', {
    title: '设置 Cookie',
    description: '向浏览器写入 Cookie，常用于注入登录态后再访问需要鉴权的页面。',
    inputSchema: SetCookiesSchema,
    annotations: { title: '设置 Cookie', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.setCookies(args))));

  // === Export & report ===
  server.registerTool('pdf_export', {
    title: '导出 PDF',
    description: '将当前页面导出为 PDF 文件并保存到指定路径。',
    inputSchema: PdfExportSchema,
    annotations: { title: '导出 PDF', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.pdfExport(args))));

  server.registerTool('generate_page_report', {
    title: '页面分析报告',
    description: '生成页面结构分析报告（链接/表单/图片清单），用于快速了解页面整体结构、规划爬虫选择器。',
    inputSchema: PageReportSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '页面分析报告', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.generatePageReport(args))));

  // === Multi-tab ===
  server.registerTool('list_tabs', {
    title: '列出标签页',
    description: '列出当前所有打开的标签页及索引，配合 switch_tab 使用。',
    annotations: { title: '列出标签页', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async () => text(await tools.listTabs())));

  server.registerTool('new_tab', {
    title: '新建标签页',
    description: '打开一个新标签页（可指定网址）。需要同时保持多个页面时用多标签页，比反复 navigate 更快。',
    inputSchema: NewTabSchema,
    annotations: { title: '新建标签页', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.newTab(args))));

  server.registerTool('switch_tab', {
    title: '切换标签页',
    description: '按索引切换当前活动标签页，后续操作都作用于该标签页。',
    inputSchema: TabIndexSchema,
    annotations: { title: '切换标签页', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.switchTab(args))));

  server.registerTool('close_tab', {
    title: '关闭标签页',
    description: '按索引关闭指定标签页，释放资源。',
    inputSchema: TabIndexSchema,
    annotations: { title: '关闭标签页', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.closeTab(args))));

  // === Task Spaces（并行隔离工作区）===
  server.registerTool('space_list', {
    title: '列出工作区',
    description: '列出所有 Task Space（并行隔离工作区）及其状态：名称、是否当前活跃、是否存活、当前 URL。default 工作区始终存在。',
    outputSchema: ResultEnvelope,
    annotations: { title: '列出工作区', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async () => structured(await tools.spaceList())));

  server.registerTool('space_new', {
    title: '新建工作区',
    description: '新建并切换到一个隔离工作区，拥有独立的 userDataDir（cookie/登录态与其它工作区完全隔离）。用于并行跑多任务或同站多账号，互不污染。已存在同名则直接切过去。',
    inputSchema: SpaceNameSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '新建工作区', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.spaceNew(args))));

  server.registerTool('space_switch', {
    title: '切换工作区',
    description: '切换当前活跃工作区，后续所有浏览器工具都作用于该工作区的页面。目标工作区须已由 space_new 创建。',
    inputSchema: SpaceNameSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '切换工作区', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.spaceSwitch(args))));

  server.registerTool('space_close', {
    title: '关闭工作区',
    description: '关闭并销毁一个工作区，释放其浏览器进程（default 不可关）。若关闭的是当前工作区，自动回落到 default。',
    inputSchema: SpaceNameSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '关闭工作区', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.spaceClose(args))));

  // === Network intercept ===
  server.registerTool('intercept_requests', {
    title: '拦截请求',
    description: '按 URL 模式拦截/记录/修改网络请求。需要按规则屏蔽图片/广告加速爬取时，优先用更简单的 set_block_rules。',
    inputSchema: InterceptRequestsSchema,
    annotations: { title: '拦截请求', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.interceptRequests(args))));

  // === 爬虫工具 ===
  server.registerTool('set_block_rules', {
    title: '爬虫加速屏蔽',
    // 语义已从 context 级收敛为**会话级**（挂本会话每张标签页，不再挂 BrowserContext），
    // description 必须同步说明作用域，否则 AI 会以为它能影响别的会话/整个浏览器。
    description: '爬虫加速：屏蔽图片/广告/字体请求，爬取数据前第一步调用，速度提升 3-5 倍。标准爬虫流程的起点。作用于本会话（本会话当前及之后新开的标签页），不影响其他会话。',
    inputSchema: SetBlockRulesSchema,
    annotations: { title: '爬虫加速屏蔽', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => text(await tools.setBlockRules(args))));

  server.registerTool('extract_links', {
    title: '提取链接',
    description: '提取页面所有链接，支持范围限定和 URL 关键词过滤。比手写 execute_js querySelectorAll 更可靠。批量抓取详情页前先用它收集链接。',
    inputSchema: ExtractLinksSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '提取链接', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.extractLinks(args))));

  server.registerTool('extract_data', {
    title: '提取结构化数据',
    description: '按 CSS 选择器批量提取结构化数据（列表/表格），支持多字段映射。提取多条数据的首选，胜过多次 get_element_text。动态/Ajax 页面请改用 wait_and_extract，否则可能拿到空数据。',
    inputSchema: ExtractDataSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '提取结构化数据', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.extractData(args))));

  server.registerTool('wait_and_extract', {
    title: '等待并提取',
    description: '等待动态内容加载完成后再提取，适合 SPA/懒加载/Ajax 页面。waitSelector 设为数据容器，避免直接 extract_data 拿到空数据。',
    inputSchema: WaitAndExtractSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '等待并提取', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.waitAndExtract(args))));

  server.registerTool('batch_fetch', {
    title: '批量抓取 URL',
    description: '批量抓取多个不同 URL（最多 20 个），支持内容提取和请求间隔。胜过循环 navigate + get_page_content。建议 delay 设 500-1000ms 防封号。',
    inputSchema: BatchFetchSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '批量抓取 URL', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.batchFetch(args))));

  server.registerTool('crawl_pages', {
    title: '自动翻页爬取',
    description: '自动分页爬取：自动点击下一页并汇总所有数据，内置翻页等待。胜过手动循环 click + extract_data。建议 delay 设 800-1500ms 防封号。',
    inputSchema: CrawlPagesSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '自动翻页爬取', readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.crawlPages(args))));

  // === ARIA 快照 & 正文提取 ===
  server.registerTool('snapshot', {
    title: '页面无障碍快照',
    description: '返回当前页面的无障碍树（accessibility tree）大纲，每个可交互元素带有 ref 编号（如 e5）。相比 take_screenshot 截图，token 消耗极低，是了解页面结构、定位元素的首选。现已能识别框架无语义可点击元素（cursor:pointer / tabindex>=0 / 扩展 role 等无标签 div）。可选 deep 参数：开启后用 CDP 事件监听深度扫描，找出仅靠 addEventListener 绑定 click 的元素（较慢，默认关闭）。标准工作流：先 snapshot 获取大纲 → 读取目标元素的 ref → 用 click/type/hover 传 ref 参数操作（无需写 CSS 选择器）。注意：ref 仅在页面未重新渲染前有效；SPA/动态页面如交互失败,请重新调用 snapshot 获取最新 ref。',
    inputSchema: SnapshotSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '页面无障碍快照', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.snapshot(args))));

  server.registerTool('discover_urls', {
    title: '站点 URL 发现',
    description: '站点 URL 发现,爬取大站前先用它探明所有页面地址(走 sitemap.xml + robots.txt + 页面链接),不抓正文,速度快。',
    inputSchema: DiscoverUrlsSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '站点 URL 发现', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.discoverUrls(args))));

  server.registerTool('extract_article', {
    title: '提取正文',
    description: '提取当前页面的主正文内容并转为干净的 Markdown，自动剥离导航栏/广告/页脚等样板。适合新闻、博客、文档类页面的内容采集，比 get_page_content 更精炼省 token。若页面不是文章则返回失败。',
    inputSchema: ExtractArticleSchema,
    outputSchema: ResultEnvelope,
    annotations: { title: '提取正文', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } satisfies ToolAnnotations,
  }, wrap(async (args: unknown) => structured(await tools.extractArticle(args))));

  return server;
}

function createApp(): express.Application {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS：从 '*' 收紧到白名单。带 Origin 的请求一定来自浏览器页面，
  // 不在白名单直接 403（这也是 DNS rebinding 的第一道拦截）；
  // MCP 客户端（Claude Code / Codex）不带 Origin，走原路放行。
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) {
      if (!ALLOWED.origins.includes(origin)) {
        res.status(403).json({ error: 'Origin not allowed' });
        return;
      }
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
    }
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id');
    // 浏览器端要读会话 ID 才能续用会话，必须显式 expose
    res.header('Access-Control-Expose-Headers', 'mcp-session-id');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  // Rate limiter: 100 req/s per IP
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of requestCounts) {
      if (now > entry.resetAt) requestCounts.delete(ip);
    }
  }, 60 * 1000).unref();
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

  // 鉴权只挡 MCP 数据面；/health 留给 PM2/探活脚本，不含敏感信息
  app.use('/mcp', requireAuth);
  app.use('/connections', requireAuth);

  // Health
  app.get('/health', async (_req: Request, res: Response) => {
    const bm = getBrowserManager();
    const result: HealthCheckResult = {
      status: bm.isAlive() ? 'ok' : 'error',
      browserAlive: bm.isAlive(),
      uptime: Date.now() - startTime,
      // sessions = MCP 传输层会话数；browserSessions = 真正持有标签页的浏览器会话数。
      // 两者对不上就说明会话回收漏了(排查资源泄漏的第一手指标)。
      sessions: transports.size,
      browserSessions: bm.countSessions()
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
      let transport: NodeStreamableHTTPServerTransport;

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
        const eventStore = new BoundedEventStore();
        // 会话 ID 自己先生成：McpServer 要在 initialize 处理前就建好，
        // 提前定下 ID 才能让 44 个 handler 闭包捕获到正确的 sessionId。
        const newSessionId = randomUUID();
        transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          eventStore,
          // DNS rebinding 防护：拦住「恶意页面把域名解析到 127.0.0.1 后直连本服务」，
          // 否则任意网页都能驱动这台机器上**已登录**的浏览器
          enableDnsRebindingProtection: true,
          allowedHosts: ALLOWED.hosts,
          allowedOrigins: ALLOWED.origins,
          onsessioninitialized: (sid) => {
            transports.set(sid, { transport, lastAccess: Date.now() });
            console.log(`[Session] New: ${sid} (total: ${transports.size})`);
          },
          // SDK 原生钩子：客户端 DELETE 显式下线 → 立刻回收该会话的标签页
          onsessionclosed: (sid) => {
            releaseSession(sid);
            console.log(`[Session] Closed by client: ${sid}`);
          }
        });
        transport.onclose = () => {
          releaseSession(newSessionId);
          console.log(`[Session] Closed: ${newSessionId}`);
        };
        const mcpServer = createMcpServer(newSessionId);
        await mcpServer.connect(transport);
      } else {
        // No valid session + not initialize → reject
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session — initialize first' }, id: req.body?.id ?? null });
        return;
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

/** 当前正在监听的 HTTP server（listenWithRetry 每次重试会换一个实例，关闭时要关最新那个） */
let httpServer: ReturnType<express.Application['listen']> | null = null;

function listenWithRetry(app: express.Application, host: string, port: number, retries: number): void {
  const server = app.listen(port, host, () => {
    console.log('========================================');
    console.log(`  Claude Code MCP Browser Bridge v${SERVER_VERSION}`);
    console.log(`  http://${host}:${port}`);
    console.log(`  MCP: http://${host}:${port}/mcp`);
    console.log('========================================');
  });
  httpServer = server;
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.log(`[Server] Port ${port} in use, retrying in 2s...`);
      setTimeout(() => listenWithRetry(app, host, port, retries - 1), 2000);
    } else { console.error('[Server] Failed:', err.message); process.exit(1); }
  });
  // 注意：信号处理**不能**注册在这里 —— 每次 EADDRINUSE 重试都会再注册一份，
  // 一次 SIGINT 会并发触发 N 份 shutdown（各自 close 浏览器 + 各自埋一个 exit 定时器）。
  // 统一改到 installHttpShutdown()，进程内只注册一次。
}

/**
 * HTTP 常驻服务的优雅退出（PM2 restart / 升级 / 手动 Ctrl-C 都走这里）。
 * 关键点与 stdio 路径对齐：
 *  - shuttingDown 布尔防重入：SIGINT 后紧跟 SIGTERM 不会跑两遍回收；
 *  - 2 秒硬退出兜底里**先 SIGKILL chromium 再退**：close() 卡住时 process.exit 本身不杀浏览器，
 *    白等 5 秒然后留下孤儿进程正是要消灭的「进程堆积」；2 秒也与 stdio 保持一致，
 *    避免超过 PM2 kill_timeout 被 TerminateProcess 硬杀（那时任何钩子都来不及跑）。
 */
let shuttingDown = false;
function installHttpShutdown(): void {
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Server] Shutting down: ${reason}`);
    const hardExit = setTimeout(() => {
      console.error('[Server] close() timeout, SIGKILL chromium and force exit');
      try { getBrowserManager().killChromiumSync(); } catch { /* noop */ }
      process.exit(1);
    }, 2000);
    hardExit.unref?.();
    for (const [sid, entry] of transports) { try { entry.transport.close?.(); } catch { /* noop */ } releaseSession(sid); }
    try { await getBrowserManager().close(); } catch (e) { console.error('[Server] close error:', e); }
    // 不等连接排空：SSE 长连接会让 server.close() 的回调永远不触发
    try { httpServer?.close(); } catch { /* noop */ }
    process.exit(0);
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGHUP', () => { void shutdown('SIGHUP'); });
}

/**
 * 两种传输**共用**的进程级兜底 —— 原来只注册在 runStdio() 里。
 * HTTP 现在是 7x24 常驻生产路径（PM2 restart / 升级反复走），一旦异常退出，
 * chromium 变孤儿会一直持有 storage/user_data 的 profile 锁，下次启动直接失败。
 *
 * 说明：patchright 自己也在 process.on('exit') 里 taskkill 了浏览器进程树，
 * 实测大多数场景它已兜住；这里保留同名兜底是为了不依赖第三方内部实现，
 * 且与 stdio 路径保持完全一致的退出语义。killChromiumSync 幂等，重复执行无副作用。
 */
/**
 * 「目标已关闭」类协议错误 —— 属于**正常竞态**，不是 bug。
 *
 * patchright 内部会在新 frame/session 附着时重新下发拦截指令
 * (CRNetworkManager.setRequestInterception → _forEachSession → Network.setCacheDisabled)。
 * 这条链路上的 Promise **不属于任何调用方** —— 我们这边所有 route/unroute 都带了 .catch()，
 * 照样兜不住它。只要在它遍历 session 的瞬间有一张标签页被关掉(用户手动关、页面自己 window.close、
 * popup 生命周期结束…)，就会抛出一条无主的 ProtocolError，直接进 unhandledRejection。
 *
 * 原来这里无差别 process.exit(1)，后果被严重放大：
 * 关掉一张标签页 → 整个常驻服务退出 → PM2 拉起新进程 → **浏览器连同全部登录态一起没了**。
 * 用户观感就是「浏览器总是自动关闭」，而且越用越频繁(标签页开关越多，撞上竞态的概率越大)。
 *
 * 所以这里只对**这一类**已知良性错误放行(记一条 warn 便于观察频次)，
 * 其余未捕获拒绝仍然 exit(1) 快速失败 —— 不掩盖真 bug。
 * uncaughtException 保持原样退出：那类错误可能让进程处于不一致状态，继续跑更危险。
 */
const BENIGN_CLOSED_TARGET =
  /(target|session|page|browser|context)\s+closed|已关闭|Execution context was destroyed|frame was detached/i;

let guardsInstalled = false;
function installProcessGuards(): void {
  if (guardsInstalled) return;
  guardsInstalled = true;
  // ★ 最后一道闸：Node 退出前同步 SIGKILL chromium，无论怎么退都执行
  process.on('exit', () => {
    try { getBrowserManager().killChromiumSync(); } catch { /* exit handler 不能抛 */ }
  });
  process.on('uncaughtException', (err) => {
    console.error('[Server] uncaughtException:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
    if (BENIGN_CLOSED_TARGET.test(msg)) {
      // 不退出：一张标签页的关闭竞态不该赔上整个浏览器和登录态
      console.warn('[Server] 忽略已关闭目标的协议错误(不退出):', msg.split('\n')[0]);
      return;
    }
    console.error('[Server] unhandledRejection:', reason);
    process.exit(1);
  });
}

/**
 * 从 `netstat -ano` 的输出里**精确**挑出监听 `port` 的 PID。
 *
 * 原实现是 `netstat -ano | findstr :${port}` —— findstr 是**子串匹配**：
 * 有人监听 127.0.0.1:32110 时 `findstr :3211` 照样命中该行，行尾正则把它的 PID 抠出来，
 * 于是 killPortProcess(3211) 会 `taskkill /F /T` 掉一个**完全无关**的进程连同它整棵进程树。
 * 端口越短命中面越大（:80 能命中 :8080/:8000/:1080…），/T 又把误杀半径放大到子进程树。
 *
 * 这里改成按列解析，同时要求三件事全部成立才收下这个 PID：
 *   1) 协议列以 TCP 开头（兼容部分 Windows 把 IPv6 行标成 TCPv6；
 *      UDP 行只有 4 列、没有状态列，被下面的列数/状态判断天然挡掉）
 *   2) 本地地址的**端口字段**严格等于 port —— 取最后一个 ':' 之后的部分做数值比较，
 *      IPv6 的 `[::1]:3215` / `[::]:3215` 同样正确（不会被 `::` 里的冒号带偏）
 *   3) 状态是 LISTENING —— 否则一条源端口恰好是 3215 的**出站连接**也会被当成占用者杀掉
 *
 * 不加 `-p TCP` 过滤：实测 Windows 的 `netstat -ano -p TCP` 只出 IPv4 行，
 * 绑在 `[::1]` / `[::]` 上的监听会整个看不见 —— 那样端口被 IPv6 占用时清不掉，
 * 反而比原实现更糟。全量取回来在这里自己判协议列。
 *
 * 非英文 Windows 的 netstat 只本地化表头，状态值仍是 ASCII 的 LISTENING；
 * 表头乱码行过不了「第一列以 TCP 开头」这关，被自然跳过。
 */
function parseWindowsListenerPids(netstatOutput: string, port: number): Set<string> {
  const pids = new Set<string>();
  for (const line of netstatOutput.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // 期望列序: Proto | Local Address | Foreign Address | State | PID
    if (cols.length < 5) continue;
    const [proto, local, , state, pid] = cols;
    if (!proto?.toUpperCase().startsWith('TCP')) continue;
    if (state?.toUpperCase() !== 'LISTENING') continue;
    if (!local || !pid || !/^\d+$/.test(pid)) continue;
    const sep = local.lastIndexOf(':');
    if (sep < 0) continue;
    if (Number(local.slice(sep + 1)) !== port) continue;
    pids.add(pid);
  }
  return pids;
}

async function killPortProcess(port: number): Promise<void> {
  // 端口先做整数校验再进 shell 命令：既挡住命令注入，也顺手挡住 NaN 拼出的畸形命令
  if (!Number.isInteger(port) || port < 1 || port > 65535) return;
  try {
    const { execSync } = await import('child_process');
    if (process.platform === 'win32') {
      // 不再用 findstr 预筛（子串匹配会把 :32110 当成 :3211），整份输出交给精确解析。
      // 取全量表就有了旧实现没有的失败模式：连接数极多的机器（数万条 TIME_WAIT）会超过
      // execSync 默认 1 MiB 的 maxBuffer 抛 ENOBUFS，端口清理直接失效 —— 显式放宽到 16 MiB。
      const output = execSync('netstat -ano', { encoding: 'utf-8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
      for (const pid of parseWindowsListenerPids(output, port)) {
        if (pid === String(process.pid)) continue;
        // /T 连同**子进程树**一起杀：旧 server 被 TerminateProcess 硬杀时它的 exit 钩子
        // 一个都不会跑，不带 /T 就要靠 chromium 自己发现 CDP 管道断开才退出；
        // 浏览器卡住（模态框 / 渲染进程无响应）时就会留下持有 profile 锁的孤儿。
        // 前提是 PID 挑得准 —— 挑错了 /T 会把误杀面从一个进程放大到一整棵树。
        try { execSync(`taskkill /F /T /PID ${pid}`, { timeout: 5000 }); } catch {}
      }
    } else {
      // lsof 的 -i tcp:PORT 是按端口号精确匹配（不是子串），再加 -sTCP:LISTEN
      // 排除「源端口恰好等于 port 的出站连接」，与 Windows 分支语义对齐。
      const output = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf-8', timeout: 5000 });
      for (const pid of output.trim().split('\n')) {
        if (pid && /^\d+$/.test(pid.trim()) && pid.trim() !== String(process.pid)) {
          try { execSync(`kill -9 ${pid.trim()}`, { timeout: 5000 }); } catch {}
        }
      }
    }
  } catch {}
}

/** stdio 传输入口：供 Claude Code 原生 MCP 客户端使用
 *
 * 退出路径（防止 SSH 断开 / 客户端崩 → stdio 进程变孤儿 → chromium 累积爆内存）：
 *   1. SIGINT / SIGTERM / SIGHUP：父进程主动通知 → 优雅 close → SIGKILL chromium 兜底
 *   2. stdin 'end'/'close'：MCP 跑在 stdio 上，stdin 关闭 = 客户端走了
 *   3. ppid 轮询（1s）：SSH 强断时信号不一定到，靠主动检测 ppid 变化（被 reparent）
 *   4. stdout 'error'(EPIPE)：向已关闭客户端写日志时触发，兜底
 *   5. process.on('exit') 同步钩子：Node 真正退出前的**最后一道闸**，无论 exit() / 异常 /
 *      事件循环空都会触发；这里直接 SIGKILL chromium pid，**保证 chromium 不会被 reparent**。
 *      唯一覆盖不到的是 node 进程本身被 SIGKILL —— 那只能靠 cron 兜底了。
 */
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
  console.error(`[Server] Claude Code MCP Browser v${SERVER_VERSION} ready on stdio (pid=${process.pid} ppid=${process.ppid})`);

  // ★ 最后一道闸(exit / uncaughtException / unhandledRejection)已提到 main() 里的
  // installProcessGuards()，两种传输共用；stdio 侧行为与改造前完全一致。

  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[Server] stdio shutdown: ${reason}`);
    // 2 秒兜底：close() 卡住就直接 SIGKILL chromium pid 然后退
    // 上次 fix 给了 5 秒,但 process.exit(1) 不杀 chromium —— 那个 5 秒等于白等
    const hardExit = setTimeout(() => {
      console.error('[Server] close() timeout, SIGKILL chromium and force exit');
      try { getBrowserManager().killChromiumSync(); } catch { /* noop */ }
      process.exit(1);
    }, 2000);
    hardExit.unref?.();
    try {
      await getBrowserManager().close();
    } catch (e) {
      console.error('[Server] close error:', e);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGHUP', () => { void shutdown('SIGHUP'); });

  // stdin 关闭 = MCP 客户端断开
  process.stdin.on('end', () => { void shutdown('stdin end'); });
  process.stdin.on('close', () => { void shutdown('stdin close'); });
  process.stdin.on('error', (err) => { void shutdown(`stdin error: ${err.message}`); });

  // stdout EPIPE 兜底（向已关闭的客户端写时触发）
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') void shutdown('stdout EPIPE');
  });

  // ppid 轮询：1 秒一次，捕获 SSH 强断后被 reparent 的情况
  // 上次 fix 是 3 秒,SSH 强断到检测到 + close 5 秒 = 最多 8 秒 chromium 还活着 → 必然孤儿
  // 改 1 秒后窗口期 ≤ 3 秒,加上 exit 钩子做最后兜底 → 不会泄漏
  const initialPpid = process.ppid;
  const ppidCheck = setInterval(() => {
    const currentPpid = process.ppid;
    if (currentPpid !== initialPpid) {
      clearInterval(ppidCheck);
      void shutdown(`parent gone (ppid ${initialPpid} -> ${currentPpid})`);
    }
  }, 1000);
  ppidCheck.unref?.();
}

/** HTTP 传输入口：Express + Streamable HTTP */
async function runHttp(): Promise<void> {
  // fail-fast：绑非回环地址等于把「已登录浏览器的控制权」放到网络上，
  // 没配 token 就直接拒绝启动，防止误开裸端口
  if (!isLoopbackHost(HOST) && !AUTH_TOKEN) {
    console.error('========================================');
    console.error(`[Server] 拒绝启动：HOST=${HOST} 不是回环地址，但未设置 MCP_AUTH_TOKEN。`);
    console.error('[Server] 浏览器里存着已登录的会话，裸端口等于把控制权交出去。');
    console.error('[Server] 处理方式二选一：');
    console.error('[Server]   1) 只本机用 —— 删掉 HOST（默认 127.0.0.1）');
    console.error('[Server]   2) 跨机共享 —— 设置 MCP_AUTH_TOKEN=<足够长的随机串>，客户端带 Authorization: Bearer <token>');
    console.error('========================================');
    process.exit(1);
  }
  await killPortProcess(PORT);
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('[Server] Starting browser...');
  try { await getBrowserManager().getContext(); console.log('[Server] Browser ready'); }
  catch { console.error('[Server] Browser start failed, will retry on first request'); }
  const app = createApp();
  console.log(`[Server] auth=${AUTH_TOKEN ? 'bearer' : 'off (loopback only)'} allowedHosts=${ALLOWED.hosts.join(',')}`);
  installHttpShutdown();
  listenWithRetry(app, HOST, PORT, 3);
}

async function main(): Promise<void> {
  // 进程级兜底两种传输共用，且必须在启动浏览器**之前**装好
  installProcessGuards();
  if (STDIO) {
    await runStdio();
  } else {
    await runHttp();
  }
}

main().catch((error) => { console.error('[Server] Startup failed:', error); process.exit(1); });
