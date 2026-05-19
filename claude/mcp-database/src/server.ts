/**
 * MCP Database Bridge - Claude Code 版本
 * 支持 stdio (Claude Code 原生) 与 Streamable HTTP 双传输
 */

// stdio 模式下 stdout 必须保持为纯净的 JSON-RPC 流，
// 因此在任何其他逻辑运行之前把 console.log/info 重定向到 stderr。
const STDIO = process.argv.includes('--stdio') || process.env['MCP_TRANSPORT'] === 'stdio';
if (STDIO) {
  console.log = (...a: unknown[]) => console.error(...a);
  console.info = (...a: unknown[]) => console.error(...a);
}

import 'dotenv/config';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { InMemoryEventStore } from '@modelcontextprotocol/sdk/examples/shared/inMemoryEventStore.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
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

function text(result: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
}

// 只读工具注解：不修改数据、属于封闭系统
const RO: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
// 连接管理工具：会改变会话状态但不修改业务数据
const CONN: ToolAnnotations = { readOnlyHint: false, openWorldHint: false };
// 写入工具：执行 INSERT/UPDATE/DELETE，具有破坏性
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, openWorldHint: false };

function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'claudemcp-database', version: '2.0.0' });

  // === Connection ===
  server.registerTool('connect', {
    title: '连接数据库',
    description: '使用主机/端口/账号密码直接连接 PostgreSQL 或 MySQL 数据库。当尚未连接、或需要连接到 .env 预设之外的数据库时使用。',
    inputSchema: ConnectSchema.shape,
    annotations: CONN,
  }, async (args) => text(await tools.connect(args)));

  server.registerTool('disconnect', {
    title: '断开连接',
    description: '关闭当前数据库连接并释放连接池。完成数据库操作或需要切换连接前使用。',
    annotations: CONN,
  }, async () => text(await tools.disconnect()));

  server.registerTool('status', {
    title: '连接状态',
    description: '查看当前数据库连接状态（类型、主机、库名、是否已连接）。在执行查询前确认连接是否就绪时使用。',
    annotations: RO,
  }, async () => text(await tools.status()));

  server.registerTool('list_presets', {
    title: '列出预设库',
    description: '列出 .env 中通过 DB_<别名>_* 配置的所有预设数据库。配合 switch_db 使用，先查看可用别名。',
    annotations: RO,
  }, async () => text(await tools.listPresets()));

  server.registerTool('switch_db', {
    title: '切换预设库',
    description: '通过别名快速切换到 .env 中预设的数据库（如 PROD/TEST）。无需重新输入连接信息时使用，别名可由 list_presets 获取。',
    inputSchema: SwitchDbSchema.shape,
    annotations: CONN,
  }, async (args) => text(await tools.switchDb(args)));

  // === Query ===
  server.registerTool('query', {
    title: '执行查询',
    description: '执行只读 SELECT 查询并返回结果行。仅用于读取数据；如需写入请改用 execute。结果会被短时缓存。',
    inputSchema: QuerySchema.shape,
    annotations: RO,
  }, async (args) => text(await tools.query(args)));

  server.registerTool('execute', {
    title: '执行写入语句',
    description: '执行 INSERT/UPDATE/DELETE 等写操作语句。注意：会修改数据库数据，具有破坏性，使用前请确认。只读查询请用 query。',
    inputSchema: ExecuteSchema.shape,
    annotations: WRITE,
  }, async (args) => text(await tools.execute(args)));

  // === Schema inspection ===
  server.registerTool('list_tables', {
    title: '列出表',
    description: '列出数据库中所有表和视图。探索数据库结构、不知道有哪些表时使用。',
    inputSchema: ListTablesSchema.shape,
    annotations: RO,
  }, async (args) => text(await tools.listTables(args)));

  server.registerTool('describe_table', {
    title: '查看表结构',
    description: '获取指定表的列定义（字段名、类型、是否可空、主键、默认值）。编写查询或了解表结构时使用。',
    inputSchema: DescribeTableSchema.shape,
    annotations: RO,
  }, async (args) => text(await tools.describeTable(args)));

  server.registerTool('list_databases', {
    title: '列出数据库',
    description: '列出当前服务器上所有可用的数据库。需要了解服务器上有哪些库时使用。',
    annotations: RO,
  }, async () => text(await tools.listDatabases()));

  // === Performance & Analysis ===
  server.registerTool('explain_query', {
    title: '分析执行计划',
    description: '对 SQL 运行 EXPLAIN 并返回执行计划。用于性能调优、排查慢查询、判断是否走索引。',
    inputSchema: ExplainQuerySchema.shape,
    annotations: RO,
  }, async (args) => text(await tools.explainQuery(args)));

  server.registerTool('table_indexes', {
    title: '查看表索引',
    description: '查看指定表的所有索引（名称、列、是否唯一、是否主键、索引类型）。优化查询或排查索引缺失时使用。',
    inputSchema: TableIndexesSchema.shape,
    annotations: RO,
  }, async (args) => text(await tools.getTableIndexes(args)));

  server.registerTool('table_relations', {
    title: '查看表外键',
    description: '查看指定表的外键关系（关联的表与列）。理解表之间的关联、构造 JOIN 查询时使用。',
    inputSchema: TableRelationsSchema.shape,
    annotations: RO,
  }, async (args) => text(await tools.getTableRelations(args)));

  server.registerTool('table_stats', {
    title: '查看表统计',
    description: '查看库中所有表的行数估算与磁盘占用（总大小、数据大小、索引大小）。评估数据规模或排查空间占用时使用。',
    inputSchema: TableStatsSchema.shape,
    annotations: RO,
  }, async (args) => text(await tools.getTableStats(args)));

  server.registerTool('export_csv', {
    title: '导出CSV',
    description: '执行 SQL 查询并将结果导出为 CSV 文本。需要将查询结果保存或交付为 CSV 时使用。',
    inputSchema: ExportCsvSchema.shape,
    annotations: RO,
  }, async (args) => text(await tools.exportCsv(args)));

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

// Direct tool handler map for sessionless requests (兼容无会话客户端)
const directToolHandlers: Record<string, (args: unknown) => Promise<unknown>> = {
  connect: async (a) => text(await tools.connect(a)),
  disconnect: async () => text(await tools.disconnect()),
  status: async () => text(await tools.status()),
  list_presets: async () => text(await tools.listPresets()),
  switch_db: async (a) => text(await tools.switchDb(a)),
  query: async (a) => text(await tools.query(a)),
  execute: async (a) => text(await tools.execute(a)),
  list_tables: async (a) => text(await tools.listTables(a)),
  describe_table: async (a) => text(await tools.describeTable(a)),
  list_databases: async () => text(await tools.listDatabases()),
  explain_query: async (a) => text(await tools.explainQuery(a)),
  table_indexes: async (a) => text(await tools.getTableIndexes(a)),
  table_relations: async (a) => text(await tools.getTableRelations(a)),
  table_stats: async (a) => text(await tools.getTableStats(a)),
  export_csv: async (a) => text(await tools.exportCsv(a)),
};

async function handleDirectToolCall(body: { id: unknown; params?: { name?: string; arguments?: unknown } }, res: express.Response): Promise<void> {
  const toolName = body.params?.name;
  const toolArgs = body.params?.arguments ?? {};
  if (!toolName || !directToolHandlers[toolName]) {
    res.json({ jsonrpc: '2.0', error: { code: -32601, message: `Unknown tool: ${toolName}` }, id: body.id });
    return;
  }
  try {
    const result = await directToolHandlers[toolName]!(toolArgs);
    res.json({ jsonrpc: '2.0', result, id: body.id });
  } catch (error) {
    res.json({ jsonrpc: '2.0', error: { code: -32603, message: error instanceof Error ? error.message : String(error) }, id: body.id });
  }
}

function createApp(): express.Application {
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000), service: 'claude-mcp-database', sessions: transports.size });
  });

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        const entry = transports.get(sessionId)!;
        entry.lastAccess = Date.now();
        transport = entry.transport;
      } else if (isInitializeRequest(req.body)) {
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

async function runStdio(): Promise<void> {
  // 自动连接失败不应阻断 stdio 服务启动
  try {
    await autoConnect();
  } catch (error) {
    console.error('[自动连接异常]', error instanceof Error ? error.message : error);
  }
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] Claude Code stdio 数据库服务已就绪');
}

async function runHttp(): Promise<void> {
  const app = createApp();
  app.listen(PORT, '0.0.0.0', async () => {
    console.log('========================================');
    console.log('  MCP Database Bridge (Claude Code) v2.0.0');
    console.log(`  http://0.0.0.0:${PORT}`);
    console.log(`  MCP: http://0.0.0.0:${PORT}/mcp`);
    console.log('========================================');
    await autoConnect();
  });
}

async function main(): Promise<void> {
  if (STDIO) {
    await runStdio();
  } else {
    await runHttp();
  }
}

main().catch((error) => { console.error(error); });
