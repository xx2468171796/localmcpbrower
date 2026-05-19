# Local MCP Browser

为 Claude Code 提供**本地浏览器操控**和**数据库操作**能力的 MCP 服务。基于 Playwright 浏览器自动化 + 数据库 MCP，让 Claude Code 可以直接驱动本地浏览器并访问数据库。

## 特性

- **浏览器 MCP** —— Playwright 驱动，支持导航、点击、填表、截图、爬取、网络拦截、PDF 导出等。
- **数据库 MCP** —— PostgreSQL / MySQL 查询、表结构查看、索引分析、CSV 导出、多数据库切换。
- **双传输模式** —— **stdio 原生模式**（Claude Code 直接拉起进程，无需 PM2 / 端口，最简单）与 **HTTP（Streamable HTTP）模式**（长驻服务，适合服务器或多客户端共享）。
- **跨平台** —— macOS / Linux / Windows 通用。

## 系统要求

- Node.js >= 20
- macOS 10.15+ / Linux / Windows 10+

## 快速开始

```bash
cd claude

# 1. 安装（跨平台 Node CLI）
node mcp.mjs install

# 2. 推荐：stdio 原生模式 —— 获取配置命令并注册
node mcp.mjs config

# 2'. 或使用 HTTP / PM2 模式
node mcp.mjs start
```

## 文档

- [`DEPLOY.md`](./DEPLOY.md) —— **新机器 / 多机部署指南**（macOS / Linux / Windows 一步步走）
- [`claude/README.md`](./claude/README.md) —— 完整安装、配置与用法
- [`USAGE.md`](./USAGE.md) —— 工具调用规则（给 AI 看的手册）
