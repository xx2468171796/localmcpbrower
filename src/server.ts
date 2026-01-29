/**
 * Express + SSE + MCP 服务入口
 * @description 提供 SSE 端点，处理 MCP 协议通信
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { getBrowserManager } from './browser.js';
import * as tools from './tools.js';
import type { HealthCheckResult } from './types.js';
import {
  NavigateSchema,
  ClickSchema,
  TypeSchema,
  ScreenshotSchema,
  ExecuteJsSchema
} from './schemas.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const HEARTBEAT_INTERVAL = parseInt(process.env['HEARTBEAT_INTERVAL'] ?? '30000', 10);

/** 服务启动时间 */
const startTime = Date.now();

/** 创建 MCP 服务器 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'windsurf-mcp-bridge',
    version: '1.0.0'
  });

  // 注册 navigate 工具
  server.tool('navigate', '跳转至指定网址', NavigateSchema.shape, async (args) => {
    const result = await tools.navigate(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 click 工具
  server.tool('click', '点击页面元素，支持自动滚动到视图内', ClickSchema.shape, async (args) => {
    const result = await tools.click(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 type 工具
  server.tool('type', '在输入框中输入文本', TypeSchema.shape, async (args) => {
    const result = await tools.type(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 take_screenshot 工具
  server.tool('take_screenshot', '截取当前页面截图', ScreenshotSchema.shape, async (args) => {
    const result = await tools.takeScreenshot(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 get_console_logs 工具
  server.tool('get_console_logs', '获取页面所有 console 输出', {}, async () => {
    const result = await tools.getConsoleLogs();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 get_network 工具
  server.tool('get_network', '获取网络请求状态', {}, async () => {
    const result = await tools.getNetwork();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 execute_js 工具
  server.tool('execute_js', '在当前页面执行自定义 JavaScript', ExecuteJsSchema.shape, async (args) => {
    const result = await tools.executeJs(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  return server;
}

/** 创建 Express 应用 */
function createApp(): express.Application {
  const app = express();

  // CORS 中间件
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  app.use(express.json());

  // 健康检查端点
  app.get('/health', async (_req: Request, res: Response) => {
    const browserManager = getBrowserManager();
    const result: HealthCheckResult = {
      status: browserManager.isAlive() ? 'ok' : 'error',
      browserAlive: browserManager.isAlive(),
      uptime: Date.now() - startTime
    };
    res.json(result);
  });

  // SSE 端点 - MCP 连接
  const mcpServer = createMcpServer();
  let currentTransport: SSEServerTransport | null = null;

  app.get('/sse', async (req: Request, res: Response) => {
    console.log('[SSE] 新客户端连接');

    // 创建 SSE Transport
    const transport = new SSEServerTransport('/messages', res);
    currentTransport = transport;

    // 连接 MCP 服务器
    await mcpServer.connect(transport);

    // 客户端断开连接
    req.on('close', () => {
      console.log('[SSE] 客户端断开连接');
      currentTransport = null;
    });
  });

  // 消息接收端点 - 处理来自客户端的 MCP 消息
  app.post('/messages', async (req: Request, res: Response) => {
    if (!currentTransport) {
      res.status(503).json({ error: 'No active SSE connection' });
      return;
    }
    
    try {
      await currentTransport.handlePostMessage(req, res);
    } catch (error) {
      console.error('[SSE] 消息处理错误:', error);
      res.status(500).json({ error: 'Message handling failed' });
    }
  });

  return app;
}

/** 优雅退出 */
async function gracefulShutdown(): Promise<void> {
  console.log('[Server] 正在关闭...');
  try {
    await getBrowserManager().close();
    console.log('[Server] 浏览器已关闭');
  } catch (error) {
    console.error('[Server] 关闭浏览器失败:', error);
  }
  process.exit(0);
}

/** 启动服务 */
async function main(): Promise<void> {
  // 注册退出信号处理
  process.on('SIGTERM', gracefulShutdown);
  process.on('SIGINT', gracefulShutdown);

  // 预热浏览器
  console.log('[Server] 正在启动浏览器...');
  await getBrowserManager().getContext();
  console.log('[Server] 浏览器已就绪');

  // 启动 HTTP 服务
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`[Server] MCP Bridge 已启动: http://localhost:${PORT}`);
    console.log(`[Server] SSE 端点: http://localhost:${PORT}/sse`);
    console.log(`[Server] 健康检查: http://localhost:${PORT}/health`);
  });
}

main().catch((error) => {
  console.error('[Server] 启动失败:', error);
  process.exit(1);
});
