/**
 * 数据库连接管理器
 * @description 支持 PostgreSQL 和 MySQL 的统一连接管理
 */

import pg from 'pg';
import mysql from 'mysql2/promise';
import type { 
  DatabaseConfig, 
  DatabaseType, 
  QueryResult, 
  TableInfo, 
  ColumnInfo,
  ConnectionStatus 
} from './types.js';

/** 简单的查询缓存 */
interface CacheEntry {
  result: QueryResult;
  timestamp: number;
}

/** 数据库管理器单例 */
class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private pgPool: pg.Pool | null = null;
  private mysqlPool: mysql.Pool | null = null;
  private currentType: DatabaseType | null = null;
  private currentConfig: DatabaseConfig | null = null;
  private queryCache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL = 60000; // 60秒缓存（高性能模式）
  private readonly MAX_CACHE_SIZE = 500; // 增加缓存容量

  private constructor() {
    // 定期清理过期缓存
    setInterval(() => this.cleanCache(), 60000);
  }

  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) {
      DatabaseManager.instance = new DatabaseManager();
    }
    return DatabaseManager.instance;
  }

  /** 连接数据库 */
  public async connect(config: DatabaseConfig): Promise<void> {
    // 先断开现有连接
    await this.disconnect();

    this.currentConfig = config;
    this.currentType = config.type;

    if (config.type === 'postgresql') {
      this.pgPool = new pg.Pool({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        max: 50,              // 高性能：50个连接
        min: 5,               // 保持5个热连接
        idleTimeoutMillis: 120000,  // 2分钟空闲超时
        connectionTimeoutMillis: 15000,
        allowExitOnIdle: false,
        statement_timeout: 60000,   // 60秒语句超时
        query_timeout: 60000,
        application_name: 'mcp-database-bridge-turbo'
      });
      // 测试连接
      const client = await this.pgPool.connect();
      client.release();
    } else {
      this.mysqlPool = mysql.createPool({
        host: config.host,
        port: config.port,
        database: config.database,
        user: config.user,
        password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        waitForConnections: true,
        connectionLimit: 50,  // 高性能：50个连接
        maxIdle: 20,          // 保持20个空闲连接
        idleTimeout: 120000,  // 2分钟空闲超时
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
        multipleStatements: false,
        namedPlaceholders: true
      });
      // 测试连接
      const conn = await this.mysqlPool.getConnection();
      conn.release();
    }
  }

  /** 断开连接 */
  public async disconnect(): Promise<void> {
    if (this.pgPool) {
      await this.pgPool.end();
      this.pgPool = null;
    }
    if (this.mysqlPool) {
      await this.mysqlPool.end();
      this.mysqlPool = null;
    }
    this.currentType = null;
    this.currentConfig = null;
  }

  /** 获取连接状态 */
  public getStatus(): ConnectionStatus {
    return {
      connected: this.isConnected(),
      type: this.currentType,
      host: this.currentConfig?.host ?? null,
      database: this.currentConfig?.database ?? null
    };
  }

  /** 检查是否已连接 */
  public isConnected(): boolean {
    return this.pgPool !== null || this.mysqlPool !== null;
  }

  /** 清理过期缓存 */
  private cleanCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.queryCache.entries()) {
      if (now - entry.timestamp > this.CACHE_TTL) {
        this.queryCache.delete(key);
      }
    }
    // 如果缓存过大，删除最旧的条目
    if (this.queryCache.size > this.MAX_CACHE_SIZE) {
      const entries = Array.from(this.queryCache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toDelete = entries.slice(0, entries.length - this.MAX_CACHE_SIZE);
      toDelete.forEach(([key]) => this.queryCache.delete(key));
    }
  }

  /** 生成缓存键 */
  private getCacheKey(sql: string, params?: unknown[]): string {
    return `${sql}:${JSON.stringify(params || [])}`;
  }

  /** 执行查询（带缓存） */
  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.isConnected()) {
      throw new Error('未连接数据库，请先调用 connect 工具');
    }

    // 只缓存 SELECT 查询
    const isSelect = sql.trim().toLowerCase().startsWith('select');
    if (isSelect) {
      const cacheKey = this.getCacheKey(sql, params);
      const cached = this.queryCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        console.log('[Cache Hit] 使用缓存结果');
        return cached.result;
      }
    }

    let result: QueryResult;
    if (this.currentType === 'postgresql' && this.pgPool) {
      const pgResult = await this.pgPool.query(sql, params);
      result = {
        rows: pgResult.rows,
        rowCount: pgResult.rowCount ?? 0,
        fields: pgResult.fields?.map(f => f.name)
      };
    } else if (this.mysqlPool) {
      const [rows, fields] = await this.mysqlPool.execute(sql, params);
      const rowArray = Array.isArray(rows) ? rows : [rows];
      result = {
        rows: rowArray as Record<string, unknown>[],
        rowCount: rowArray.length,
        fields: (fields as mysql.FieldPacket[])?.map(f => f.name)
      };
    } else {
      throw new Error('数据库连接异常');
    }

    // 缓存 SELECT 查询结果
    if (isSelect) {
      const cacheKey = this.getCacheKey(sql, params);
      this.queryCache.set(cacheKey, { result, timestamp: Date.now() });
    }

    return result;
  }

  /** 执行操作(INSERT/UPDATE/DELETE) */
  public async execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }> {
    if (!this.isConnected()) {
      throw new Error('未连接数据库，请先调用 connect 工具');
    }

    if (this.currentType === 'postgresql' && this.pgPool) {
      const result = await this.pgPool.query(sql, params);
      return { affectedRows: result.rowCount ?? 0 };
    } else if (this.mysqlPool) {
      const [result] = await this.mysqlPool.execute(sql, params);
      return { affectedRows: (result as mysql.ResultSetHeader).affectedRows ?? 0 };
    }

    throw new Error('数据库连接异常');
  }

  /** 列出所有表 */
  public async listTables(schema?: string): Promise<TableInfo[]> {
    if (!this.isConnected()) {
      throw new Error('未连接数据库，请先调用 connect 工具');
    }

    if (this.currentType === 'postgresql' && this.pgPool) {
      const schemaName = schema ?? 'public';
      const result = await this.pgPool.query(`
        SELECT table_name as name, table_schema as schema, table_type
        FROM information_schema.tables 
        WHERE table_schema = $1
        ORDER BY table_name
      `, [schemaName]);
      return result.rows.map(row => ({
        name: row.name,
        schema: row.schema,
        type: row.table_type === 'VIEW' ? 'view' : 'table'
      }));
    } else if (this.mysqlPool) {
      const [rows] = await this.mysqlPool.execute(`
        SELECT table_name as name, table_type
        FROM information_schema.tables 
        WHERE table_schema = DATABASE()
        ORDER BY table_name
      `);
      return (rows as Record<string, unknown>[]).map(row => ({
        name: row.name as string,
        type: row.table_type === 'VIEW' ? 'view' : 'table'
      }));
    }

    throw new Error('数据库连接异常');
  }

  /** 描述表结构 */
  public async describeTable(table: string, schema?: string): Promise<ColumnInfo[]> {
    if (!this.isConnected()) {
      throw new Error('未连接数据库，请先调用 connect 工具');
    }

    if (this.currentType === 'postgresql' && this.pgPool) {
      const schemaName = schema ?? 'public';
      const result = await this.pgPool.query(`
        SELECT 
          c.column_name as name,
          c.data_type as type,
          c.is_nullable = 'YES' as nullable,
          c.column_default as default_value,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT ku.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku 
            ON tc.constraint_name = ku.constraint_name
          WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
        ) pk ON c.column_name = pk.column_name
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position
      `, [schemaName, table]);
      return result.rows.map(row => ({
        name: row.name,
        type: row.type,
        nullable: row.nullable,
        defaultValue: row.default_value,
        isPrimaryKey: row.is_primary_key
      }));
    } else if (this.mysqlPool) {
      const [rows] = await this.mysqlPool.execute(`
        SELECT 
          COLUMN_NAME as name,
          DATA_TYPE as type,
          IS_NULLABLE = 'YES' as nullable,
          COLUMN_DEFAULT as default_value,
          COLUMN_KEY = 'PRI' as is_primary_key
        FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name = ?
        ORDER BY ordinal_position
      `, [table]);
      return (rows as Record<string, unknown>[]).map(row => ({
        name: row.name as string,
        type: row.type as string,
        nullable: Boolean(row.nullable),
        defaultValue: row.default_value as string | null,
        isPrimaryKey: Boolean(row.is_primary_key)
      }));
    }

    throw new Error('数据库连接异常');
  }

  /** 列出所有数据库 */
  public async listDatabases(): Promise<string[]> {
    if (!this.isConnected()) {
      throw new Error('未连接数据库，请先调用 connect 工具');
    }

    if (this.currentType === 'postgresql' && this.pgPool) {
      const result = await this.pgPool.query(`
        SELECT datname FROM pg_database 
        WHERE datistemplate = false 
        ORDER BY datname
      `);
      return result.rows.map(row => row.datname);
    } else if (this.mysqlPool) {
      const [rows] = await this.mysqlPool.execute('SHOW DATABASES');
      return (rows as Record<string, unknown>[]).map(row => row.Database as string);
    }

    throw new Error('数据库连接异常');
  }
}

/** 获取数据库管理器实例 */
export function getDatabaseManager(): DatabaseManager {
  return DatabaseManager.getInstance();
}
