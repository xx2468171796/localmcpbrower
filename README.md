# Local MCP Browser

为 Claude Code / Codex 等 MCP 客户端提供**本地浏览器操控**和**数据库操作**能力的 MCP 服务。基于 Patchright（Playwright 反检测分支）+ MCP SDK，让 AI 可以直接驱动本地浏览器并访问数据库。

## 特性

- **浏览器 MCP（39 个工具）** —— Patchright 1.61 驱动（自带反检测，Chromium 149），支持导航、点击、填表、截图、无障碍快照（snapshot+ref 操作）、正文提取（defuddle 转 Markdown）、站点 URL 发现、批量爬取、网络拦截、PDF 导出等。
- **数据库 MCP（15 个工具）** —— PostgreSQL / MySQL 查询、表结构查看、索引分析、CSV 导出、多数据库预设切换；`query` 强制只读，写操作必须走 `execute`。
- **双传输模式** —— **stdio 原生模式**（Claude Code 直接拉起进程，无需 PM2 / 端口，最简单）与 **HTTP（Streamable HTTP）模式**（长驻服务，适合服务器或多客户端共享）。
- **跨平台** —— macOS / Linux / Windows 通用，单入口 `node mcp.mjs <cmd>`。
- **进程安全** —— stdio 模式多重退出兜底（信号 / stdin / ppid 轮询 / exit 钩子），SSH 断开不留孤儿 Chromium。
- **服务级 instructions** —— v2.1.0 起两个 MCP 在 initialize 时下发使用说明，支持的客户端（Claude Code / Codex 等）会自动注入 AI 上下文，AI 无需读文档即知工具的正确配合方式。
- **国内网络适配** —— `install` / `update` 自动探测 npm 官方源，不可达时自动切换 npmmirror 镜像（含 Chromium 二进制下载），也可用 `NPM_REGISTRY` 环境变量显式指定源。

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

## 日常更新

仓库有新版本时，一条命令完成升级（拉代码 + 重装依赖 + 校验浏览器 + 重新构建 + 重启 PM2 服务）：

```bash
node claude/mcp.mjs update
```

stdio 模式下次 Claude Code 会话自动生效；对 AI 说"更新本地 MCP"即可触发。

## 文档

- [`DEPLOY.md`](./DEPLOY.md) —— **新机器 / 多机部署指南**（macOS / Linux / Windows 一步步走）
- [`claude/README.md`](./claude/README.md) —— 完整安装、配置与用法
- [`CODEX.md`](./CODEX.md) —— Codex CLI 全局 MCP 注册、调用与排障
- [`USAGE.md`](./USAGE.md) —— 工具调用规则（给 AI 看的手册）
