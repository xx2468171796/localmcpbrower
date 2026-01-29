# Windsurf-MCP-Bridge 任务清单

## Phase 1: 项目初始化

- [x] 创建 package.json，配置依赖和脚本
- [x] 创建 tsconfig.json，配置 TypeScript 严格模式
- [x] 创建 ecosystem.config.js，配置 PM2

## Phase 2: 核心模块

- [x] 创建 src/types.ts，定义 TypeScript 类型
- [x] 创建 src/schemas.ts，定义 Zod 验证 Schema
- [x] 创建 src/browser.ts，实现 BrowserManager 单例
- [x] 创建 src/tools.ts，实现 7 个 MCP 工具
- [x] 创建 src/server.ts，实现 Express + SSE + MCP 服务

## Phase 3: 存储目录

- [x] 创建 storage/user_data/.gitkeep
- [x] 创建 storage/screenshots/.gitkeep
- [x] 更新 .gitignore，忽略 storage 内容

## Phase 4: 文档与配置

- [x] 创建 README.md，包含使用说明
- [x] 创建 .env.example，列出环境变量

## Phase 5: 依赖安装与验证

- [x] 安装 npm 依赖
- [x] 安装 Playwright 浏览器
- [x] 验证 TypeScript 编译
