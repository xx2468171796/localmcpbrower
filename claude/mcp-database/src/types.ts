/**
 * TypeScript 类型定义
 */

export type DatabaseType = 'postgresql' | 'mysql';

export interface DatabaseConfig {
  type: DatabaseType;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields?: string[];
}

export interface TableInfo {
  name: string;
  schema?: string;
  type: 'table' | 'view';
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
}

export interface ToolSuccessResult<T> {
  success: true;
  data: T;
}

export interface ToolErrorResult {
  success: false;
  error: string;
}

export type ToolResult<T> = ToolSuccessResult<T> | ToolErrorResult;

export interface ConnectionStatus {
  connected: boolean;
  type: DatabaseType | null;
  host: string | null;
  database: string | null;
  /** 当前会话标识:HTTP 多会话共享服务时用于区分「我这条连接」,stdio 恒为 __stdio__ */
  sessionId?: string;
  /** 全服务当前存活的共享连接池数量(排障用) */
  pools?: number;
}
