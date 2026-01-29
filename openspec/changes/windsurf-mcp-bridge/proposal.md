# Windsurf-MCP-Bridge 提案

## Why (为什么需要)

在使用 Windsurf 进行 AI 辅助开发时，默认的浏览器 MCP 工具存在以下**核心痛点**：

1. **不稳定性** - 基于 `stdio` 的连接在 IDE 窗口切换或重启时极易断开
2. **状态丢失** - 每次启动都是新浏览器，无法保持登录状态（如 GitHub、后台管理系统）
3. **调试困难** - 难以实时查看浏览器内部的控制台报错（Console Logs）
4. **视觉盲区** - AI 无法"看见"网页的真实样式来判断 UI Bug
5. **资源浪费** - 多窗口运行多个浏览器实例，占用大量内存

**目标**：通过一个常驻的 SSE 服务，为 Windsurf 提供一个**稳定、可复用、具备视觉反馈**的浏览器中台。

---

## What Changes (变更内容)

构建一个 **Node.js 后端服务**，采用 **Client-Server** 架构：

| 组件 | 描述 |
|------|------|
| **Host (Server)** | PM2 守护的 Node.js 进程，管理 Playwright 实例 |
| **Client** | 一个或多个 Windsurf 项目窗口 |
| **Transport** | HTTP + SSE 隧道，确保跨进程通信稳定性 |

**核心目录结构**：
```
/windsurf-mcp-bridge
├── /src
│   ├── browser.ts    # Playwright 封装 (单例、截图、日志)
│   ├── server.ts     # Express & SSE 路由控制
│   └── tools.ts      # MCP 工具定义 (向 AI 暴露的接口)
├── /storage          
│   ├── /user_data    # 浏览器 Cookie 和缓存
│   └── /screenshots  # AI 生成的截图文件
├── package.json
└── ecosystem.config.js # PM2 配置文件
```

---

## Capabilities (能力清单)

### 1. browser-singleton
**浏览器常驻与复用**
- 使用 `launchPersistentContext` 持久化存储 Cookie/缓存
- 全局单例 Chromium 实例，所有 Windsurf 窗口共享
- 支持 `headless: false` 可视化调试模式

### 2. mcp-tools
**增强型 MCP 工具集**
| 工具名称 | 参数 | 功能描述 |
|----------|------|----------|
| `navigate` | `url` | 跳转至指定网址 |
| `click` | `selector` | 点击元素，自动滚动到视图内 |
| `type` | `selector, text` | 模拟真实键盘输入 |
| `take_screenshot` | `name, fullPage` | 截取当前页面，保存至 `storage/screenshots` |
| `get_console_logs` | 无 | 获取页面所有 console 输出 |
| `get_network` | 无 | 获取网络请求状态 (404/500 等) |
| `execute_js` | `script` | 执行自定义 JavaScript 并返回结果 |

### 3. sse-transport
**SSE 传输层**
- HTTP + SSE 双工通信
- 支持多客户端并发连接
- 断线自动重连机制

### 4. process-guard
**进程守护与监控**
- PM2 守护进程，崩溃后 0.5s 内自动重启
- 日志透传：捕获 `page.on('console')` 事件
- 结构化错误返回

---

## Non-goals (不做什么)

- ❌ **不做前端 UI** - 这是纯后端服务，无界面
- ❌ **不支持多浏览器实例** - 单例模式，节省资源
- ❌ **不做复杂的会话管理** - 依赖 Playwright 持久化上下文
- ❌ **不做 WebSocket** - 使用更简单的 SSE 协议
- ❌ **不做数据库持久化** - 日志仅在内存中临时存储

---

## Impact (影响范围)

### 新增文件
- `src/browser.ts` - Playwright 浏览器管理器
- `src/server.ts` - Express + SSE 服务器
- `src/tools.ts` - MCP 工具定义
- `src/types.ts` - TypeScript 类型定义
- `src/schemas.ts` - Zod 验证 Schema
- `ecosystem.config.js` - PM2 配置
- `tsconfig.json` - TypeScript 配置
- `package.json` - 依赖管理

### 依赖项
```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "latest",
    "playwright": "latest",
    "express": "^4.18.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/express": "^4.17.0",
    "@types/node": "^20.0.0"
  }
}
```

### Windsurf 配置变更
```json
"mcpServers": {
  "my-stable-browser": {
    "type": "sse",
    "url": "http://localhost:3000/sse"
  }
}
```

---

## 验收标准

- [ ] **多窗口共享**：打开两个不同的 Windsurf 项目，均能操作同一个浏览器窗口
- [ ] **登录复用**：在项目 A 登录后，项目 B 无需重新登录即可访问受限页面
- [ ] **视觉确认**：执行 `take_screenshot` 后，`storage/screenshots` 文件夹下生成正确的图片文件
- [ ] **调试透明**：当网页代码报错时，Windsurf 的对话框能直接显示出 `Console Error` 信息
- [ ] **断线重连**：手动关闭浏览器窗口，PM2 能自动重新拉起服务
