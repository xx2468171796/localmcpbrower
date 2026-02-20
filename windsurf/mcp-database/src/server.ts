/**
 * MCP Database Bridge - Windsurf 版本
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
import {
  ConnectSchema, QuerySchema, ExecuteSchema, ListTablesSchema, DescribeTableSchema, SwitchDbSchema,
  ExplainQuerySchema, TableIndexesSchema, TableRelationsSchema, TableStatsSchema, ExportCsvSchema
} from './schemas.js';
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
    console.log('[提示] 未配置数据库信息，请编辑 .env 文件或使�?connect 工具手动连接');
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

function text(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'windsurf-mcp-database', version: '1.0.0' });

  // === Connection ===
  server.tool('connect', '连接�?PostgreSQL �?MySQL 数据�?, ConnectSchema.shape, async (args) => text(await tools.connect(args)));
  server.tool('disconnect', '断开数据库连�?, {}, async () => text(await tools.disconnect()));
  server.tool('status', '获取当前数据库连接状�?, {}, async () => text(await tools.status()));
  server.tool('list_presets', '列出.env中配置的所有预设数据库', {}, async () => text(await tools.listPresets()));
  server.tool('switch_db', '切换到预设数据库(通过别名)', SwitchDbSchema.shape, async (args) => text(await tools.switchDb(args)));

  // === Query ===
  server.tool('query', '执行SQL查询语句(SELECT)', QuerySchema.shape, async (args) => text(await tools.query(args)));
  server.tool('execute', '执行SQL操作语句(INSERT/UPDATE/DELETE)', ExecuteSchema.shape, async (args) => text(await tools.execute(args)));

  // === Schema inspection ===
  server.tool('list_tables', '列出数据库中所有表', ListTablesSchema.shape, async (args) => text(await tools.listTables(args)));
  server.tool('describe_table', '获取表的列信�?, DescribeTableSchema.shape, async (args) => text(await tools.describeTable(args)));
  server.tool('list_databases', '列出所有可用数据库', {}, async () => text(await tools.listDatabases()));

  // === New: Performance & Analysis ===
  server.tool('explain_query', 'EXPLAIN分析SQL执行计划(性能调优)', ExplainQuerySchema.shape, async (args) => text(await tools.explainQuery(args)));
  server.tool('table_indexes', '查看表的索引信息', TableIndexesSchema.shape, async (args) => text(await tools.getTableIndexes(args)));
  server.tool('table_relations', '查看表的外键关系', TableRelationsSchema.shape, async (args) => text(await tools.getTableRelations(args)));
  server.tool('table_stats', '查看所有表的大小和行数统计', TableStatsSchema.shape, async (args) => text(await tools.getTableStats(args)));
  server.tool('export_csv', '将SQL查询结果导出为CSV', ExportCsvSchema.shape, async (args) => text(await tools.exportCsv(args)));

  return server;
}

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

function createApp(): express.Application {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000), service: 'windsurf-mcp-database', sessions: transports.size });
  });

  app.post('/mcp', async (req, res) => {
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
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  });

  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      transports.get(sessionId)!.lastAccess = Date.now();
      await transports.get(sessionId)!.transport.handleRequest(req, res);
    } else {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session' }, id: null });
    }
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (sessionId && transports.has(sessionId)) {
      await transports.get(sessionId)!.transport.handleRequest(req, res);
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
    console.log('  MCP Database Bridge (Windsurf) v1.0.0');
    console.log(`  http://0.0.0.0:${PORT}`);
    console.log(`  MCP: http://0.0.0.0:${PORT}/mcp`);
    console.log('========================================');
    await autoConnect();
  });
}

main().catch(console.error);
