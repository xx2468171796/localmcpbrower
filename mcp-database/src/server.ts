/**
 * MCP Database Bridge - Express + Streamable HTTP 服务
 */

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as tools from './tools.js';
import {
  ConnectSchema,
  QuerySchema,
  ExecuteSchema,
  ListTablesSchema,
  DescribeTableSchema
} from './schemas.js';

const PORT = parseInt(process.env['PORT'] ?? '3212', 10);
const startTime = Date.now();

/** 创建 MCP 服务器 */
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'mcp-database-bridge',
    version: '1.0.0'
  });

  // 连接数据库
  server.tool('connect', '连接到 PostgreSQL 或 MySQL 数据库', ConnectSchema.shape, async (args) => {
    const result = await tools.connect(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 断开连接
  server.tool('disconnect', '断开数据库连接', {}, async () => {
    const result = await tools.disconnect();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 获取连接状态
  server.tool('status', '获取当前数据库连接状态', {}, async () => {
    const result = await tools.status();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 执行查询
  server.tool('query', '执行 SQL 查询语句(SELECT)', QuerySchema.shape, async (args) => {
    const result = await tools.query(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 执行操作
  server.tool('execute', '执行 SQL 操作语句(INSERT/UPDATE/DELETE)', ExecuteSchema.shape, async (args) => {
    const result = await tools.execute(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 列出表
  server.tool('list_tables', '列出数据库中所有表', ListTablesSchema.shape, async (args) => {
    const result = await tools.listTables(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 描述表结构
  server.tool('describe_table', '获取表的列信息', DescribeTableSchema.shape, async (args) => {
    const result = await tools.describeTable(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  // 列出数据库
  server.tool('list_databases', '列出所有可用数据库', {}, async () => {
    const result = await tools.listDatabases();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  return server;
}

/** 创建 Express 应用 */
function createApp(): express.Application {
  const app = express();

  // 健康检查
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      service: 'mcp-database-bridge'
    });
  });

  // MCP Streamable HTTP 端点 (无状态模式)
  const mcpTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined
  });
  const mcpServer = createMcpServer();

  app.post('/mcp', async (req, res) => {
    try {
      await mcpTransport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[MCP] 请求处理错误:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // 不支持 GET/DELETE
  app.get('/mcp', (_req, res) => {
    res.status(405).json({ error: 'Method not allowed. Use POST for MCP requests.' });
  });
  app.delete('/mcp', (_req, res) => {
    res.status(405).json({ error: 'Method not allowed. Stateless server.' });
  });

  // 连接 MCP 服务器
  mcpServer.connect(mcpTransport).catch(console.error);

  return app;
}

/** 启动服务器 */
async function main(): Promise<void> {
  const app = createApp();

  app.listen(PORT, '0.0.0.0', () => {
    console.log('========================================');
    console.log('  MCP Database Bridge 已启动');
    console.log('========================================');
    console.log(`  端口: ${PORT}`);
    console.log(`  MCP 端点: http://localhost:${PORT}/mcp`);
    console.log(`  健康检查: http://localhost:${PORT}/health`);
    console.log('========================================');
    console.log('  支持的数据库: PostgreSQL, MySQL');
    console.log('========================================');
  });
}

main().catch(console.error);
