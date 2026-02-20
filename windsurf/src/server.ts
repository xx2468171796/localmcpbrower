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
  PageReportSchema, SetViewportSchema
} from './schemas.js';

const PORT = parseInt(process.env['PORT'] ?? '3211', 10);
const startTime = Date.now();

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'windsurf-mcp-bridge', version: '1.0.0' });

  server.tool('navigate', '跳转至指定网址', NavigateSchema.shape, async (args) => {
    const result = await tools.navigate(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('click', '点击页面元素', ClickSchema.shape, async (args) => {
    const result = await tools.click(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('type', '在输入框中输入文�?, TypeSchema.shape, async (args) => {
    const result = await tools.type(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('take_screenshot', '截取当前页面截图', ScreenshotSchema.shape, async (args) => {
    const result = await tools.takeScreenshot(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('get_console_logs', '获取页面 console 输出', {}, async () => {
    const result = await tools.getConsoleLogs();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('get_network', '获取网络请求状�?, {}, async () => {
    const result = await tools.getNetwork();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('execute_js', '执行自定�?JavaScript', ExecuteJsSchema.shape, async (args) => {
    const result = await tools.executeJs(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('scroll', '页面滚动', ScrollSchema.shape, async (args) => {
    const result = await tools.scroll(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('go_back', '浏览器后退', {}, async () => {
    const result = await tools.goBack();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('go_forward', '浏览器前�?, {}, async () => {
    const result = await tools.goForward();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('hover', '鼠标悬停', HoverSchema.shape, async (args) => {
    const result = await tools.hover(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('wait_for_selector', '等待元素出现', WaitForSelectorSchema.shape, async (args) => {
    const result = await tools.waitForSelector(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('get_element_text', '获取元素文本', GetElementTextSchema.shape, async (args) => {
    const result = await tools.getElementText(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('get_element_attribute', '获取元素属�?, GetElementAttributeSchema.shape, async (args) => {
    const result = await tools.getElementAttribute(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('select_option', '选择下拉框选项', SelectOptionSchema.shape, async (args) => {
    const result = await tools.selectOption(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('fill_form', '批量填充表单', FillFormSchema.shape, async (args) => {
    const result = await tools.fillForm(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('get_page_content', '获取页面内容', GetPageContentSchema.shape, async (args) => {
    const result = await tools.getPageContent(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('pdf_export', '导出页面为PDF', PdfExportSchema.shape, async (args) => {
    const result = await tools.pdfExport(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('get_cookies', '获取Cookie', GetCookiesSchema.shape, async (args) => {
    const result = await tools.getCookies(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('set_cookies', '设置Cookie', SetCookiesSchema.shape, async (args) => {
    const result = await tools.setCookies(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('generate_page_report', '生成页面分析报告', PageReportSchema.shape, async (args) => {
    const result = await tools.generatePageReport(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('set_viewport', '设置浏览器窗口大�?, SetViewportSchema.shape, async (args) => {
    const result = await tools.setViewport(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  return server;
}

function createApp(): express.Application {
  const app = express();

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });
  app.use(express.json());

  app.get('/health', async (_req: Request, res: Response) => {
    const browserManager = getBrowserManager();
    const result: HealthCheckResult = {
      status: browserManager.isAlive() ? 'ok' : 'error',
      browserAlive: browserManager.isAlive(),
      uptime: Date.now() - startTime
    };
    res.json(result);
  });

  // Session-based transport management
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};
  let requestCount = 0;

  app.get('/connections', async (_req: Request, res: Response) => {
    res.json({ mode: 'session', sessions: Object.keys(transports).length, requestCount, uptime: Math.floor((Date.now() - startTime) / 1000) + 's' });
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    requestCount++;
    console.log(`[MCP] POST请求 #${requestCount}`);
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request - create new transport + session
        const eventStore = new InMemoryEventStore();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          eventStore,
          onsessioninitialized: (newSessionId) => {
            transports[newSessionId] = transport;
            console.log(`[MCP] New session: ${newSessionId}`);
          }
        });

        transport.onclose = () => {
          const sid = Object.entries(transports).find(([_, t]) => t === transport)?.[0];
          if (sid) {
            delete transports[sid];
            console.log(`[MCP] Session closed: ${sid}`);
          }
        };

        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
      } else {
        res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session ID or not an initialize request' }, id: null });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] 请求处理错误:', error);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });

  app.get('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports[sessionId]) {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } else {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session' }, id: null });
    }
  });

  app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports[sessionId]) {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } else {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session' }, id: null });
    }
  });

  return app;
}

async function gracefulShutdown(): Promise<void> {
  console.log('[Server] 正在关闭...');
  try { await getBrowserManager().close(); console.log('[Server] 浏览器已关闭'); }
  catch (error) { console.error('[Server] 关闭浏览器失�?', error); }
  process.exit(0);
}

async function killPortProcess(port: number): Promise<boolean> {
  const { execSync } = await import('child_process');
  try {
    const output = execSync(`netstat -ano | findstr ":${port}" | findstr "LISTENING"`, { encoding: 'utf-8', timeout: 5000 });
    const lines = output.trim().split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[parts.length - 1];
      if (pid && pid !== '0' && pid !== String(process.pid)) {
        console.log(`[Server] 发现端口 ${port} �?PID ${pid} 占用，正在清�?..`);
        try { execSync(`taskkill /PID ${pid} /F`, { timeout: 5000 }); console.log(`[Server] 已杀�?PID ${pid}`); }
        catch { /* 进程可能已退�?*/ }
      }
    }
    return true;
  } catch { return false; }
}

function listenWithRetry(app: express.Application, host: string, port: number, maxRetries: number = 3): void {
  let attempt = 0;
  function tryListen(): void {
    attempt++;
    const server = app.listen(port, host, () => {
      console.log(`[Server] MCP Bridge 已启�? http://${host}:${port}`);
      console.log(`[Server] MCP 端点: http://${host}:${port}/mcp`);
      console.log(`[Server] 健康检�? http://${host}:${port}/health`);
    });
    server.on('error', async (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && attempt <= maxRetries) {
        console.warn(`[Server] 端口 ${port} 被占�?(尝试 ${attempt}/${maxRetries})，正在清�?..`);
        await killPortProcess(port);
        setTimeout(tryListen, attempt * 2000);
      } else {
        console.error(`[Server] 无法启动服务:`, err.message);
        process.exit(1);
      }
    });
  }
  tryListen();
}

async function main(): Promise<void> {
  process.on('uncaughtException', (err) => { console.error('[Server] 未捕获异�?', err.message); });
  process.on('unhandledRejection', (reason) => { console.error('[Server] 未处理的 Promise 拒绝:', reason); });
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  await killPortProcess(PORT);
  await new Promise(resolve => setTimeout(resolve, 1000));

  console.log('[Server] 正在启动浏览�?..');
  try { await getBrowserManager().getContext(); console.log('[Server] 浏览器已就绪'); }
  catch (error) { console.error('[Server] 浏览器启动失败，将在首次请求时重�?', error); }

  const app = createApp();
  const HOST = process.env['HOST'] ?? '0.0.0.0';
  listenWithRetry(app, HOST, PORT, 3);
}

main().catch((error) => { console.error('[Server] 启动失败:', error); process.exit(1); });
