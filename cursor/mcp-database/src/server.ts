/**
 * MCP Database Bridge - Cursor 版本
 */

import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { getDatabaseManager } from './database.js';
import * as tools from './tools.js';
import { ConnectSchema, QuerySchema, ExecuteSchema, ListTablesSchema, DescribeTableSchema, SwitchDbSchema } from './schemas.js';
import type { DatabaseType } from './types.js';

const PORT = parseInt(process.env['PORT'] ?? '3212', 10);
const startTime = Date.now();

async function autoConnect(): Promise<boolean> {
  const dbType = process.env['DB_TYPE'] as DatabaseType | undefined;
  const dbHost = process.env['DB_HOST'];
  const dbPort = process.env['DB_PORT'];
  const dbName = process.env['DB_NAME'];
  const dbUser = process.env['DB_USER'];
  const dbPassword = process.env['DB_PASSWORD'];
  const dbSsl = process.env['DB_SSL'] === 'true';
  if (!dbType || !dbHost || !dbPort || !dbName || !dbUser) {
    console.log('[提示] 未配置数据库信息，请编辑 .env 文件或使用 connect 工具手动连接');
    return false;
  }
  try {
    await getDatabaseManager().connect({ type: dbType, host: dbHost, port: parseInt(dbPort, 10), database: dbName, user: dbUser, password: dbPassword ?? '', ssl: dbSsl });
    console.log(`[自动连接] 已连接到 ${dbType}: ${dbHost}:${dbPort}/${dbName}`);
    return true;
  } catch (error) {
    console.error('[自动连接失败]', error instanceof Error ? error.message : error);
    return false;
  }
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'cursor-mcp-database', version: '1.0.0' });

  server.tool('connect', '连接到 PostgreSQL 或 MySQL 数据库', ConnectSchema.shape, async (args) => {
    const result = await tools.connect(args); return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('disconnect', '断开数据库连接', {}, async () => {
    const result = await tools.disconnect(); return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('status', '获取当前数据库连接状态', {}, async () => {
    const result = await tools.status(); return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('query', '执行 SQL 查询语句(SELECT)', QuerySchema.shape, async (args) => {
    const result = await tools.query(args); return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('execute', '执行 SQL 操作语句(INSERT/UPDATE/DELETE)', ExecuteSchema.shape, async (args) => {
    const result = await tools.execute(args); return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('list_tables', '列出数据库中所有表', ListTablesSchema.shape, async (args) => {
    const result = await tools.listTables(args); return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('describe_table', '获取表的列信息', DescribeTableSchema.shape, async (args) => {
    const result = await tools.describeTable(args); return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('list_databases', '列出所有可用数据库', {}, async () => {
    const result = await tools.listDatabases(); return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('list_presets', '列出.env中配置的所有预设数据库', {}, async () => {
    const result = await tools.listPresets(); return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
  server.tool('switch_db', '切换到预设数据库(通过别名)', SwitchDbSchema.shape, async (args) => {
    const result = await tools.switchDb(args); return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  return server;
}

function createApp(): express.Application {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000), service: 'cursor-mcp-database' });
  });

  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
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
          if (sid) { delete transports[sid]; console.log(`[MCP] Session closed: ${sid}`); }
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
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res);
    } else {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null });
    }
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports[sessionId]) {
      await transports[sessionId].handleRequest(req, res);
    } else {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null });
    }
  });

  return app;
}

async function main(): Promise<void> {
  const app = createApp();
  app.listen(PORT, '0.0.0.0', async () => {
    console.log('========================================');
    console.log('  MCP Database Bridge (Cursor) 已启动');
    console.log(`  端口: ${PORT} | MCP: http://localhost:${PORT}/mcp`);
    console.log('========================================');
    await autoConnect();
  });
}

main().catch(console.error);
