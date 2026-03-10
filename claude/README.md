# Claude Code MCP 服务 (Linux/macOS)

为 Claude Code 提供**浏览器自动化**和**数据库操作**能力的 MCP 服务。

基于 Playwright + Express + MCP SDK，支持有头和无头两种模式。

## 服务列表

| 服务 | PM2 配置 | 端口 | 模式 | 说明 |
|------|----------|------|------|------|
| Browser MCP (有头) | `ecosystem.config.cjs` | 3213 | GUI 桌面 | 可视化浏览器，适合本地调试 |
| Browser MCP (无头) | `ecosystem.headless.cjs` | 3211 | 无头 SSH | 服务器环境，无需桌面 |
| Database MCP | `mcp-database/ecosystem.config.cjs` | 3214 | — | PostgreSQL / MySQL 查询 |

> 有头和无头使用**同一套源码**，通过 `HEADLESS` 环境变量切换。

## 系统要求

- Linux (Debian 12+) 或 macOS 10.15+
- Node.js >= 18
- PM2（`npm install -g pm2`）

## 快速安装

```bash
# 1. 一键安装（依赖 + 构建 + Chromium）
bash install-all.sh

# 2. 配置数据库（可选）
cp mcp-database/.env.example mcp-database/.env
nano mcp-database/.env
```

## 启动服务

```bash
# 方式一：交互式管理菜单
bash manage.sh

# 方式二：直接 PM2 启动
# 无头模式（服务器 / SSH 环境推荐）
pm2 start ecosystem.headless.cjs

# 有头模式（桌面环境）
pm2 start ecosystem.config.cjs

# 数据库 MCP
cd mcp-database && pm2 start ecosystem.config.cjs
```

## Claude Code 配置

编辑 `~/.config/claude-code/mcp.json`：

### 无头模式（服务器环境，推荐）

```json
{
  "mcpServers": {
    "headless-browser": {
      "type": "url",
      "url": "http://localhost:3211/mcp"
    },
    "database": {
      "type": "url",
      "url": "http://localhost:3214/mcp"
    }
  }
}
```

### 有头模式（桌面环境）

```json
{
  "mcpServers": {
    "browser": {
      "type": "url",
      "url": "http://localhost:3213/mcp"
    },
    "database": {
      "type": "url",
      "url": "http://localhost:3214/mcp"
    }
  }
}
```

## 数据库配置

编辑 `mcp-database/.env`：

```env
DB_TYPE=postgresql
DB_HOST=192.168.50.242
DB_PORT=6432
DB_NAME=csgo
DB_USER=csgo
DB_PASSWORD=your_password_here
DB_SSL=false
PORT=3214
```

支持预设多个数据库，通过别名快速切换：

```env
DB_PROD_TYPE=postgresql
DB_PROD_HOST=prod.example.com
DB_PROD_PORT=5432
DB_PROD_NAME=production
DB_PROD_USER=admin
DB_PROD_PASSWORD=secret
```

## 脚本说明

| 脚本 | 说明 |
|------|------|
| `install-all.sh` | 一键安装（依赖 + 构建 + Chromium） |
| `install.sh` | 仅安装浏览器 MCP |
| `manage.sh` | 交互式服务管理（启动/停止/重启/日志） |
| `mcp-all-manage.sh` | 总管理脚本（浏览器 + 数据库） |
| `check-mcp-health.sh` | 健康检查 |
| `diagnose.sh` | 诊断工具 |

## 浏览器 MCP 工具（22 个）

导航、点击、填表、截图、多标签页管理、Cookie 操作、JS 执行、
网络拦截、PDF 导出、元素提取、页面爬取、拖拽、键盘输入等。

## 数据库 MCP 工具

SQL 查询、表结构查看、索引分析、数据导出、多数据库切换等。

## 故障排查

```bash
# 检查服务状态
pm2 list

# 检查端口
ss -tlnp | grep -E '3211|3213|3214'

# 查看日志
pm2 logs claudemcp-headless --lines 50

# 完整诊断
bash diagnose.sh
```
