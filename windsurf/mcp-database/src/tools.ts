/**
 * MCP 数据库工具定义
 */

import { getDatabaseManager } from './database.js';
import { ConnectSchema, QuerySchema, ExecuteSchema, ListTablesSchema, DescribeTableSchema, SwitchDbSchema } from './schemas.js';
import type { ToolResult, QueryResult, TableInfo, ColumnInfo, ConnectionStatus, DatabaseType } from './types.js';

function getPresetConfig(alias: string): { type: DatabaseType; host: string; port: number; database: string; user: string; password: string; ssl: boolean } | null {
  const prefix = `DB_${alias.toUpperCase()}_`;
  const type = process.env[`${prefix}TYPE`] as DatabaseType | undefined;
  const host = process.env[`${prefix}HOST`];
  const port = process.env[`${prefix}PORT`];
  const database = process.env[`${prefix}NAME`];
  const user = process.env[`${prefix}USER`];
  const password = process.env[`${prefix}PASSWORD`];
  const ssl = process.env[`${prefix}SSL`] === 'true';
  if (!type || !host || !port || !database || !user) return null;
  return { type, host, port: parseInt(port, 10), database, user, password: password ?? '', ssl };
}

export async function listPresets(): Promise<ToolResult<{ presets: string[] }>> {
  const presets: string[] = [];
  const aliasSet = new Set<string>();
  for (const key of Object.keys(process.env)) {
    const match = key.match(/^DB_([A-Z0-9_]+)_TYPE$/);
    if (match) aliasSet.add(match[1]);
  }
  for (const alias of aliasSet) {
    const config = getPresetConfig(alias);
    if (config) presets.push(`${alias} (${config.type}://${config.host}:${config.port}/${config.database})`);
  }
  return { success: true, data: { presets } };
}

export async function switchDb(input: unknown): Promise<ToolResult<{ message: string }>> {
  try {
    const parsed = SwitchDbSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    const config = getPresetConfig(parsed.data.alias);
    if (!config) return { success: false, error: `未找到预设数据库: ${parsed.data.alias}` };
    await getDatabaseManager().connect(config);
    return { success: true, data: { message: `已切换到 ${parsed.data.alias}: ${config.type}://${config.host}:${config.port}/${config.database}` } };
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function connect(input: unknown): Promise<ToolResult<{ message: string }>> {
  try {
    const parsed = ConnectSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    await getDatabaseManager().connect(parsed.data);
    return { success: true, data: { message: `已连接到 ${parsed.data.type}: ${parsed.data.host}:${parsed.data.port}/${parsed.data.database}` } };
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function disconnect(): Promise<ToolResult<{ message: string }>> {
  try { await getDatabaseManager().disconnect(); return { success: true, data: { message: '已断开数据库连接' } }; }
  catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function status(): Promise<ToolResult<ConnectionStatus>> {
  try { return { success: true, data: getDatabaseManager().getStatus() }; }
  catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function query(input: unknown): Promise<ToolResult<QueryResult>> {
  try {
    const parsed = QuerySchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    return { success: true, data: await getDatabaseManager().query(parsed.data.sql, parsed.data.params) };
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function execute(input: unknown): Promise<ToolResult<{ affectedRows: number }>> {
  try {
    const parsed = ExecuteSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    return { success: true, data: await getDatabaseManager().execute(parsed.data.sql, parsed.data.params) };
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function listTables(input: unknown): Promise<ToolResult<{ tables: TableInfo[] }>> {
  try {
    const parsed = ListTablesSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    return { success: true, data: { tables: await getDatabaseManager().listTables(parsed.data.schema) } };
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function describeTable(input: unknown): Promise<ToolResult<{ columns: ColumnInfo[] }>> {
  try {
    const parsed = DescribeTableSchema.safeParse(input);
    if (!parsed.success) return { success: false, error: `参数验证失败: ${parsed.error.message}` };
    return { success: true, data: { columns: await getDatabaseManager().describeTable(parsed.data.table, parsed.data.schema) } };
  } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}

export async function listDatabases(): Promise<ToolResult<{ databases: string[] }>> {
  try { return { success: true, data: { databases: await getDatabaseManager().listDatabases() } }; }
  catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
}
