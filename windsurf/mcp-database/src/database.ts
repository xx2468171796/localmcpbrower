/**
 * 数据库连接管理器 - 支持 PostgreSQL 和 MySQL
 */

import pg from 'pg';
import mysql from 'mysql2/promise';
import type { DatabaseConfig, DatabaseType, QueryResult, TableInfo, ColumnInfo, ConnectionStatus } from './types.js';

interface CacheEntry { result: QueryResult; timestamp: number; }

class DatabaseManager {
  private static instance: DatabaseManager | null = null;
  private pgPool: pg.Pool | null = null;
  private mysqlPool: mysql.Pool | null = null;
  private currentType: DatabaseType | null = null;
  private currentConfig: DatabaseConfig | null = null;
  private queryCache: Map<string, CacheEntry> = new Map();
  private readonly CACHE_TTL = 60000;
  private readonly MAX_CACHE_SIZE = 500;

  private constructor() { setInterval(() => this.cleanCache(), 60000); }

  public static getInstance(): DatabaseManager {
    if (!DatabaseManager.instance) { DatabaseManager.instance = new DatabaseManager(); }
    return DatabaseManager.instance;
  }

  public async connect(config: DatabaseConfig): Promise<void> {
    await this.disconnect();
    this.currentConfig = config;
    this.currentType = config.type;

    if (config.type === 'postgresql') {
      this.pgPool = new pg.Pool({
        host: config.host, port: config.port, database: config.database,
        user: config.user, password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        max: 50, min: 5, idleTimeoutMillis: 120000, connectionTimeoutMillis: 15000,
        allowExitOnIdle: false, statement_timeout: 60000, query_timeout: 60000,
        application_name: 'mcp-database-bridge'
      });
      const client = await this.pgPool.connect();
      client.release();
    } else {
      this.mysqlPool = mysql.createPool({
        host: config.host, port: config.port, database: config.database,
        user: config.user, password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
        waitForConnections: true, connectionLimit: 50, maxIdle: 20,
        idleTimeout: 120000, queueLimit: 0, enableKeepAlive: true,
        keepAliveInitialDelay: 0, multipleStatements: false, namedPlaceholders: true
      });
      const conn = await this.mysqlPool.getConnection();
      conn.release();
    }
  }

  public async disconnect(): Promise<void> {
    if (this.pgPool) { await this.pgPool.end(); this.pgPool = null; }
    if (this.mysqlPool) { await this.mysqlPool.end(); this.mysqlPool = null; }
    this.currentType = null;
    this.currentConfig = null;
  }

  public getStatus(): ConnectionStatus {
    return {
      connected: this.isConnected(),
      type: this.currentType,
      host: this.currentConfig?.host ?? null,
      database: this.currentConfig?.database ?? null
    };
  }

  public isConnected(): boolean {
    return this.pgPool !== null || this.mysqlPool !== null;
  }

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

  private getCacheKey(sql: string, params?: unknown[]): string {
    return `${sql}:${JSON.stringify(params || [])}`;
  }

  public async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    if (!this.isConnected()) throw new Error('未连接数据库，请先调用 connect 工具');
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
      result = { rows: pgResult.rows, rowCount: pgResult.rowCount ?? 0, fields: pgResult.fields?.map(f => f.name) };
    } else if (this.mysqlPool) {
      const [rows, fields] = await this.mysqlPool.execute(sql, params);
      const rowArray = Array.isArray(rows) ? rows : [rows];
      result = { rows: rowArray as Record<string, unknown>[], rowCount: rowArray.length, fields: (fields as mysql.FieldPacket[])?.map(f => f.name) };
    } else { throw new Error('数据库连接异常'); }
    if (isSelect) { this.queryCache.set(this.getCacheKey(sql, params), { result, timestamp: Date.now() }); }
    return result;
  }

  public async execute(sql: string, params?: unknown[]): Promise<{ affectedRows: number }> {
    if (!this.isConnected()) throw new Error('未连接数据库，请先调用 connect 工具');
    if (this.currentType === 'postgresql' && this.pgPool) {
      const result = await this.pgPool.query(sql, params);
      return { affectedRows: result.rowCount ?? 0 };
    } else if (this.mysqlPool) {
      const [result] = await this.mysqlPool.execute(sql, params);
      return { affectedRows: (result as mysql.ResultSetHeader).affectedRows ?? 0 };
    }
    throw new Error('数据库连接异常');
  }

  public async listTables(schema?: string): Promise<TableInfo[]> {
    if (!this.isConnected()) throw new Error('未连接数据库，请先调用 connect 工具');
    if (this.currentType === 'postgresql' && this.pgPool) {
      const schemaName = schema ?? 'public';
      const result = await this.pgPool.query(`SELECT table_name as name, table_schema as schema, table_type FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`, [schemaName]);
      return result.rows.map(row => ({ name: row.name, schema: row.schema, type: row.table_type === 'VIEW' ? 'view' : 'table' }));
    } else if (this.mysqlPool) {
      const [rows] = await this.mysqlPool.execute(`SELECT table_name as name, table_type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name`);
      return (rows as Record<string, unknown>[]).map(row => ({ name: row.name as string, type: row.table_type === 'VIEW' ? 'view' : 'table' }));
    }
    throw new Error('数据库连接异常');
  }

  public async describeTable(table: string, schema?: string): Promise<ColumnInfo[]> {
    if (!this.isConnected()) throw new Error('未连接数据库，请先调用 connect 工具');
    if (this.currentType === 'postgresql' && this.pgPool) {
      const schemaName = schema ?? 'public';
      const result = await this.pgPool.query(`
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
    } else if (this.mysqlPool) {
      const [rows] = await this.mysqlPool.execute(`
        SELECT COLUMN_NAME as name, DATA_TYPE as type, IS_NULLABLE = 'YES' as nullable,
          COLUMN_DEFAULT as default_value, COLUMN_KEY = 'PRI' as is_primary_key
        FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position
      `, [table]);
      return (rows as Record<string, unknown>[]).map(row => ({ name: row.name as string, type: row.type as string, nullable: Boolean(row.nullable), defaultValue: row.default_value as string | null, isPrimaryKey: Boolean(row.is_primary_key) }));
    }
    throw new Error('数据库连接异常');
  }

  public async listDatabases(): Promise<string[]> {
    if (!this.isConnected()) throw new Error('未连接数据库，请先调用 connect 工具');
    if (this.currentType === 'postgresql' && this.pgPool) {
      const result = await this.pgPool.query(`SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`);
      return result.rows.map(row => row.datname);
    } else if (this.mysqlPool) {
      const [rows] = await this.mysqlPool.execute('SHOW DATABASES');
      return (rows as Record<string, unknown>[]).map(row => row.Database as string);
    }
    throw new Error('数据库连接异常');
  }

  // === New: EXPLAIN query ===
  public async explainQuery(sql: string): Promise<QueryResult> {
    this.ensureConnected();
    if (this.pgPool) {
      const result = await this.pgPool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`);
      return { rows: result.rows, rowCount: result.rowCount ?? 0, fields: result.fields?.map(f => f.name) };
    } else if (this.mysqlPool) {
      const [rows, fields] = await this.mysqlPool.execute(`EXPLAIN ${sql}`);
      return { rows: rows as Record<string, unknown>[], rowCount: (rows as unknown[]).length, fields: fields?.map(f => f.name) };
    }
    throw new Error('数据库连接异常');
  }

  // === New: Table indexes ===
  public async getTableIndexes(table: string, schema?: string): Promise<Record<string, unknown>[]> {
    this.ensureConnected();
    if (this.pgPool) {
      const s = schema ?? 'public';
      const result = await this.pgPool.query(`
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
    } else if (this.mysqlPool) {
      const [rows] = await this.mysqlPool.execute(`SHOW INDEX FROM \`${table}\``);
      return rows as Record<string, unknown>[];
    }
    throw new Error('数据库连接异常');
  }

  // === New: Table relations (foreign keys) ===
  public async getTableRelations(table: string, schema?: string): Promise<Record<string, unknown>[]> {
    this.ensureConnected();
    if (this.pgPool) {
      const s = schema ?? 'public';
      const result = await this.pgPool.query(`
        SELECT tc.constraint_name, kcu.column_name,
               ccu.table_schema AS foreign_schema, ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1 AND tc.table_schema = $2`, [table, s]);
      return result.rows;
    } else if (this.mysqlPool) {
      const db = this.currentConfig?.database ?? '';
      const [rows] = await this.mysqlPool.execute(`
        SELECT CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME AS foreign_table, REFERENCED_COLUMN_NAME AS foreign_column
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`, [db, table]);
      return rows as Record<string, unknown>[];
    }
    throw new Error('数据库连接异常');
  }

  // === New: Table size stats ===
  public async getTableStats(schema?: string): Promise<Record<string, unknown>[]> {
    this.ensureConnected();
    if (this.pgPool) {
      const s = schema ?? 'public';
      const result = await this.pgPool.query(`
        SELECT relname AS table_name,
               n_live_tup AS row_estimate,
               pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
               pg_size_pretty(pg_relation_size(relid)) AS data_size,
               pg_size_pretty(pg_indexes_size(relid)) AS index_size
        FROM pg_stat_user_tables WHERE schemaname = $1 ORDER BY pg_total_relation_size(relid) DESC`, [s]);
      return result.rows;
    } else if (this.mysqlPool) {
      const db = this.currentConfig?.database ?? '';
      const [rows] = await this.mysqlPool.execute(`
        SELECT TABLE_NAME AS table_name, TABLE_ROWS AS row_estimate,
               CONCAT(ROUND((DATA_LENGTH + INDEX_LENGTH) / 1024 / 1024, 2), ' MB') AS total_size,
               CONCAT(ROUND(DATA_LENGTH / 1024 / 1024, 2), ' MB') AS data_size,
               CONCAT(ROUND(INDEX_LENGTH / 1024 / 1024, 2), ' MB') AS index_size
        FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY (DATA_LENGTH + INDEX_LENGTH) DESC`, [db]);
      return rows as Record<string, unknown>[];
    }
    throw new Error('数据库连接异常');
  }

  // === New: Export query to CSV string ===
  public async exportCsv(sql: string): Promise<string> {
    this.ensureConnected();
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

  private ensureConnected(): void {
    if (!this.pgPool && !this.mysqlPool) throw new Error('未连接数据库，请先使用 connect 工具连接');
  }
}

export function getDatabaseManager(): DatabaseManager {
  return DatabaseManager.getInstance();
}
