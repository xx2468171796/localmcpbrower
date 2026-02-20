/**
 * Express + Streamable HTTP + MCP 服务入口
 * Cursor 版本
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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
  NewTabSchema, TabIndexSchema, InterceptRequestsSchema
} from './schemas.js';

const PORT = parseInt(process.env['PORT'] ?? '3211', 10);
const startTime = Date.now();

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

// Helper to wrap tool results
function text(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'cursor-mcp-bridge', version: '1.0.0' });

  // === Navigation ===
  server.tool('navigate', '跳转至指定网址', NavigateSchema.shape, async (args) => text(await tools.navigate(args)));
  server.tool('set_viewport', '设置浏览器视口大小', SetViewportSchema.shape, async (args) => text(await tools.setViewport(args)));
  server.tool('go_back', '浏览器后退', {}, async () => text(await tools.goBack()));
  server.tool('go_forward', '浏览器前进', {}, async () => text(await tools.goForward()));

  // === Interaction ===
  server.tool('click', '点击页面元素', ClickSchema.shape, async (args) => text(await tools.click(args)));
  server.tool('type', '在输入框中输入文本', TypeSchema.shape, async (args) => text(await tools.type(args)));
  server.tool('hover', '悬停在元素上', HoverSchema.shape, async (args) => text(await tools.hover(args)));
  server.tool('scroll', '滚动页面', ScrollSchema.shape, async (args) => text(await tools.scroll(args)));
  server.tool('select_option', '选择下拉选项', SelectOptionSchema.shape, async (args) => text(await tools.selectOption(args)));
  server.tool('fill_form', '批量填写表单', FillFormSchema.shape, async (args) => text(await tools.fillForm(args)));
  server.tool('keyboard_press', '按下键盘按键(Enter/Tab/Escape等)', KeyboardPressSchema.shape, async (args) => text(await tools.keyboardPress(args)));
  server.tool('drag_and_drop', '拖拽元素到目标位置', DragAndDropSchema.shape, async (args) => text(await tools.dragAndDrop(args)));
  server.tool('file_upload', '上传文件到input[type=file]', FileUploadSchema.shape, async (args) => text(await tools.fileUpload(args)));

  // === Observation ===
  server.tool('take_screenshot', '截取当前页面截图(返回base64图片)', ScreenshotSchema.shape, async (args) => {
    const result = await tools.takeScreenshot(args);
    if (result.success && result.data.base64) {
      return { content: [
        { type: 'image' as const, data: result.data.base64, mimeType: 'image/png' as const },
        { type: 'text' as const, text: JSON.stringify({ success: true, data: { path: result.data.path, fullPage: result.data.fullPage } }) }
      ] };
    }
    return text(result);
  });
  server.tool('get_console_logs', '获取页面console输出', {}, async () => text(await tools.getConsoleLogs()));
  server.tool('get_network', '获取网络请求状态', {}, async () => text(await tools.getNetwork()));
  server.tool('execute_js', '执行自定义JavaScript', ExecuteJsSchema.shape, async (args) => text(await tools.executeJs(args)));
  server.tool('wait_for_selector', '等待元素出现', WaitForSelectorSchema.shape, async (args) => text(await tools.waitForSelector(args)));

  // === Content extraction ===
  server.tool('get_element_text', '获取元素文本内容', GetElementTextSchema.shape, async (args) => text(await tools.getElementText(args)));
  server.tool('get_element_attribute', '获取元素属性值', GetElementAttributeSchema.shape, async (args) => text(await tools.getElementAttribute(args)));
  server.tool('get_page_content', '获取页面内容(HTML/文本)', GetPageContentSchema.shape, async (args) => text(await tools.getPageContent(args)));
  server.tool('get_cookies', '获取Cookie', GetCookiesSchema.shape, async (args) => text(await tools.getCookies(args)));
  server.tool('set_cookies', '设置Cookie', SetCookiesSchema.shape, async (args) => text(await tools.setCookies(args)));

  // === Export & report ===
  server.tool('pdf_export', '导出页面为PDF', PdfExportSchema.shape, async (args) => text(await tools.pdfExport(args)));
  server.tool('generate_page_report', '生成页面分析报告', PageReportSchema.shape, async (args) => text(await tools.generatePageReport(args)));

  // === Multi-tab ===
  server.tool('list_tabs', '列出所有标签页', {}, async () => text(await tools.listTabs()));
  server.tool('new_tab', '打开新标签页', NewTabSchema.shape, async (args) => text(await tools.newTab(args)));
  server.tool('switch_tab', '切换到指定标签页', TabIndexSchema.shape, async (args) => text(await tools.switchTab(args)));
  server.tool('close_tab', '关闭指定标签页', TabIndexSchema.shape, async (args) => text(await tools.closeTab(args)));

  // === Network intercept ===
  server.tool('intercept_requests', '拦截/修改网络请求', InterceptRequestsSchema.shape, async (args) => text(await tools.interceptRequests(args)));

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
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        const entry = transports.get(sessionId)!;
        entry.lastAccess = Date.now();
        transport = entry.transport;
      } else if (!sessionId && isInitializeRequest(req.body)) {
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
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request' }, id: null });
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

function listenWithRetry(app: express.Application, host: string, port: number, retries: number): void {
  const server = app.listen(port, host, () => {
    console.log('========================================');
    console.log(`  Cursor MCP Browser Bridge v1.0.0`);
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
    const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf-8', timeout: 5000 });
    for (const line of output.trim().split('\n')) {
      const pid = line.trim().split(/\s+/).pop();
      if (pid && pid !== '0' && pid !== String(process.pid)) {
        try { execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 }); } catch {}
      }
    }
  } catch {}
}

async function main(): Promise<void> {
  await killPortProcess(PORT);
  await new Promise(resolve => setTimeout(resolve, 1000));
  console.log('[Server] Starting browser...');
  try { await getBrowserManager().getContext(); console.log('[Server] Browser ready'); }
  catch (error) { console.error('[Server] Browser start failed, will retry on first request'); }
  const app = createApp();
  listenWithRetry(app, process.env['HOST'] ?? '0.0.0.0', PORT, 3);
}

main().catch((error) => { console.error('[Server] Startup failed:', error); process.exit(1); });
