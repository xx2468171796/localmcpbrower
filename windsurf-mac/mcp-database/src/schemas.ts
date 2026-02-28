/**
 * Zod 输入验证规则
 */

import { z } from 'zod';

export const ConnectSchema = z.object({
  type: z.enum(['postgresql', 'mysql']).describe('数据库类型'),
  host: z.string().min(1).describe('主机地址'),
  port: z.number().int().positive().describe('端口号'),
  database: z.string().min(1).describe('数据库名'),
  user: z.string().min(1).describe('用户名'),
  password: z.string().describe('密码'),
  ssl: z.boolean().optional().describe('是否启用SSL')
});

export const SwitchDbSchema = z.object({
  alias: z.string().min(1).describe('预设数据库别名(如PROD/TEST)')
});

export const QuerySchema = z.object({
  sql: z.string().min(1).describe('SQL查询语句'),
  params: z.array(z.unknown()).optional().describe('查询参数')
});

export const ExecuteSchema = z.object({
  sql: z.string().min(1).describe('SQL操作语句'),
  params: z.array(z.unknown()).optional().describe('操作参数')
});

export const ListTablesSchema = z.object({
  schema: z.string().optional().describe('模式名(PostgreSQL)')
});

export const DescribeTableSchema = z.object({
  table: z.string().min(1).describe('表名'),
  schema: z.string().optional().describe('模式名(PostgreSQL)')
});

export const ExplainQuerySchema = z.object({
  sql: z.string().min(1).describe('要分析的SQL语句')
});

export const TableIndexesSchema = z.object({
  table: z.string().min(1).describe('表名'),
  schema: z.string().optional().describe('模式名')
});

export const TableRelationsSchema = z.object({
  table: z.string().min(1).describe('表名'),
  schema: z.string().optional().describe('模式名')
});

export const TableStatsSchema = z.object({
  schema: z.string().optional().describe('模式名')
});

export const ExportCsvSchema = z.object({
  sql: z.string().min(1).describe('SQL查询语句')
});
