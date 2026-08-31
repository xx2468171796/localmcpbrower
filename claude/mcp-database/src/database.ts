/**
 * 数据库连接管理器 - 支持 PostgreSQL 和 MySQL
 *
 * 会话模型(HTTP 常驻服务多会话共享一个进程时必需):
 *   连接池注册表 Map<configKey, PoolEntry>    ← 全服务共享,这才是连接池的意义
 *   会话指针     Map<sessionId, 指向哪个池>   ← 每个会话「当前在哪个库」彼此独立
 *
 * 为什么必须这么拆:改造前 currentType/currentConfig 是全局唯一的,
 * 窗口 A 执行 switch_db('prod') 之后,窗口 B 以为自己还在测试库,
 * 一条 execute() 就写进了生产库 —— 这是数据事故,不是体验问题。
 *
 * stdio 下 currentSessionId() 恒为 __stdio__,整个模型退化成单会话,
 * 行为与改造前一致(向后兼容)。
 */

import pg from 'pg';
import mysql from 'mysql2/promise';
import { createHmac, randomBytes } from 'node:crypto';
import { currentSessionId } from './context.js';
import type { DatabaseConfig, DatabaseType, QueryResult, TableInfo, ColumnInfo, ConnectionStatus } from './types.js';

interface CacheEntry { result: QueryResult; timestamp: number; }

interface PoolEntry {
  key: string;
  config: DatabaseConfig;
  pg: pg.Pool | null;
  mysql: mysql.Pool | null;
  /** 指向本池的会话数量;归零才允许关闭,否则会拆掉别人正在用的连接 */
  refs: number;
  /** refs 归零的时刻;非 null 表示正处于「无人使用」的空闲期 */
  idleSince: number | null;
}

interface SessionPointer { key: string; config: DatabaseConfig; }

const STDIO = process.argv.includes('--stdio') || process.env['MCP_TRANSPORT'] === 'stdio';

/** 环境变量取数:填了非法值就回落默认,不能让一个笔误把池管理逻辑变成 NaN 比较(永不回收) */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

// 这两个旋钮**必须惰性读取**:ESM 的 import 是提升的,本模块的模块体在 server.ts 的
// dotenv.config() 之前就执行完了。若在顶层求值,写在 .env 里的 DB_POOL_IDLE_MS /
// DB_POOL_MAX 会被静默忽略(只有真实环境变量生效)—— 而 .env.example 明确说 .env
// 对 stdio 与 HTTP 两种模式都生效,用户理所当然会把它们写进 .env。
//
// stdio 是单进程单会话,disconnect 必须立刻关池才与改造前行为一致;
// HTTP 常驻服务则保留一段空闲期,避免会话来回切库时反复重建池(握手很贵)。
//
// 用户可调环境变量(取值/默认值/注意事项见 .env.example「连接池」小节):
//   DB_POOL_IDLE_MS  空闲池保留时长(ms),默认 stdio=0 / HTTP=300000,<=0 表示立刻关
//   DB_POOL_MAX      单个池最大连接数,默认 10,<1 回落 10
function poolIdleMs(): number {
  return envInt('DB_POOL_IDLE_MS', STDIO ? 0 : 5 * 60 * 1000);
}
/** 池上限:<1 会让池彻底不可用(DB_POOL_MAX=0 等于把库关掉),回落默认值 */
function poolMax(): number {
  const value = Math.floor(envInt('DB_POOL_MAX', 10));
  return value >= 1 ? value : 10;
}

const NOT_CONNECTED = '未连接数据库，请先调用 connect 工具';
const BROKEN_POOL = '数据库连接异常';

/**
 * 进程级随机盐。凭据摘要只在**本进程内**用来区分池,不需要跨进程稳定,因此必须加盐:
 * 无盐的 sha256(password) 前 48 位是一个**可离线比对**的口令指纹,一旦随日志落盘
 * (PM2 会把 stdout 持久化到 logs/database-out.log),拿到日志的人就能拿字典逐个 hash
 * 比对反推密码。加盐后同一个密码在不同进程/不同机器上摘要都不同,字典比对失效;
 * 进程重启导致摘要变化也无副作用 —— pools/sessions 全在内存里,重启本就一起重建。
 */
const CRED_SALT = randomBytes(32);

/**
 * 凭据摘要:HMAC-SHA256(进程盐, password + ssl) 取前 12 位十六进制,绝不落明文。
 * 把 password/ssl 纳入池标识,否则用**错误密码**连一个别人已打开的库会直接复用现成的池
 * 并返回成功 —— 凭据校验被旁路。V1 本机回环无实害,但 HTTP-DESIGN §8.2 的终局是跨机
 * 多用户,那时这就是越权。顺带修掉 ssl 不同却复用同一个池的隐患。
 *
 * 即便加了盐,摘要(以及含摘要的 poolKey)也**一律不许进日志** —— 日志请用 poolLabel(),
 * 盐只是万一哪天又被打出去时的兜底。
 */
function credDigest(c: DatabaseConfig): string {
  return createHmac('sha256', CRED_SALT).update(`${c.password ?? ''}\u0000${c.ssl ? '1' : '0'}`).digest('hex').slice(0, 12);
}

/** 池标识:同一个 type/host/port/database/user + 同一份凭据,全服务只建一个池 */
function poolKey(c: DatabaseConfig): string {
  return `${c.type}:${c.host}:${c.port}:${c.database}:${c.user}:${credDigest(c)}`;
}

/**
 * 日志/展示用的库标识 —— **打日志一律用它,绝不要打 poolKey**:
 * poolKey 尾部是凭据摘要,而日志会被 PM2 持久化到磁盘,等于把口令指纹落盘,
 * 有日志读取权的人即可离线爆破比对。这里只保留定位问题真正需要的信息(库地址),
 * 不含任何由凭据派生的数据。
 */
function poolLabel(c: DatabaseConfig): string {
  return `${c.type}://${c.user}@${c.host}:${c.port}/${c.database}`;
}

/** 读取 .env 中的默认库配置(DB_*);缺少必填字段则返回 null */
export function getDefaultConfig(): DatabaseConfig | null {
  const type = process.env['DB_TYPE'] as DatabaseType | undefined;
  const host = process.env['DB_HOST'];
  const port = process.env['DB_PORT'];
  const database = process.env['DB_NAME'];
  const user = process.env['DB_USER'];
  if (!type || !host || !port || !database || !user) return null;
  return {
    type, host, port: parseInt(port, 10), database, user,
    password: process.env['DB_PASSWORD'] ?? '',
    ssl: process.env['DB_SSL'] === 'true'
  };
}

class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private pools: Map<string, PoolEntry> = new Map();
  /** 建池中的 promise:两个会话同时连同一个库时只应真正建一个池 */
  private creating: Map<string, Promise<PoolEntry>> = new Map();
  /** 关池中的 promise:池已从 pools 摘走但 end() 尚未完成,disconnect/closeAll 要能等到它 */
  private destroying: Map<string, Promise<void>> = new Map();
  private sessions: Map<string, SessionPointer> = new Map();
  /**
   * 已经「初始化过」的会话(显式 connect/switch_db/disconnect,或已套用过默认库)。
   * 作用:disconnect 之后不能再被 .env 默认库悄悄接回去,否则用户以为断开了,
   * 下一条 execute 却打进了默认库。
   */
  private bootstrapped: Set<string> = new Set();
  private queryCache: Map<string, CacheEntry> = new Map();
  /** 每个 configKey 的缓存版本号:失效一次 +1,用来丢弃"失效之后才回来"的旧快照 */
  private cacheGen: Map<string, number> = new Map();
  private readonly CACHE_TTL = 60000;
  private readonly MAX_CACHE_SIZE = 500;

  private constructor() {
    setInterval(() => { this.cleanCache(); this.sweepIdlePools(); }, 60000).unref();
  }

  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) { DatabaseManager.instance = new DatabaseManager(); }
    return DatabaseManager.instance;
  }

  // ==================== 连接池注册表 ====================

  private async createPool(key: string, config: DatabaseConfig): Promise<PoolEntry> {
    const entry: PoolEntry = { key, config, pg: null, mysql: null, refs: 0, idleSince: Date.now() };
    const max = poolMax();

    if (config.type === 'postgresql') {
      const pool = new pg.Pool({
        host: config.host, port: config.port, database: config.database,
        user: config.user, password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        // min>0 会让空闲连接常驻;HTTP 下池已全服务共享,更没必要预留
        max, min: 0, idleTimeoutMillis: 60000, connectionTimeoutMillis: 15000,
        allowExitOnIdle: false, statement_timeout: 60000, query_timeout: 60000,
        application_name: 'mcp-database-bridge'
      });
      try {
        const client = await pool.connect();
        client.release();
      } catch (error) {
        // 建池失败必须回收句柄,否则失败的池会一直留着重连定时器(改造前的老泄漏)
        await pool.end().catch(() => undefined);
        throw error;
      }
      entry.pg = pool;
    } else {
      const pool = mysql.createPool({
        host: config.host, port: config.port, database: config.database,
        user: config.user, password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        waitForConnections: true, connectionLimit: max, maxIdle: 2,
        idleTimeout: 60000, queueLimit: 0, enableKeepAlive: true,
        keepAliveInitialDelay: 0, multipleStatements: false, namedPlaceholders: true
      });
      try {
        const conn = await pool.getConnection();
        conn.release();
      } catch (error) {
        await pool.end().catch(() => undefined);
        throw error;
      }
      entry.mysql = pool;
    }

    this.pools.set(key, entry);
    return entry;
  }

  private async acquire(config: DatabaseConfig): Promise<PoolEntry> {
    const key = poolKey(config);
    const existing = this.pools.get(key);
    if (existing) { existing.refs++; existing.idleSince = null; return existing; }

    const pending = this.creating.get(key);
    if (pending) {
      const entry = await pending;
      entry.refs++; entry.idleSince = null;
      return entry;
    }

    const task = this.createPool(key, config);
    this.creating.set(key, task);
    try {
      const entry = await task;
      entry.refs++; entry.idleSince = null;
      return entry;
    } finally {
      this.creating.delete(key);
    }
  }

  private release(key: string): void {
    const entry = this.pools.get(key);
    if (!entry) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      entry.idleSince = Date.now();
      if (poolIdleMs() <= 0) void this.destroy(key);
    }
  }

  /**
   * 关闭并注销一个池。返回的 promise 在 end() 真正完成后才 resolve,并登记在 destroying 里:
   * destroy 一进门就把 key 从 pools 摘掉,若不额外登记,disconnect()/closeAll() 就再也
   * 找不到这个「正在关闭」的池,更没法等它 —— stdio 关停时 process.exit(0) 会打断收尾,
   * 而改造前的 disconnect() 是老老实实 await pgPool.end() 的。
   */
  private destroy(key: string): Promise<void> {
    const entry = this.pools.get(key);
    // 已经在关的池:复用同一个 promise,不要重复 end()
    if (!entry) return this.destroying.get(key) ?? Promise.resolve();
    // 先摘出注册表,避免关闭过程中又被 acquire 复用到一个正在 end 的池
    this.pools.delete(key);
    this.invalidateCache(key);
    const task = (async () => {
      try { if (entry.pg) await entry.pg.end(); } catch (error) { console.error('[Pool] pg 关闭失败:', error); }
      try { if (entry.mysql) await entry.mysql.end(); } catch (error) { console.error('[Pool] mysql 关闭失败:', error); }
    })();
    this.destroying.set(key, task);
    // 身份比对:关闭期间同 key 可能已被重建又销毁,别把后来者的登记抹掉
    void task.then(() => { if (this.destroying.get(key) === task) this.destroying.delete(key); });
    return task;
  }

  private sweepIdlePools(): void {
    const idleMs = poolIdleMs();
    if (idleMs <= 0) return;
    const now = Date.now();
    for (const [key, entry] of this.pools) {
      if (entry.refs === 0 && entry.idleSince !== null && now - entry.idleSince > idleMs) {
        // 打脱敏标识,不打 key —— key 尾部是凭据摘要,进日志=指纹落盘
        console.log(`[Pool] 空闲回收: ${poolLabel(entry.config)}`);
        void this.destroy(key);
      }
    }
  }

  // ==================== 会话指针 ====================

  /** 取当前会话的池;没有指针时按 .env 默认库懒加载(仅一次) */
  private async ensureEntry(): Promise<PoolEntry> {
    const sessionId = currentSessionId();
    const pointer = this.sessions.get(sessionId);
    if (pointer) {
      const entry = this.pools.get(pointer.key);
      if (entry) return entry;
      // 池不在了(异常关闭)→ 用会话自己记着的配置重建,不要串到别的库
      this.sessions.delete(sessionId);
      await this.connect(pointer.config);
      const rebuilt = this.pools.get(pointer.key);
      if (!rebuilt) throw new Error(BROKEN_POOL);
      return rebuilt;
    }

    if (!this.bootstrapped.has(sessionId)) {
      const def = getDefaultConfig();
      if (def) {
        await this.connect(def);
        const entry = this.pools.get(poolKey(def));
        if (entry) return entry;
      }
      this.bootstrapped.add(sessionId);
    }
    throw new Error(NOT_CONNECTED);
  }

  /** 连接(或复用)指定库,并把**当前会话**的指针指过去;不影响其他会话 */
  public async connect(config: DatabaseConfig): Promise<void> {
    const sessionId = currentSessionId();
    // 无论成功与否都算初始化过:连失败后不能再被默认库静默接管
    this.bootstrapped.add(sessionId);
    const previous = this.sessions.get(sessionId);

    let entry: PoolEntry;
    try {
      entry = await this.acquire(config);
    } catch (error) {
      // fail-closed:与改造前一致(改造前 connect 先 await disconnect() 再建池,失败后是断开态)。
      // 绝不能保持指向上一个库 —— switch_db('test') 失败后会话若还留在 prod,
      // agent 只扫一眼返回值就继续 execute,写的还是 prod,这是数据事故不是体验问题。
      if (previous) {
        this.sessions.delete(sessionId);
        this.release(previous.key);
      }
      const reason = error instanceof Error ? error.message : String(error);
      const target = `${config.type}://${config.host}:${config.port}/${config.database}`;
      throw new Error(
        `连接 ${target} 失败: ${reason}` +
        (previous
          ? `；原连接 ${previous.config.database} 已断开，当前会话处于未连接状态，请重新 connect / switch_db`
          : '')
      );
    }

    this.sessions.set(sessionId, { key: entry.key, config });
    // 先占新池再放旧池:同库重连时引用计数一进一出,池不会被误关
    if (previous) this.release(previous.key);
  }

  /** 断开**当前会话**的连接;其他会话仍在用同一个池时池不会被关 */
  public async disconnect(): Promise<void> {
    const sessionId = currentSessionId();
    this.bootstrapped.add(sessionId);
    const pointer = this.sessions.get(sessionId);
    if (!pointer) return;
    this.sessions.delete(sessionId);
    this.release(pointer.key);
    // 引用归零且 POOL_IDLE_MS<=0(stdio)时 release 会立刻触发 destroy;
    // 等它把 end() 走完再返回,与改造前 `await pgPool.end()` 的语义一致。
    await this.destroying.get(pointer.key);
  }

  /** HTTP 会话关闭 / TTL 过期时调用:释放该会话占的池引用,防止池永远回收不掉 */
  public releaseSession(sessionId: string): void {
    const pointer = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.bootstrapped.delete(sessionId);
    if (pointer) this.release(pointer.key);
  }

  /** 进程退出时统一收尾 */
  public async closeAll(): Promise<void> {
    this.sessions.clear();
    this.bootstrapped.clear();
    await Promise.all([...this.pools.keys()].map(key => this.destroy(key)));
    // 还有 release()/sweep 已经触发、但 end() 尚未跑完的池 —— 它们早就不在 pools 里了,
    // 不一并等就等于没收尾(进程随后 exit(0) 会把 end() 打断)
    await Promise.all([...this.destroying.values()]);
  }

  /** HTTP 启动预热:提前建好默认库的池并验证可连通(不绑定到任何会话) */
  public async warmupDefault(): Promise<DatabaseConfig | null> {
    const config = getDefaultConfig();
    if (!config) return null;
    const entry = await this.acquire(config);
    // 预热不是"某个会话在用",立即还回引用,交给空闲回收兜底
    this.release(entry.key);
    return config;
  }

  public async getStatus(): Promise<ConnectionStatus> {
    const sessionId = currentSessionId();
    if (!this.sessions.has(sessionId) && !this.bootstrapped.has(sessionId)) {
      // 首次使用套用 .env 默认库,让 status 反映"开箱即连"的既有行为;
      // 连不上就如实报未连接,status 本身不应抛错
      const def = getDefaultConfig();
      if (def) { try { await this.connect(def); } catch { /* 忽略:下面按未连接返回 */ } }
      this.bootstrapped.add(sessionId);
    }
    const pointer = this.sessions.get(sessionId);
    const alive = pointer ? this.pools.has(pointer.key) : false;
    return {
      connected: alive,
      type: alive ? pointer!.config.type : null,
      host: alive ? pointer!.config.host : null,
      database: alive ? pointer!.config.database : null,
      sessionId,
      pools: this.pools.size
    };
  }

  public isConnected(): boolean {
    const pointer = this.sessions.get(currentSessionId());
    return pointer !== undefined && this.pools.has(pointer.key);
  }

  // ==================== 查询缓存 ====================

  private cleanCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.queryCache.entries()) {
      if (now - entry.timestamp > this.CACHE_TTL) { this.queryCache.delete(key); }
    }
    if (this.queryCache.size > this.MAX_CACHE_SIZE) {
      const entries = Array.from(this.queryCache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      entries.slice(0, entries.length - this.MAX_CACHE_SIZE).forEach(([key]) => this.queryCache.delete(key));
    }
  }

  // 缓存 key 必须带 configKey:否则切库后 60s 内同一条 SELECT 会返回上一个库的结果
  private getCacheKey(configKey: string, sql: string, params?: unknown[]): string {
    return `${configKey}\u0000${sql}:${JSON.stringify(params || [])}`;
  }

  /** 只失效该库的缓存:往 A 库写数据没理由把 B 库的查询缓存也清掉 */
  private invalidateCache(configKey: string): void {
    const prefix = `${configKey}\u0000`;
    for (const key of this.queryCache.keys()) {
      if (key.startsWith(prefix)) this.queryCache.delete(key);
    }
    // 版本号 +1:此刻还在飞行中的 SELECT(它读到的是失效前的快照)回来后不许再写缓存,
    // 否则清了也白清 —— 多会话共享同一份缓存时这条路径是真会走到的。
    this.cacheGen.set(configKey, (this.cacheGen.get(configKey) ?? 0) + 1);
  }

  // ==================== 只读判定 ====================
  //
  // ⚠️ 这一段曾经只有一行 `/^\s*(select|with|...)/`,实测能被两种写法直接绕过,
  //    而 query / export_csv / explain_query 都标着 readOnlyHint:true —— 宿主据此不做确认:
  //
  //      SELECT 1; CREATE TEMP TABLE t(x int); INSERT INTO t VALUES (42)
  //        → pg 的简单查询协议**逐条执行**,建表加写入全部落地(实测 42 能读回来)
  //      WITH x AS (INSERT INTO t VALUES (1) RETURNING 1) SELECT * FROM x
  //        → 以 WITH 开头,老正则判为只读,可写 CTE 照样写
  //
  // 所以现在是三层:① 剥掉字符串/注释再判断 ② 拒多语句 + 查写关键字
  // ③ **引擎级只读事务**兜底。前两层给清晰报错,第三层保证「没想到的花样」也写不进去。

  /**
   * 剥掉字符串字面量、引号标识符与注释,只留结构性文本。
   * 关键字和分号必须在这份文本上判断:否则 `SELECT 'delete'` 会被误杀,
   * 而 `SELECT 1 /* ; * / ; DELETE …` 里的真分号会被漏看。
   */
  private stripSqlNoise(sql: string): string {
    let out = '';
    let i = 0;
    while (i < sql.length) {
      const c = sql[i]!;
      const next = sql[i + 1];
      if (c === '-' && next === '-') {                     // 行注释
        while (i < sql.length && sql[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && next === '*') {                     // 块注释(PG 可嵌套)
        let depth = 1;
        i += 2;
        while (i < sql.length && depth > 0) {
          if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; }
          else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; }
          else i++;
        }
        out += ' ';
        continue;
      }
      if (c === '$') {                                     // 美元引用 $$ … $$ / $tag$ … $tag$
        const m = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
        if (m) {
          const tag = m[0];
          const end = sql.indexOf(tag, i + tag.length);
          i = end === -1 ? sql.length : end + tag.length;
          out += ' ';
          continue;
        }
      }
      if (c === "'" || c === '"' || c === '`') {            // 字符串 / 引号标识符,'' 为转义
        const q = c;
        i++;
        while (i < sql.length) {
          if (sql[i] === q) {
            if (sql[i + 1] === q) { i += 2; continue; }
            i++;
            break;
          }
          i++;
        }
        out += ' ';
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  /** 只读语句允许的开头 */
  private static readonly RO_HEAD = /^\s*(select|with|show|explain|describe|desc|table|values)\b/i;

  /**
   * 会改数据的关键字 —— **出现在任何位置**都算写,这是拦可写 CTE 的关键。
   * 都加了 \b,所以 `create_time` / `deleted_at` / `offset` 这类列名不会误伤。
   * `into` 必须在列表里:`SELECT * INTO 新表 FROM …` 在 PG 里是建表。
   */
  private static readonly MUTATING =
    /\b(insert|update|delete|merge|truncate|create|drop|alter|grant|revoke|call|do|copy|vacuum|reindex|refresh|import|execute|prepare|into)\b/i;

  /** 返回拒绝理由;为 null 表示确实只读。 */
  private readOnlyViolation(sql: string, tool: string): string | null {
    const stripped = this.stripSqlNoise(sql);
    if (stripped.replace(/;\s*$/, '').includes(';')) {
      return `${tool} 一次只接受一条 SQL:分号拼接会被数据库逐条执行,是绕过只读限制的口子。请拆开单独调用,写操作用 execute 工具`;
    }
    if (!DatabaseManager.RO_HEAD.test(stripped)) {
      return `${tool} 仅允许只读语句（SELECT/WITH/SHOW/EXPLAIN），写操作请改用 execute 工具`;
    }
    const m = DatabaseManager.MUTATING.exec(stripped);
    if (m) {
      return `${tool} 仅允许只读语句:检测到写操作关键字 ${m[1]!.toUpperCase()}（如 WITH … AS (INSERT …) 这类可写 CTE)。写操作请改用 execute 工具`;
    }
    return null;
  }

  /** 判断语句是否只读 */
  private isReadOnlySql(sql: string): boolean {
    return this.readOnlyViolation(sql, 'query') === null;
  }

  // ==================== 查询执行 ====================

  /**
   * 在**引擎级只读事务**里执行 —— 上面的文本判断只负责给出清晰报错,
   * 真正的保证在这里:PG `BEGIN READ ONLY` / MySQL `START TRANSACTION READ ONLY`
   * 会让任何写入直接失败,不依赖我们把所有绕过写法都想全。
   */
  private async runReadOnly(entry: PoolEntry, sql: string, params?: unknown[]): Promise<QueryResult> {
    if (entry.pg) {
      const client = await entry.pg.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const r = await client.query(sql, params);
        await client.query('COMMIT');
        // SHOW / 部分工具语句的 rowCount 是 null,直接 ?? 0 会出现「有行但 rowCount:0」
        return { rows: r.rows, rowCount: r.rowCount ?? r.rows.length, fields: r.fields?.map(f => f.name) };
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* 连接可能已废,吞掉以免盖住真正的错 */ }
        throw e;
      } finally {
        client.release();
      }
    }
    if (entry.mysql) {
      const conn = await entry.mysql.getConnection();
      try {
        await conn.query('START TRANSACTION READ ONLY');
        const [rows, fields] = await conn.execute(sql, params as any);
        await conn.query('COMMIT');
        const rowArray = Array.isArray(rows) ? rows : [rows];
        return { rows: rowArray as Record<string, unknown>[], rowCount: rowArray.length, fields: (fields as mysql.FieldPacket[])?.map(f => f.name) };
      } catch (e) {
        try { await conn.query('ROLLBACK'); } catch { /* 同上 */ }
        throw e;
      } finally {
        conn.release();
      }
    }
    throw new Error(BROKEN_POOL);
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const entry = await this.ensureEntry();
    // query 工具只允许只读语句，写操作必须走 execute（带 destructiveHint，宿主会要求确认）
    const violation = this.readOnlyViolation(sql, 'query');
    if (violation) throw new Error(violation);
    const isSelect = /^\s*select\b/i.test(this.stripSqlNoise(sql));
    const cacheKey = this.getCacheKey(entry.key, sql, params);
    if (isSelect) {
      const cached = this.queryCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        console.log('[Cache Hit] 使用缓存结果');
        return cached.result;
      }
    }
    const gen = this.cacheGen.get(entry.key) ?? 0;
    const result = await this.runReadOnly(entry, sql, params);
    // 查询期间本库发生过写入/换池 → 这份结果已经是旧快照,直接返回但不进缓存
    if (isSelect && (this.cacheGen.get(entry.key) ?? 0) === gen) {
      this.queryCache.set(cacheKey, { result, timestamp: Date.now() });
    }
    return result;
  }

  public async execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }> {
    const entry = await this.ensureEntry();
    if (!entry.pg && !entry.mysql) throw new Error(BROKEN_POOL);
    // 失效必须发生在语句**执行之后**:缓存现在按 configKey 全服务共享,
    // 若先失效再执行,本次写入期间别的会话跑同一条 SELECT 会把写入前的旧结果重新塞回缓存,
    // 于是写完之后 60s 内(包括写入方自己)读到的都是陈旧数据。
    // 放在 finally 里:语句报错也可能已经改了部分数据,一律以失效为准。
    try {
      if (entry.pg) {
        const result = await entry.pg.query(sql, params);
        return { affectedRows: result.rowCount ?? 0 };
      }
      const [result] = await entry.mysql!.execute(sql, params as any);
      return { affectedRows: (result as mysql.ResultSetHeader).affectedRows ?? 0 };
    } finally {
      this.invalidateCache(entry.key);
    }
  }

  public async listTables(schema?: string): Promise<TableInfo[]> {
    const entry = await this.ensureEntry();
    if (entry.pg) {
      const schemaName = schema ?? 'public';
      const result = await entry.pg.query(`SELECT table_name as name, table_schema as schema, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [schemaName]);
      return result.rows.map(row => ({ name: row.name, schema: row.schema, type: row.table_type === 'VIEW' ? 'view' : 'table' }));
    } else if (entry.mysql) {
      const [rows] = await entry.mysql.execute(`SELECT table_name as name, table_type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name`);
      return (rows as Record<string, unknown>[]).map(row => ({ name: row.name as string, type: row.table_type === 'VIEW' ? 'view' : 'table' }));
    }
    throw new Error(BROKEN_POOL);
  }

  public async describeTable(table: string, schema?: string): Promise<ColumnInfo[]> {
    const entry = await this.ensureEntry();
    if (entry.pg) {
      const schemaName = schema ?? 'public';
      const result = await entry.pg.query(`
        SELECT c.column_name as name, c.data_type as type, c.is_nullable = 'YES' as nullable, c.column_default as default_value,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key
        FROM information_schema.columns c
        LEFT JOIN (SELECT ku.column_name FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
          WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
        ) pk ON c.column_name = pk.column_name
        WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position
      `, [schemaName, table]);
      return result.rows.map(row => ({ name: row.name, type: row.type, nullable: row.nullable, defaultValue: row.default_value, isPrimaryKey: row.is_primary_key }));
    } else if (entry.mysql) {
      const [rows] = await entry.mysql.execute(`
        SELECT COLUMN_NAME as name, DATA_TYPE as type, IS_NULLABLE = 'YES' as nullable,
          COLUMN_DEFAULT as default_value, COLUMN_KEY = 'PRI' as is_primary_key
        FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position
      `, [table]);
      return (rows as Record<string, unknown>[]).map(row => ({ name: row.name as string, type: row.type as string, nullable: Boolean(row.nullable), defaultValue: row.default_value as string | null, isPrimaryKey: Boolean(row.is_primary_key) }));
    }
    throw new Error(BROKEN_POOL);
  }

  public async listDatabases(): Promise<string[]> {
    const entry = await this.ensureEntry();
    if (entry.pg) {
      const result = await entry.pg.query(`SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`);
      return result.rows.map(row => row.datname);
    } else if (entry.mysql) {
      const [rows] = await entry.mysql.execute('SHOW DATABASES');
      return (rows as Record<string, unknown>[]).map(row => row.Database as string);
    }
    throw new Error(BROKEN_POOL);
  }

  // === New: EXPLAIN query ===
  public async explainQuery(sql: string): Promise<QueryResult> {
    const entry = await this.ensureEntry();
    // 多语句在这里格外危险:`EXPLAIN (FORMAT JSON) SELECT 1; DROP TABLE t` 会被逐条执行,
    // 而 explain_query 标着 readOnlyHint:true,宿主不会拦。一律拒。
    if (this.stripSqlNoise(sql).replace(/;\s*$/, '').includes(';')) {
      throw new Error('explain_query 一次只接受一条 SQL:分号拼接会被数据库逐条执行');
    }
    if (entry.pg) {
      // EXPLAIN ANALYZE 会真正执行语句！只对确认只读的语句加 ANALYZE,
      // 且放进只读事务里跑 —— 可写 CTE(`WITH x AS (DELETE … RETURNING …)`)以前正是从这里
      // 被判成「只读」然后被 ANALYZE 真删掉的。
      const readOnly = this.isReadOnlySql(sql);
      if (readOnly) {
        return await this.runReadOnly(entry, 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql);
      }
      const result = await entry.pg.query(`EXPLAIN (FORMAT JSON) ${sql}`);
      return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length, fields: result.fields?.map(f => f.name) };
    } else if (entry.mysql) {
      const [rows, fields] = await entry.mysql.execute(`EXPLAIN ${sql}`);
      return { rows: rows as Record<string, unknown>[], rowCount: (rows as unknown[]).length, fields: fields?.map(f => f.name) };
    }
    throw new Error(BROKEN_POOL);
  }

  // === New: Table indexes ===
  public async getTableIndexes(table: string, schema?: string): Promise<Record<string, unknown>[]> {
    const entry = await this.ensureEntry();
    if (entry.pg) {
      const s = schema ?? 'public';
      const result = await entry.pg.query(`
        SELECT i.relname AS index_name, a.attname AS column_name,
               ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
               am.amname AS index_type
        FROM pg_index ix
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
        JOIN pg_am am ON am.oid = i.relam
        WHERE t.relname = $1 AND n.nspname = $2
        ORDER BY i.relname`, [table, s]);
      return result.rows;
    } else if (entry.mysql) {
      // 表名是标识符不能参数化，转义反引号防注入
      const safeTable = table.replace(/`/g, '``');
      const [rows] = await entry.mysql.query(`SHOW INDEX FROM \`${safeTable}\``);
      return rows as Record<string, unknown>[];
    }
    throw new Error(BROKEN_POOL);
  }

  // === New: Table relations (foreign keys) ===
  public async getTableRelations(table: string, schema?: string): Promise<Record<string, unknown>[]> {
    const entry = await this.ensureEntry();
    if (entry.pg) {
      const s = schema ?? 'public';
      const result = await entry.pg.query(`
        SELECT tc.constraint_name, kcu.column_name,
               ccu.table_schema AS foreign_schema, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1 AND tc.table_schema = $2`, [table, s]);
      return result.rows;
    } else if (entry.mysql) {
      const db = entry.config.database;
      const [rows] = await entry.mysql.execute(`
        SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME AS foreign_table, REFERENCED_COLUMN_NAME AS foreign_column
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`, [db, table]);
      return rows as Record<string, unknown>[];
    }
    throw new Error(BROKEN_POOL);
  }

  // === New: Table size stats ===
  public async getTableStats(schema?: string): Promise<Record<string, unknown>[]> {
    const entry = await this.ensureEntry();
    if (entry.pg) {
      const s = schema ?? 'public';
      const result = await entry.pg.query(`
        SELECT relname AS table_name,
               n_live_tup AS row_estimate,
               pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
               pg_size_pretty(pg_relation_size(relid)) AS data_size,
               pg_size_pretty(pg_indexes_size(relid)) AS index_size
        FROM pg_stat_user_tables WHERE schemaname = $1 ORDER BY pg_total_relation_size(relid) DESC`, [s]);
      return result.rows;
    } else if (entry.mysql) {
      const db = entry.config.database;
      const [rows] = await entry.mysql.execute(`
        SELECT TABLE_NAME AS table_name, TABLE_ROWS AS row_estimate,
               CONCAT(ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2), ' MB') AS total_size,
               CONCAT(ROUND(DATA_LENGTH / 1024 / 1024, 2), ' MB') AS data_size,
               CONCAT(ROUND(INDEX_LENGTH / 1024 / 1024, 2), ' MB') AS index_size
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC`, [db]);
      return rows as Record<string, unknown>[];
    }
    throw new Error(BROKEN_POOL);
  }

  // === New: Export query to CSV string ===
  public async exportCsv(sql: string): Promise<string> {
    const result = await this.query(sql);
    if (result.rows.length === 0) return '';
    const headers = Object.keys(result.rows[0]!);
    const csvRows = [headers.join(',')];
    for (const row of result.rows) {
      csvRows.push(headers.map(h => {
        const val = row[h];
        const str = val === null || val === undefined ? '' : String(val);
        return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
      }).join(','));
    }
    return csvRows.join('\n');
  }
}

export function getDatabaseManager(): DatabaseManager {
  return DatabaseManager.getInstance();
}
