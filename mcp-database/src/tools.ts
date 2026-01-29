/**
 * MCP 数据库工具定义
 */

import { getDatabaseManager } from './database.js';
import {
  ConnectSchema,
  QuerySchema,
  ExecuteSchema,
  ListTablesSchema,
  DescribeTableSchema
} from './schemas.js';
import type { ToolResult, QueryResult, TableInfo, ColumnInfo, ConnectionStatus } from './types.js';

/** 连接数据库 */
export async function connect(input: unknown): Promise<ToolResult<{ message: string }>> {
  try {
    const parsed = ConnectSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const db = getDatabaseManager();
    await db.connect(parsed.data);

    return {
      success: true,
      data: { message: `已连接到 ${parsed.data.type} 数据库: ${parsed.data.host}:${parsed.data.port}/${parsed.data.database}` }
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 断开连接 */
export async function disconnect(): Promise<ToolResult<{ message: string }>> {
  try {
    const db = getDatabaseManager();
    await db.disconnect();
    return { success: true, data: { message: '已断开数据库连接' } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 获取连接状态 */
export async function status(): Promise<ToolResult<ConnectionStatus>> {
  try {
    const db = getDatabaseManager();
    return { success: true, data: db.getStatus() };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 执行查询 */
export async function query(input: unknown): Promise<ToolResult<QueryResult>> {
  try {
    const parsed = QuerySchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const db = getDatabaseManager();
    const result = await db.query(parsed.data.sql, parsed.data.params);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 执行操作 */
export async function execute(input: unknown): Promise<ToolResult<{ affectedRows: number }>> {
  try {
    const parsed = ExecuteSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const db = getDatabaseManager();
    const result = await db.execute(parsed.data.sql, parsed.data.params);
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 列出表 */
export async function listTables(input: unknown): Promise<ToolResult<{ tables: TableInfo[] }>> {
  try {
    const parsed = ListTablesSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const db = getDatabaseManager();
    const tables = await db.listTables(parsed.data.schema);
    return { success: true, data: { tables } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 描述表结构 */
export async function describeTable(input: unknown): Promise<ToolResult<{ columns: ColumnInfo[] }>> {
  try {
    const parsed = DescribeTableSchema.safeParse(input);
    if (!parsed.success) {
      return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    }

    const db = getDatabaseManager();
    const columns = await db.describeTable(parsed.data.table, parsed.data.schema);
    return { success: true, data: { columns } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 列出数据库 */
export async function listDatabases(): Promise<ToolResult<{ databases: string[] }>> {
  try {
    const db = getDatabaseManager();
    const databases = await db.listDatabases();
    return { success: true, data: { databases } };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
