# Local MCP Browser

为 AI 编程助手提供**本地浏览器操控**和**数据库操作**能力的 MCP 服务。基于 Playwright + Express + MCP SDK。

## 三个版本

| 版本 | 目录 | 适用 IDE / 工具 | 说明 |
|------|------|----------------|------|
| **Cursor** | [cursor/](./cursor/) | Cursor | Windows，完整独立 |
| **Cursor Mac** | [cursor-mac/](./cursor-mac/) | Cursor (macOS) | macOS，完整独立 |
| **Windsurf** | [windsurf/](./windsurf/) | Windsurf (Codeium) | Windows，完整独立 |
| **Windsurf Mac** | [windsurf-mac/](./windsurf-mac/) | Windsurf (macOS) | macOS，完整独立 |
| **Claude** | [claude/](./claude/) | Claude Code (Linux/macOS) | Shell 脚本，服务器环境 |

> 所有版本功能一致，仅服务名称、PM2 配置和脚本格式不同。每个文件夹都是**完全自包含**的，复制到任意机器即可独立运行。

## 使用方法

1. 复制对应版本的文件夹到目标机器
2. Windows: 运行 `install-all.bat`；Linux: 运行 `bash install-all.sh`
3. Windows: 运行 `manage.bat`；Linux: 运行 `bash manage.sh`

每个版本文件夹内包含：
- 浏览器 MCP 源码 + 22 个工具（端口 3211）
- 数据库 MCP 源码 + 10 个工具（端口 3212）
- 管理脚本（`.bat` / `.sh`）
- 一键安装脚本
- 诊断工具
- `README.md` — 使用说明

## 系统要求

- Node.js >= 18
- PM2（`npm install -g pm2`）
