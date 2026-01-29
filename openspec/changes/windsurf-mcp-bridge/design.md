# Windsurf-MCP-Bridge 设计文档

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                    Windsurf IDE                          │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                 │
│  │Project A│  │Project B│  │Project C│                 │
│  └────┬────┘  └────┬────┘  └────┬────┘                 │
│       │            │            │                       │
│       └────────────┼────────────┘                       │
│                    │ SSE Connection                     │
└────────────────────┼────────────────────────────────────┘
                     ▼
┌────────────────────────────────────────────────────────┐
│              windsurf-mcp-bridge (PM2)                  │
│  ┌──────────────────────────────────────────────────┐  │
│  │                  server.ts                        │  │
│  │  ┌─────────┐  ┌─────────────┐  ┌──────────────┐  │  │
│  │  │ Express │──│ SSE Handler │──│ MCP Protocol │  │  │
│  │  └─────────┘  └─────────────┘  └──────┬───────┘  │  │
│  └───────────────────────────────────────┼──────────┘  │
│                                          ▼              │
│  ┌──────────────────────────────────────────────────┐  │
│  │                  tools.ts                         │  │
│  │  navigate | click | type | screenshot | ...       │  │
│  └──────────────────────────────────────────────────┘  │
│                          │                              │
│                          ▼                              │
│  ┌──────────────────────────────────────────────────┐  │
│  │                 browser.ts                        │  │
│  │  BrowserManager (Singleton)                       │  │
│  │  ┌────────────────────────────────────────────┐  │  │
│  │  │ Playwright BrowserContext (Persistent)      │  │  │
│  │  │  └── Page (Active Tab)                      │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
                     │
                     ▼
         ┌───────────────────────┐
         │     storage/          │
         │  ├── user_data/       │ (Cookie/Cache)
         │  └── screenshots/     │ (截图文件)
         └───────────────────────┘
```

## 模块职责

| 模块 | 文件 | 职责 |
|------|------|------|
| **Browser Manager** | `src/browser.ts` | Playwright 单例管理、持久化上下文、日志收集 |
| **MCP Tools** | `src/tools.ts` | 工具定义、Zod 验证、执行逻辑 |
| **SSE Server** | `src/server.ts` | Express 服务、SSE 连接管理、MCP 协议处理 |
| **Types** | `src/types.ts` | TypeScript 类型定义 |
| **Schemas** | `src/schemas.ts` | Zod 验证 Schema |

## 技术决策

### 1. 为什么用 SSE 而不是 WebSocket？
- MCP SDK 原生支持 SSE Transport
- 比 WebSocket 更简单，足够满足需求
- HTTP/1.1 兼容性更好

### 2. 为什么用单例模式？
- 节省系统资源（一个 Chromium 实例）
- 保持登录状态跨窗口共享
- 简化状态管理

### 3. 为什么用 PM2？
- 成熟的进程管理器
- 自动重启、日志管理
- 无需额外学习成本

## 错误处理策略

```typescript
type ToolResult<T> = 
  | { success: true; data: T }
  | { success: false; error: string };
```

所有工具统一返回此格式，便于 AI 理解执行结果。

## 日志收集机制

```typescript
// 监听 page console 事件
page.on('console', (msg) => {
  consoleLogs.push({
    type: msg.type(),
    text: msg.text(),
    timestamp: Date.now()
  });
});
```

日志保存在内存中，通过 `get_console_logs` 工具获取。
