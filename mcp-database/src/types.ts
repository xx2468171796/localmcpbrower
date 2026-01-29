/**
 * TypeScript 类型定义
 */

/** 数据库类型 */
export type DatabaseType = 'postgresql' | 'mysql';

/** 数据库连接配置 */
export interface DatabaseConfig {
  type: DatabaseType;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

/** 查询结果 */
export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  fields?: string[];
}

/** 表信息 */
export interface TableInfo {
  name: string;
  schema?: string;
  type: 'table' | 'view';
}

/** 列信息 */
export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  isPrimaryKey: boolean;
}

/** 工具执行成功结果 */
export interface ToolSuccessResult<T> {
  success: true;
  data: T;
}

/** 工具执行失败结果 */
export interface ToolErrorResult {
  success: false;
  error: string;
}

/** 工具执行结果联合类型 */
export type ToolResult<T> = ToolSuccessResult<T> | ToolErrorResult;

/** 连接池状态 */
export interface ConnectionStatus {
  connected: boolean;
  type: DatabaseType | null;
  host: string | null;
  database: string | null;
}
