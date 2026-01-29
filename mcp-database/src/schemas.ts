/**
 * Zod 输入验证规则
 */

import { z } from 'zod';

/** 连接数据库 */
export const ConnectSchema = z.object({
  type: z.enum(['postgresql', 'mysql']).describe('数据库类型'),
  host: z.string().min(1).describe('主机地址'),
  port: z.number().int().positive().describe('端口号'),
  database: z.string().min(1).describe('数据库名'),
  user: z.string().min(1).describe('用户名'),
  password: z.string().describe('密码'),
  ssl: z.boolean().optional().describe('是否启用SSL')
});

/** 通过别名切换预设数据库 */
export const SwitchDbSchema = z.object({
  alias: z.string().min(1).describe('预设数据库别名(如PROD/TEST)')
});

/** 列出预设数据库 */
export const ListPresetsSchema = z.object({});

/** 执行查询 */
export const QuerySchema = z.object({
  sql: z.string().min(1).describe('SQL查询语句'),
  params: z.array(z.unknown()).optional().describe('查询参数')
});

/** 执行操作(INSERT/UPDATE/DELETE) */
export const ExecuteSchema = z.object({
  sql: z.string().min(1).describe('SQL操作语句'),
  params: z.array(z.unknown()).optional().describe('操作参数')
});

/** 列出表 */
export const ListTablesSchema = z.object({
  schema: z.string().optional().describe('模式名(PostgreSQL)')
});

/** 描述表结构 */
export const DescribeTableSchema = z.object({
  table: z.string().min(1).describe('表名'),
  schema: z.string().optional().describe('模式名(PostgreSQL)')
});

/** 列出数据库 */
export const ListDatabasesSchema = z.object({});

/** 断开连接 */
export const DisconnectSchema = z.object({});

/** 获取连接状态 */
export const StatusSchema = z.object({});
