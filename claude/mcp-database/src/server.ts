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

import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer, isInitializeRequest } from "@modelcontextprotocol/server";
import type { ToolAnnotations } from "@modelcontextprotocol/server";

// 从本文件所在目录定位 .env(dist/server.js → ../.env):stdio 启动时 cwd 常不是本目录,
// 不能靠 dotenv 默认从 cwd 找,否则预设/默认库全读不到(配了等于没配)。
// quiet: 关掉 dotenv 17 往 stderr 打的注入日志/推广 tip,保持日志干净
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../.env'), quiet: true });
import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { BoundedEventStore } from './eventStore.js';
import { getDatabaseManager, getDefaultConfig } from './database.js';
import { mcpCtx, STDIO_SESSION_ID } from './context.js';
import * as tools from './tools.js';
import {
  ConnectSchema, QuerySchema, ExecuteSchema, ListTablesSchema, DescribeTableSchema, SwitchDbSchema,
  ExplainQuerySchema, TableIndexesSchema, TableRelationsSchema, TableStatsSchema, ExportCsvSchema
} from './schemas.js';

const PORT = parseInt(process.env['PORT'] ?? '3212', 10);
// 默认只听回环:HTTP 端口等于把「按会话切库、可写生产库」的能力暴露出去,
// 跨机共享必须显式设 HOST,并同时配 MCP_AUTH_TOKEN(见下方 fail-fast)
const HOST = process.env['HOST'] ?? '127.0.0.1';
const AUTH_TOKEN = process.env['MCP_AUTH_TOKEN'];
const startTime = Date.now();
const SERVER_VERSION = '2.1.0';

// 无会话直连(兼容不走 initialize 的客户端)共用的伪会话:
// 这类客户端本来就没有会话概念,只能共享一个库指针,与改造前的全局行为等价。
// 注意:走这条路径的所有客户端彼此之间**没有会话隔离**(共用同一个「当前库」指针),
// 正规客户端请务必走 initialize 拿到 mcp-session-id。
const DIRECT_SESSION_ID = '__direct__';

// 服务级使用说明:支持 instructions 的 MCP 客户端会注入 AI 上下文,免读文档
const SERVER_INSTRUCTIONS = `数据库操作 MCP(PostgreSQL / MySQL)。工具配合要点:
- query 强制只读(SELECT);INSERT/UPDATE/DELETE 等写操作必须用 execute,执行前须确认。
- 未连接时:先 list_presets 查看 .env 预设库 → switch_db 按别名切换;预设之外的库才用 connect 手填连接信息。
- 摸库结构:list_tables → describe_table(列)/ table_indexes(索引)/ table_relations(外键关系)。
- 慢查询先 explain_query 看执行计划;大结果集导出用 export_csv。
- connect/switch_db/disconnect 只改变当前会话所指向的库,不影响其他窗口。`;

function envList(name: string): string[] {
  return (process.env[name] ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  return h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1' || /^127\./.test(h);
}

// SDK 的 DNS rebinding 防护对 Host 头做全等匹配,客户端带不带端口都可能,两种都列上。
// 跨机部署时用 MCP_ALLOWED_HOSTS 追加实际访问用的 host:port(逗号分隔)。
function buildAllowedHosts(): string[] {
  const base = ['127.0.0.1', 'localhost', '[::1]'];
  if (HOST !== '0.0.0.0' && HOST !== '::' && !base.includes(HOST)) base.push(HOST);
  return [...base.flatMap(h => [`${h}:${PORT}`, h]), ...envList('MCP_ALLOWED_HOSTS')];
}

function buildAllowedOrigins(): string[] {
  return [
    `http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`,
    'http://127.0.0.1', 'http://localhost',
    ...envList('MCP_ALLOWED_ORIGINS')
  ];
}

const ALLOWED_HOSTS = buildAllowedHosts();
const ALLOWED_ORIGINS = buildAllowedOrigins();

async function autoConnect(): Promise<boolean> {
  const config = getDefaultConfig();
  if (!config) {
    console.log('[提示] 未配置数据库信息，请编辑 .env 文件或使用 connect 工具手动连接');
    return false;
  }
  try {
    await getDatabaseManager().connect(config);
    console.log(`[自动连接] 已连接到 ${config.type}: ${config.host}:${config.port}/${config.database}`);
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

/**
 * HTTP 下每个会话一个 McpServer 实例,sessionId 由闭包捕获;
 * 所有工具 handler 都包进 ALS,DatabaseManager 才能知道「这条请求属于哪个会话」。
 * stdio 传入 __stdio__,与不带 ALS 的回落值相同 —— 行为不变。
 */
function createMcpServer(sessionId: string = STDIO_SESSION_ID): McpServer {
  const server = new McpServer(
    { name: 'claudemcp-database', title: '数据库操作', version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );

  const wrap = <T extends Function>(fn: T): T =>
    ((...args: unknown[]) => mcpCtx.run({ sessionId }, () => fn(...args))) as unknown as T;

  // === Connection ===
  server.registerTool('connect', {
    title: '连接数据库',
    description: '使用主机/端口/账号密码直接连接 PostgreSQL 或 MySQL 数据库。当尚未连接、或需要连接到 .env 预设之外的数据库时使用。仅改变当前会话指向的库，不影响其他窗口。',
    inputSchema: ConnectSchema,
    annotations: CONN,
  }, wrap(async (args: unknown) => text(await tools.connect(args))));

  server.registerTool('disconnect', {
    title: '断开连接',
    description: '断开当前会话的数据库连接并释放其连接池引用。完成数据库操作或需要切换连接前使用。连接池若仍有其他会话在用则不会被关闭。',
    annotations: CONN,
  }, wrap(async () => text(await tools.disconnect())));

  server.registerTool('status', {
    title: '连接状态',
    description: '查看当前会话的数据库连接状态（类型、主机、库名、是否已连接）。在执行查询前确认连接是否就绪时使用。',
    annotations: RO,
  }, wrap(async () => text(await tools.status())));

  server.registerTool('list_presets', {
    title: '列出预设库',
    description: '列出 .env 中通过 DB_<别名>_* 配置的所有预设数据库。配合 switch_db 使用，先查看可用别名。',
    annotations: RO,
  }, wrap(async () => text(await tools.listPresets())));

  server.registerTool('switch_db', {
    title: '切换预设库',
    description: '通过别名快速切换到 .env 中预设的数据库（如 PROD/TEST）。无需重新输入连接信息时使用，别名可由 list_presets 获取。仅改变当前会话指向的库，不影响其他窗口。',
    inputSchema: SwitchDbSchema,
    annotations: CONN,
  }, wrap(async (args: unknown) => text(await tools.switchDb(args))));

  // === Query ===
  server.registerTool('query', {
    title: '执行查询',
    description: '执行只读 SELECT 查询并返回结果行。仅用于读取数据；如需写入请改用 execute。结果会被短时缓存。',
    inputSchema: QuerySchema,
    annotations: RO,
  }, wrap(async (args: unknown) => text(await tools.query(args))));

  server.registerTool('execute', {
    title: '执行写入语句',
    description: '执行 INSERT/UPDATE/DELETE 等写操作语句。注意：会修改数据库数据，具有破坏性，使用前请确认当前会话连接的是哪个库（status）。只读查询请用 query。',
    inputSchema: ExecuteSchema,
    annotations: WRITE,
  }, wrap(async (args: unknown) => text(await tools.execute(args))));

  // === Schema inspection ===
  server.registerTool('list_tables', {
    title: '列出表',
    description: '列出数据库中所有表和视图。探索数据库结构、不知道有哪些表时使用。',
    inputSchema: ListTablesSchema,
    annotations: RO,
  }, wrap(async (args: unknown) => text(await tools.listTables(args))));

  server.registerTool('describe_table', {
    title: '查看表结构',
    description: '获取指定表的列定义（字段名、类型、是否可空、主键、默认值）。编写查询或了解表结构时使用。',
    inputSchema: DescribeTableSchema,
    annotations: RO,
  }, wrap(async (args: unknown) => text(await tools.describeTable(args))));

  server.registerTool('list_databases', {
    title: '列出数据库',
    description: '列出当前服务器上所有可用的数据库。需要了解服务器上有哪些库时使用。',
    annotations: RO,
  }, wrap(async () => text(await tools.listDatabases())));

  // === Performance & Analysis ===
  server.registerTool('explain_query', {
    title: '分析执行计划',
    description: '对 SQL 运行 EXPLAIN 并返回执行计划。用于性能调优、排查慢查询、判断是否走索引。',
    inputSchema: ExplainQuerySchema,
    annotations: RO,
  }, wrap(async (args: unknown) => text(await tools.explainQuery(args))));

  server.registerTool('table_indexes', {
    title: '查看表索引',
    description: '查看指定表的所有索引（名称、列、是否唯一、是否主键、索引类型）。优化查询或排查索引缺失时使用。',
    inputSchema: TableIndexesSchema,
    annotations: RO,
  }, wrap(async (args: unknown) => text(await tools.getTableIndexes(args))));

  server.registerTool('table_relations', {
    title: '查看表外键',
    description: '查看指定表的外键关系（关联的表与列）。理解表之间的关联、构造 JOIN 查询时使用。',
    inputSchema: TableRelationsSchema,
    annotations: RO,
  }, wrap(async (args: unknown) => text(await tools.getTableRelations(args))));

  server.registerTool('table_stats', {
    title: '查看表统计',
    description: '查看库中所有表的行数估算与磁盘占用（总大小、数据大小、索引大小）。评估数据规模或排查空间占用时使用。',
    inputSchema: TableStatsSchema,
    annotations: RO,
  }, wrap(async (args: unknown) => text(await tools.getTableStats(args))));

  server.registerTool('export_csv', {
    title: '导出CSV',
    description: '执行 SQL 查询并将结果导出为 CSV 文本。需要将查询结果保存或交付为 CSV 时使用。',
    inputSchema: ExportCsvSchema,
    annotations: RO,
  }, wrap(async (args: unknown) => text(await tools.exportCsv(args))));

  return server;
}

// Session management
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
// 会话空闲多久算过期(仅 HTTP)。过期后旧 mcp-session-id 一律 404,客户端须重新 initialize。
// 可调,见 .env.example 的「HTTP 服务 / 会话」小节。
const SESSION_TTL = envInt('MCP_SESSION_TTL_MS', 30 * 60 * 1000);
// 清理周期不能长于 TTL 的一半,否则把 TTL 调小了也等不到回收
const SESSION_SWEEP_MS = Math.max(1000, Math.min(5 * 60 * 1000, Math.floor(SESSION_TTL / 2)));
const MAX_SESSIONS = 20;
const transports: Map<string, { transport: NodeStreamableHTTPServerTransport; lastAccess: number }> = new Map();

// 无会话直连伪会话的最后使用时间(0 = 从未使用)。
// 它不走 initialize/DELETE,没有任何 SDK 生命周期钩子,不自己回收的话
// 它占的连接池引用(refs=1)会一直留到进程退出,空闲回收永远命中不了那个池。
let directLastAccess = 0;

/** 会话消失(DELETE / 传输关闭 / TTL 过期)统一走这里,必须释放它占的连接池引用,否则池永远回收不掉 */
function dropSession(sid: string, reason: string): void {
  if (!transports.has(sid)) {
    // transport 已摘除但池引用可能还在(幂等)
    getDatabaseManager().releaseSession(sid);
    return;
  }
  transports.delete(sid);
  getDatabaseManager().releaseSession(sid);
  console.log(`[Session] ${reason}: ${sid} (剩余: ${transports.size})`);
}

/** 直连伪会话空闲超过 TTL 就释放其池引用,让空闲池能被正常回收 */
function sweepDirectSession(): void {
  if (directLastAccess === 0) return;
  if (Date.now() - directLastAccess <= SESSION_TTL) return;
  directLastAccess = 0;
  getDatabaseManager().releaseSession(DIRECT_SESSION_ID);
  console.log(`[Session] Direct idle released: ${DIRECT_SESSION_ID}`);
}

function cleanupSessions(): void {
  const now = Date.now();
  for (const [sid, entry] of transports) {
    if (now - entry.lastAccess > SESSION_TTL) {
      entry.transport.close?.();
      dropSession(sid, 'Expired');
    }
  }
  sweepDirectSession();
}
// 仅 HTTP 模式需要定期清理 session；unref 避免阻止进程自然退出
if (!STDIO) setInterval(cleanupSessions, SESSION_SWEEP_MS).unref();

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
  if (directLastAccess === 0) {
    console.log('[MCP] 无会话直连路径:该路径下所有客户端共用同一个库指针，无会话隔离；建议客户端走 initialize');
  }
  directLastAccess = Date.now();
  if (!toolName || !directToolHandlers[toolName]) {
    res.json({ jsonrpc: '2.0', error: { code: -32601, message: `Unknown tool: ${toolName}` }, id: body.id });
    return;
  }
  try {
    // 无会话直连也要进 ALS,否则 currentSessionId() 会落到 __stdio__ 上,与 stdio 语义混淆
    const result = await mcpCtx.run({ sessionId: DIRECT_SESSION_ID }, () => directToolHandlers[toolName]!(toolArgs));
    res.json({ jsonrpc: '2.0', result, id: body.id });
  } catch (error) {
    res.json({ jsonrpc: '2.0', error: { code: -32603, message: error instanceof Error ? error.message : String(error) }, id: body.id });
  }
}

/**
 * 读取 mcp-session-id 头。空串/空白等同于「没带」——这样才能把
 * 「压根没有会话概念的直连客户端」和「带了一个服务端不认识的 id」严格区分开。
 * 重复头会被 Node 拼成逗号串(仍是 string),查不到就走 404 分支,不会被误当成无会话。
 */
function readSessionId(req: express.Request): string | undefined {
  const raw = req.headers['mcp-session-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? undefined : trimmed;
}

/**
 * 带了 mcp-session-id 但服务端不认识(TTL 过期 / 服务重启过 / 伪造)→ 一律 404。
 *
 * 为什么必须报错而不是"降级":降级会落到 handleDirectToolCall 的 __direct__ 伪会话,
 * 那是所有无会话客户端**共用**的库指针。会话原先 switch_db 到 prod,过期后同一条
 * tools/call 会在客户端毫不知情的情况下打到 __direct__ 指向的默认库 ——
 * 「以为在自己的库,实际在别人的库」,数据库场景下这是数据事故。
 * 404 是 MCP 规范对未知会话的规定响应,客户端据此重新 initialize(SDK 服务端
 * transport 内部对 session 不匹配也是回 404,这里保持一致)。
 */
function rejectUnknownSession(res: express.Response, sessionId: string, id: unknown = null): void {
  console.log(`[Session] 拒绝未知/已过期的 session-id: ${sessionId}`);
  res.status(404).json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message: `会话不存在或已过期 (mcp-session-id: ${sessionId})。请重新 initialize 建立会话（重连时不要携带旧的 mcp-session-id）。`
    },
    id: id ?? null
  });
}

function tokenMatches(provided: string): boolean {
  if (!AUTH_TOKEN) return true;
  const a = Buffer.from(provided);
  const b = Buffer.from(AUTH_TOKEN);
  // 长度不同直接判否:timingSafeEqual 对不等长会抛异常
  return a.length === b.length && timingSafeEqual(a, b);
}

function createApp(): express.Application {
  const app = express();
  app.use(express.json());

  // CORS:只回显白名单来源,不再 *(带 Origin 的浏览器页面否则可直接驱动本机数据库)
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    const allowed = typeof origin === 'string' && ALLOWED_ORIGINS.includes(origin);
    if (allowed) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Vary', 'Origin');
      res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id');
      res.header('Access-Control-Expose-Headers', 'mcp-session-id');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(allowed ? 204 : 403); return; }
    next();
  });

  // 限流:100 req/s per IP(与浏览器 MCP 对齐)
  const requestCounts = new Map<string, { count: number; resetAt: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of requestCounts) {
      if (now > entry.resetAt) requestCounts.delete(ip);
    }
  }, 60 * 1000).unref();
  app.use((req, res, next) => {
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

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: Math.floor((Date.now() - startTime) / 1000), service: 'claude-mcp-database', sessions: transports.size });
  });

  // DNS rebinding 防护:提到路由之前统一做,不能只靠 SDK transport。
  // SDK 的 enableDnsRebindingProtection 只覆盖「已建立会话 / initialize」这条路径,
  // 无会话直连(tools/call、tools/list)根本不经过 transport —— 实测伪造
  // `Host: attacker.example.com` 时 initialize 被 403,同一个 Host 的 tools/call 却能拿到数据。
  // 在这里挡住,三条路径(会话 / 直连 / 将来新增)才是同一套规则。校验语义与 SDK 保持一致:
  // Host 必须命中白名单;Origin 只在客户端带了的时候校验。
  app.use('/mcp', (req, res, next) => {
    const host = req.headers.host;
    if (!host || !ALLOWED_HOSTS.includes(host)) {
      res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message: `Invalid Host header: ${host ?? ''}` }, id: null });
      return;
    }
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin && !ALLOWED_ORIGINS.includes(origin)) {
      res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message: `Invalid Origin header: ${origin}` }, id: null });
      return;
    }
    next();
  });

  // Bearer 鉴权:未设 MCP_AUTH_TOKEN 时不校验(本机 loopback 场景);
  // 绑非回环地址时启动阶段已强制要求 token,这里必然生效。/health 保持开放供探活。
  app.use('/mcp', (req, res, next) => {
    if (!AUTH_TOKEN) { next(); return; }
    const header = req.headers.authorization;
    const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!provided || !tokenMatches(provided)) {
      res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
      return;
    }
    next();
  });

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = readSessionId(req);
      let transport: NodeStreamableHTTPServerTransport;

      const known = sessionId ? transports.get(sessionId) : undefined;
      if (known) {
        known.lastAccess = Date.now();
        transport = known.transport;
      } else if (sessionId) {
        // 带了 id 但服务端不认识:必须 404,不能悄悄落到无会话直连的 __direct__ 伪会话。
        // initialize 也不例外 —— 规范要求客户端「不带 session-id」重新 initialize。
        rejectUnknownSession(res, sessionId, req.body?.id);
        return;
      } else if (isInitializeRequest(req.body)) {
        if (transports.size >= MAX_SESSIONS) {
          cleanupSessions();
          if (transports.size >= MAX_SESSIONS) {
            res.status(503).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Too many sessions' }, id: null });
            return;
          }
        }
        const eventStore = new BoundedEventStore();
        // sessionId 必须在 mcpServer.connect 之前就确定(工具 handler 要闭包捕获它),
        // 而 onsessioninitialized 回调发生在 handleRequest 期间,太晚 —— 所以自己先生成,
        // 再让 sessionIdGenerator 原样返回,两边拿到的是同一个 id。
        const newSessionId = randomUUID();
        transport = new NodeStreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
          eventStore,
          enableDnsRebindingProtection: true,
          allowedHosts: ALLOWED_HOSTS,
          allowedOrigins: ALLOWED_ORIGINS,
          onsessioninitialized: (sid) => {
            transports.set(sid, { transport, lastAccess: Date.now() });
            console.log(`[Session] New: ${sid} (total: ${transports.size})`);
          },
          // 客户端 DELETE 主动结束会话 → 释放它占的连接池引用
          onsessionclosed: (sid) => { dropSession(sid, 'Closed'); }
        });
        transport.onclose = () => { dropSession(newSessionId, 'Transport closed'); };
        const mcpServer = createMcpServer(newSessionId);
        await mcpServer.connect(transport);
      } else {
        // 走到这里只剩一种情况:请求**完全没带** mcp-session-id —— 即本来就没有会话概念的
        // 直连客户端。保持既有行为(共用 __direct__ 伪会话),不做改动。
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

  // GET(SSE 通知流)/ DELETE(结束会话)同样区分两种失败:
  //   未知/过期 id → 404(与 POST 一致,客户端据此重新 initialize)
  //   压根没带 id  → 400(这两条路由本就必须带会话,属于请求格式错误)
  app.get('/mcp', async (req, res) => {
    const sessionId = readSessionId(req);
    const known = sessionId ? transports.get(sessionId) : undefined;
    if (known) {
      known.lastAccess = Date.now();
      await known.transport.handleRequest(req, res);
    } else if (sessionId) {
      rejectUnknownSession(res, sessionId);
    } else {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Mcp-Session-Id header is required' }, id: null });
    }
  });

  app.delete('/mcp', async (req, res) => {
    const sessionId = readSessionId(req);
    const known = sessionId ? transports.get(sessionId) : undefined;
    if (known) {
      await known.transport.handleRequest(req, res);
    } else if (sessionId) {
      rejectUnknownSession(res, sessionId);
    } else {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Mcp-Session-Id header is required' }, id: null });
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
  const server = createMcpServer(STDIO_SESSION_ID);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[MCP] Claude Code stdio 数据库服务已就绪 (pid=${process.pid} ppid=${process.ppid})`);

  // uncaughtException / unhandledRejection 兜底:转 exit 走清理路径
  process.on('uncaughtException', (err) => {
    console.error('[MCP] uncaughtException:', err);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[MCP] unhandledRejection:', reason);
    process.exit(1);
  });

  // 孤儿进程防护:SSH 断开 / 客户端崩 → 自杀,避免连接池累积
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[MCP] stdio shutdown: ${reason}`);
    // 2 秒兜底(原 5 秒;disconnect 卡住也只能硬退,5 秒等于白等)
    const hardExit = setTimeout(() => {
      console.error('[MCP] disconnect timeout, force exit');
      process.exit(1);
    }, 2000);
    hardExit.unref?.();
    try { await getDatabaseManager().closeAll(); } catch (e) { console.error('[MCP] disconnect error:', e); }
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGHUP', () => { void shutdown('SIGHUP'); });
  process.stdin.on('end', () => { void shutdown('stdin end'); });
  process.stdin.on('close', () => { void shutdown('stdin close'); });
  process.stdin.on('error', (err) => { void shutdown(`stdin error: ${err.message}`); });
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') void shutdown('stdout EPIPE');
  });

  // ppid 轮询 1s(原 3s)— 跟 browser server 对齐,父死到自死窗口 ≤ 3s
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

async function runHttp(): Promise<void> {
  // fail-fast:绑非回环地址却没有 token,等于把改库/写库能力裸奔在局域网上
  if (!isLoopbackHost(HOST) && !AUTH_TOKEN) {
    console.error(`[安全] HOST=${HOST} 非回环地址但未设置 MCP_AUTH_TOKEN，拒绝启动。`);
    console.error('[安全] 请设置 MCP_AUTH_TOKEN 后重试，或改用默认的 HOST=127.0.0.1。');
    process.exit(1);
  }

  const app = createApp();
  const server = app.listen(PORT, HOST, async () => {
    console.log('========================================');
    console.log(`  MCP Database Bridge (Claude Code) v${SERVER_VERSION}`);
    console.log(`  http://${HOST}:${PORT}`);
    console.log(`  MCP: http://${HOST}:${PORT}/mcp`);
    console.log(`  鉴权: ${AUTH_TOKEN ? 'Bearer token 已启用' : '关闭(仅回环)'}`);
    console.log('========================================');
    // HTTP 下不做全局自动连接:每个会话首次使用时各自套用默认库。
    // 这里只预热并验证默认库可达,失败不影响服务启动。
    try {
      const config = await getDatabaseManager().warmupDefault();
      if (config) console.log(`[预热] 默认库连接池就绪 ${config.type}: ${config.host}:${config.port}/${config.database}`);
      else console.log('[提示] 未配置默认数据库，会话需自行使用 connect / switch_db');
    } catch (error) {
      console.error('[预热失败]', error instanceof Error ? error.message : error);
    }
  });

  const shutdown = async (reason: string): Promise<void> => {
    console.log(`[Server] 收到 ${reason}，正在关闭...`);
    for (const [sid, entry] of transports) { try { entry.transport.close?.(); } catch { /* 忽略 */ } transports.delete(sid); }
    try { await getDatabaseManager().closeAll(); } catch (e) { console.error('[Server] 关闭连接池失败:', e); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
}

async function main(): Promise<void> {
  if (STDIO) {
    await runStdio();
  } else {
    await runHttp();
  }
}

main().catch((error) => { console.error(error); });
