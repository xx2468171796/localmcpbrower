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
}
