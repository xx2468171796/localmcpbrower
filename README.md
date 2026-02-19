# Local MCP Browser

为 AI 编程助手提供**本地浏览器操控**和**数据库操作**能力的 MCP 服务。基于 Playwright + Express + MCP SDK。

## 两个版本

| 版本 | 目录 | 适用 IDE | 说明 |
|------|------|----------|------|
| **Cursor** | [cursor/](./cursor/) | Cursor | 完整独立，可单独复制使用 |
| **Windsurf** | [windsurf/](./windsurf/) | Windsurf (Codeium) | 完整独立，可单独复制使用 |

> 两个版本功能完全一致，仅服务名称和 PM2 配置不同。每个文件夹都是**完全自包含**的，复制到任意机器即可独立运行。

## 使用方法

1. 复制对应版本的文件夹到目标机器
2. 运行 `install-all.bat` 一键安装
3. 运行 `manage.bat` 管理服务

每个版本文件夹内包含：
- 浏览器 MCP 源码 + 22 个工具（端口 3211）
- 数据库 MCP 源码 + 10 个工具（端口 3212）
- `manage.bat` — 服务管理脚本
- `install-all.bat` — 一键安装脚本
- `diagnose.bat` — 诊断工具
- `README.md` — 使用说明

## 系统要求

- Node.js >= 18
- PM2（`npm install -g pm2`）
