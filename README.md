# Local MCP Browser

为 AI 编程助手提供**本地浏览器操控**和**数据库操作**能力的 MCP 服务。基于 Playwright + Express + MCP SDK。

## 多个版本

| 版本 | 目录 | 适用 IDE / 工具 | 说明 |
|------|------|----------------|------|
| **Cursor** | [cursor/](./cursor/) | Cursor | Windows，完整独立 |
| **Cursor Mac** | [cursor-mac/](./cursor-mac/) | Cursor (macOS) | macOS，完整独立 |
| **Windsurf** | [windsurf/](./windsurf/) | Windsurf (Codeium) | Windows，完整独立 |
| **Windsurf Mac** | [windsurf-mac/](./windsurf-mac/) | Windsurf (macOS) | macOS，完整独立 |
| **Claude** | [claude/](./claude/) | Claude Code (macOS/Linux/Windows) | v2.0.0，stdio 原生 + HTTP 双传输 |

> 所有版本功能一致，仅服务名称、传输方式和脚本格式不同。每个文件夹都是**完全自包含**的，复制到任意机器即可独立运行。
>
> **Claude 版（v2.0.0）** 是当前推荐版本：跨平台（macOS / Linux / Windows），同时支持 **stdio 原生模式**（Claude Code 直接拉起进程，无需 PM2 / 端口，最简单）和 **HTTP 模式**（长驻服务，适合服务器或多客户端共享）。

## 使用方法

### Claude 版（推荐）

```bash
cd claude

# 1. 安装（跨平台 Node CLI，macOS / Linux / Windows 通用）
node mcp.mjs install

# 2. 推荐：stdio 原生模式 —— 获取配置命令并注册
node mcp.mjs config
#   按提示执行 claude mcp add ...，或复制 .mcp.json.example 到项目根目录

# 2'. 或使用 HTTP / PM2 模式
node mcp.mjs start
```

详见 [`claude/README.md`](./claude/README.md)。

### 其他版本

1. 复制对应版本的文件夹到目标机器
2. Windows: 运行 `install-all.bat`；macOS / Linux: 运行 `bash install-all.sh`
3. Windows: 运行 `manage.bat`；macOS / Linux: 运行 `bash manage.sh`

## 系统要求

- Node.js >= 20（Claude 版 v2.0.0；其他版本 >= 18）
- HTTP / PM2 模式需要 PM2（`npm install -g pm2`）；Claude 版的 stdio 模式无需 PM2
