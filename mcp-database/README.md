# MCP Database Bridge

基于 Streamable HTTP 的数据库操作 MCP 服务，支持 PostgreSQL 和 MySQL。

## 功能

| 工具 | 说明 |
|------|------|
| `connect` | 连接数据库 |
| `disconnect` | 断开连接 |
| `status` | 获取连接状态 |
| `query` | 执行 SELECT 查询 |
| `execute` | 执行 INSERT/UPDATE/DELETE |
| `list_tables` | 列出所有表 |
| `describe_table` | 获取表结构 |
| `list_databases` | 列出所有数据库 |

## 快速开始

### 安装依赖

```bash
npm install
npm run build
```

### 启动服务

```bash
npm start
```

服务默认运行在 `http://localhost:3212`

### MCP 配置

在 Windsurf/Cursor 中添加：

```json
{
  "mcpServers": {
    "database": {
      "serverUrl": "http://localhost:3212/mcp"
    }
  }
}
```

## 使用示例

### 连接 PostgreSQL

```
connect({
  type: "postgresql",
  host: "localhost",
  port: 5432,
  database: "mydb",
  user: "postgres",
  password: "password"
})
```

### 连接 MySQL

```
connect({
  type: "mysql",
  host: "localhost",
  port: 3306,
  database: "mydb",
  user: "root",
  password: "password"
})
```

### 查询数据

```
query({ sql: "SELECT * FROM users LIMIT 10" })
```

### 带参数查询

PostgreSQL:
```
query({ sql: "SELECT * FROM users WHERE id = $1", params: [1] })
```

MySQL:
```
query({ sql: "SELECT * FROM users WHERE id = ?", params: [1] })
```

### 列出表

```
list_tables({})
```

### 获取表结构

```
describe_table({ table: "users" })
```

## 端口配置

默认端口 3212，可通过环境变量修改：

```bash
PORT=3212 npm start
```
