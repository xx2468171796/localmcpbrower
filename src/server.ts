/**
 * Express + Streamable HTTP + MCP 服务入口
 * @description 提供 Streamable HTTP 端点，处理 MCP 协议通信
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getBrowserManager } from './browser.js';
import * as tools from './tools.js';
import type { HealthCheckResult } from './types.js';
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

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30分钟会话超时

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

  // 注册 scroll 工具
  server.tool('scroll', '页面滚动到指定位置或元素', ScrollSchema.shape, async (args) => {
    const result = await tools.scroll(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 go_back 工具
  server.tool('go_back', '浏览器后退', {}, async () => {
    const result = await tools.goBack();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 go_forward 工具
  server.tool('go_forward', '浏览器前进', {}, async () => {
    const result = await tools.goForward();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 hover 工具
  server.tool('hover', '鼠标悬停在元素上', HoverSchema.shape, async (args) => {
    const result = await tools.hover(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 wait_for_selector 工具
  server.tool('wait_for_selector', '等待元素出现/消失/可见/隐藏', WaitForSelectorSchema.shape, async (args) => {
    const result = await tools.waitForSelector(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 get_element_text 工具
  server.tool('get_element_text', '获取元素的文本内容', GetElementTextSchema.shape, async (args) => {
    const result = await tools.getElementText(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 get_element_attribute 工具
  server.tool('get_element_attribute', '获取元素的属性值', GetElementAttributeSchema.shape, async (args) => {
    const result = await tools.getElementAttribute(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 select_option 工具
  server.tool('select_option', '选择下拉框选项', SelectOptionSchema.shape, async (args) => {
    const result = await tools.selectOption(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 fill_form 工具
  server.tool('fill_form', '批量填充表单字段', FillFormSchema.shape, async (args) => {
    const result = await tools.fillForm(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 get_page_content 工具
  server.tool('get_page_content', '获取页面HTML或纯文本内容', GetPageContentSchema.shape, async (args) => {
    const result = await tools.getPageContent(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 pdf_export 工具
  server.tool('pdf_export', '导出页面为PDF文件', PdfExportSchema.shape, async (args) => {
    const result = await tools.pdfExport(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 get_cookies 工具
  server.tool('get_cookies', '获取页面Cookie', GetCookiesSchema.shape, async (args) => {
    const result = await tools.getCookies(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 set_cookies 工具
  server.tool('set_cookies', '设置Cookie', SetCookiesSchema.shape, async (args) => {
    const result = await tools.setCookies(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 generate_page_report 工具
  server.tool('generate_page_report', '生成页面分析报告(链接/表单/图片统计)', PageReportSchema.shape, async (args) => {
    const result = await tools.generatePageReport(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 注册 set_viewport 工具
  server.tool('set_viewport', '设置浏览器窗口大小(width: 320-7680, height: 240-4320)', SetViewportSchema.shape, async (args) => {
    const result = await tools.setViewport(args);
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

  // 存储最新报告
  let latestReport: unknown = null;

  // 报告数据API
  app.get('/report/data', async (_req: Request, res: Response) => {
    res.json(latestReport || { error: 'No report generated yet' });
  });

  // 更新报告数据
  app.post('/report/update', express.json(), async (req: Request, res: Response) => {
    latestReport = req.body;
    res.json({ success: true });
  });

  // 报告页面
  app.get('/report', async (_req: Request, res: Response) => {
    res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MCP Page Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; padding: 20px; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { color: #58a6ff; margin-bottom: 20px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; margin-bottom: 16px; }
    .card h2 { color: #8b949e; font-size: 14px; text-transform: uppercase; margin-bottom: 12px; }
    .stat { display: inline-block; margin-right: 24px; margin-bottom: 8px; }
    .stat-value { font-size: 32px; font-weight: bold; color: #58a6ff; }
    .stat-label { font-size: 12px; color: #8b949e; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
    .issue { padding: 12px; background: #1c2128; border-radius: 6px; margin-bottom: 8px; border-left: 3px solid #f85149; }
    .issue.warning { border-left-color: #d29922; }
    .issue.info { border-left-color: #58a6ff; }
    .refresh-btn { background: #238636; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .refresh-btn:hover { background: #2ea043; }
    .no-data { text-align: center; padding: 60px; color: #8b949e; }
    .url { color: #58a6ff; word-break: break-all; }
    .time { color: #8b949e; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>📊 MCP Page Report</h1>
    <button class="refresh-btn" onclick="loadReport()">🔄 Refresh Report</button>
    <div id="content" class="no-data">Loading...</div>
  </div>
  <script>
    async function loadReport() {
      try {
        const res = await fetch('/report/data');
        const data = await res.json();
        if (data.error) {
          document.getElementById('content').innerHTML = '<div class="no-data">No report yet. Use generate_page_report tool first.</div>';
          return;
        }
        renderReport(data);
      } catch (e) {
        document.getElementById('content').innerHTML = '<div class="no-data">Error loading report</div>';
      }
    }
    
    function renderReport(r) {
      const d = r.data || r;
      let issues = [];
      
      // 检查问题
      if (d.images && d.images.withoutAlt > 0) {
        issues.push({ type: 'warning', text: d.images.withoutAlt + ' images missing alt attribute (accessibility issue)' });
      }
      if (d.links && d.links.external > d.links.internal) {
        issues.push({ type: 'info', text: 'More external links (' + d.links.external + ') than internal (' + d.links.internal + ')' });
      }
      if (d.stats && d.stats.scripts > 30) {
        issues.push({ type: 'warning', text: 'High script count (' + d.stats.scripts + ') may affect performance' });
      }
      
      let html = '<div class="card"><h2>Page Info</h2>';
      html += '<p class="url">' + (d.url || 'N/A') + '</p>';
      html += '<p><strong>' + (d.title || 'No title') + '</strong></p>';
      html += '<p class="time">' + (d.timestamp || '') + '</p></div>';
      
      html += '<div class="grid">';
      
      if (d.stats) {
        html += '<div class="card"><h2>📦 Elements</h2>';
        html += '<div class="stat"><div class="stat-value">' + d.stats.elements + '</div><div class="stat-label">Total Elements</div></div>';
        html += '<div class="stat"><div class="stat-value">' + d.stats.scripts + '</div><div class="stat-label">Scripts</div></div>';
        html += '<div class="stat"><div class="stat-value">' + d.stats.styles + '</div><div class="stat-label">Styles</div></div></div>';
      }
      
      if (d.links) {
        html += '<div class="card"><h2>🔗 Links</h2>';
        html += '<div class="stat"><div class="stat-value">' + d.links.total + '</div><div class="stat-label">Total</div></div>';
        html += '<div class="stat"><div class="stat-value">' + d.links.internal + '</div><div class="stat-label">Internal</div></div>';
        html += '<div class="stat"><div class="stat-value">' + d.links.external + '</div><div class="stat-label">External</div></div></div>';
      }
      
      if (d.forms) {
        html += '<div class="card"><h2>📝 Forms</h2>';
        html += '<div class="stat"><div class="stat-value">' + d.forms.total + '</div><div class="stat-label">Forms</div></div>';
        html += '<div class="stat"><div class="stat-value">' + d.forms.inputs + '</div><div class="stat-label">Inputs</div></div>';
        html += '<div class="stat"><div class="stat-value">' + d.forms.buttons + '</div><div class="stat-label">Buttons</div></div></div>';
      }
      
      if (d.images) {
        html += '<div class="card"><h2>🖼️ Images</h2>';
        html += '<div class="stat"><div class="stat-value">' + d.images.total + '</div><div class="stat-label">Total</div></div>';
        html += '<div class="stat"><div class="stat-value">' + d.images.withAlt + '</div><div class="stat-label">With Alt</div></div>';
        html += '<div class="stat"><div class="stat-value" style="color:#f85149">' + d.images.withoutAlt + '</div><div class="stat-label">Missing Alt</div></div></div>';
      }
      
      html += '</div>';
      
      if (issues.length > 0) {
        html += '<div class="card"><h2>⚠️ Issues Found (' + issues.length + ')</h2>';
        issues.forEach(i => {
          html += '<div class="issue ' + i.type + '">' + i.text + '</div>';
        });
        html += '</div>';
      }
      
      document.getElementById('content').innerHTML = html;
    }
    
    loadReport();
    setInterval(loadReport, 5000);
  </script>
</body>
</html>`);
  });

  // ========== Streamable HTTP 传输 (无状态模式 - 官方推荐) ==========
  // 创建全局的transport和server实例
  const mcpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined  // undefined = 无状态服务器
  });
  const mcpServer = createMcpServer();
  
  // 请求计数
  let requestCount = 0;

  // 连接状态端点
  app.get('/connections', async (_req: Request, res: Response) => {
    res.json({ 
      mode: 'stateless',
      requestCount,
      uptime: Math.floor((Date.now() - startTime) / 1000) + 's'
    });
  });

  // Streamable HTTP 端点 - 无状态模式
  app.post('/mcp', async (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    requestCount++;
    console.log(`[MCP] POST请求 #${requestCount}, IP: ${clientIp}`);
    
    try {
      await mcpTransport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] 请求处理错误:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null
        });
      }
    }
  });

  // GET/DELETE 方法不支持（无状态模式）
  app.get('/mcp', async (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST.' },
      id: null
    });
  });

  app.delete('/mcp', async (_req: Request, res: Response) => {
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST.' },
      id: null
    });
  });

  // 连接MCP服务器到transport（只需执行一次）
  mcpServer.connect(mcpTransport).catch(err => {
    console.error('[MCP] 连接失败:', err);
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

  // 启动 HTTP 服务 - 监听所有接口以支持远程连接
  const app = createApp();
  const HOST = process.env['HOST'] ?? '0.0.0.0';
  app.listen(PORT, HOST, () => {
    console.log(`[Server] MCP Bridge 已启动: http://${HOST}:${PORT}`);
    console.log(`[Server] MCP 端点: http://${HOST}:${PORT}/mcp (Streamable HTTP)`);
    console.log(`[Server] 健康检查: http://${HOST}:${PORT}/health`);
    console.log(`[Server] 连接状态: http://${HOST}:${PORT}/connections`);
    console.log(`[Server] 报告页面: http://${HOST}:${PORT}/report`);
  });
}

main().catch((error) => {
  console.error('[Server] 启动失败:', error);
  process.exit(1);
});
