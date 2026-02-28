# Cursor MCP Bridge (macOS 版)

为 Cursor AI 编程助手提供 **本地浏览器操控** 和 **数据库操作** 能力的 MCP 服务。

基于 Playwright + Express + MCP SDK，适配 macOS。

## 功能

| 服务 | 端口 | 工具数 | 说明 |
|------|------|--------|------|
| Browser MCP | 3211 | 22 个 | 浏览器自动化（导航、点击、截图、多标签页等） |
| Database MCP | 3212 | 15 个 | 数据库操作（PostgreSQL / MySQL 查询、表结构、性能分析等） |

## 系统要求

- macOS 10.15+
- Node.js >= 18（`brew install node`）
- PM2（`npm install -g pm2`）

## 快速开始

```bash
# 1. 一键安装
./install-all.sh

# 2. 管理服务（交互式菜单）
./manage.sh
```

## 脚本说明

| 脚本 | 说明 |
|------|------|
| `install-all.sh` | 一键安装所有依赖、构建项目、安装 Chromium |
| `manage.sh` | 交互式服务管理（启动/停止/重启/日志/状态） |
| `diagnose.sh` | 诊断工具，检查环境和服务状态 |

## Cursor 配置

在 `~/.cursor/mcp.json` 中添加：

```json
{
  "mcpServers": {
    "stable-browser": {
      "url": "http://localhost:3211/mcp"
    },
    "database": {
      "url": "http://localhost:3212/mcp"
    }
  }
}
```

## 数据库配置

编辑 `mcp-database/.env` 文件配置数据库连接：

```env
DB_TYPE=postgresql
DB_HOST=localhost
DB_PORT=5432
DB_NAME=mydb
DB_USER=postgres
DB_PASSWORD=your_password_here
```

## 与 Windows 版的区别

- `.bat` 脚本 → `.sh` 脚本
- `netstat` + `taskkill` → `lsof` + `kill`（端口进程管理）
- `notepad` → `open -t` / `nano`（编辑器）
- 配置路径 `C:\Users\USERNAME\.cursor\` → `~/.cursor/`
- TypeScript 源码完全一致，无需修改
