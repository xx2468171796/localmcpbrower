# MCP SSE 连接问题解决方案

## 问题背景

在开发 Windsurf MCP Bridge 时，遇到了 MCP 客户端（Windsurf IDE）无法连接到服务器的问题。错误信息为：

```
failed to initialize server: failed to create client: failed to initialize SSE client: 
failed to initialize client: transport error: request failed with status 400: 
InternalServerError: stream is not readable
```

## 问题根本原因

### MCP SSE 通信原理

MCP (Model Context Protocol) 使用 SSE (Server-Sent Events) 作为传输层，通信流程如下：

```
┌─────────────┐                      ┌─────────────┐
│  Windsurf   │                      │  MCP Server │
│  (客户端)   │                      │  (服务端)   │
└──────┬──────┘                      └──────┬──────┘
       │                                    │
       │  1. GET /sse                       │
       │ ──────────────────────────────────>│
       │                                    │
       │  2. SSE 流建立                      │
       │     event: endpoint                │
       │     data: /messages?sessionId=xxx  │
       │ <──────────────────────────────────│
       │                                    │
       │  3. POST /messages?sessionId=xxx   │
       │     (JSON-RPC 请求)                │
       │ ──────────────────────────────────>│
       │                                    │
       │  4. SSE 推送响应                    │
       │     event: message                 │
       │     data: {...}                    │
       │ <──────────────────────────────────│
       │                                    │
```

**关键点**：
1. 客户端先通过 GET /sse 建立 SSE 连接
2. 服务器返回 `endpoint` 事件，告诉客户端消息发送地址（包含 sessionId）
3. 客户端通过 POST /messages?sessionId=xxx 发送消息
4. 服务器必须用 **sessionId** 找到对应的 transport 来处理消息

### 错误实现（导致连接失败）

```typescript
// ❌ 错误做法：使用单一 transport 变量
let currentTransport: SSEServerTransport | null = null;

app.get('/sse', async (req, res) => {
  currentTransport = new SSEServerTransport('/messages', res);
  await mcpServer.connect(currentTransport);
});

app.post('/messages', async (req, res) => {
  // 问题：无法正确路由消息到对应的 transport
  await currentTransport?.handlePostMessage(req, res);
});
```

**问题分析**：
1. 每个 SSE 连接都有唯一的 `sessionId`
2. 客户端 POST 消息时会带上 `sessionId` 参数
3. 服务器必须用 `sessionId` 找到正确的 transport
4. 单一变量无法支持多连接，且无法正确路由消息

### 正确实现（按官方示例）

```typescript
// ✅ 正确做法：用 sessionId 存储和路由 transport
const transports: Record<string, SSEServerTransport> = {};

app.get('/sse', async (req, res) => {
  // 创建 transport，它会自动生成 sessionId
  const transport = new SSEServerTransport('/messages', res);
  const sessionId = transport.sessionId;
  
  // 用 sessionId 存储 transport
  transports[sessionId] = transport;
  
  // 连接关闭时清理
  res.on('close', () => {
    delete transports[sessionId];
  });
  
  // 连接 MCP 服务器
  const server = createMcpServer();
  await server.connect(transport);
});

app.post('/messages', async (req, res) => {
  // 从 URL 参数获取 sessionId
  const sessionId = req.query.sessionId as string;
  
  // 用 sessionId 找到对应的 transport
  const transport = transports[sessionId];
  
  if (!transport) {
    res.status(400).json({ error: 'No transport found for sessionId' });
    return;
  }
  
  // 处理消息
  await transport.handlePostMessage(req, res, req.body);
});
```

## 关键代码解释

### 1. SSEServerTransport

```typescript
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

const transport = new SSEServerTransport('/messages', res);
```

- 第一个参数 `/messages` 是消息接收端点的路径
- 第二个参数 `res` 是 Express 的 Response 对象
- transport 会自动生成 `sessionId` 并通过 SSE 发送给客户端

### 2. sessionId 的作用

```typescript
const sessionId = transport.sessionId;
transports[sessionId] = transport;
```

- `sessionId` 是每个连接的唯一标识
- 客户端收到 `endpoint` 事件后，会在后续 POST 请求中带上 `sessionId`
- 服务器用 `sessionId` 路由消息到正确的 transport

### 3. 消息处理

```typescript
await transport.handlePostMessage(req, res, req.body);
```

- `handlePostMessage` 接收三个参数：req, res, body
- 注意：必须传入 `req.body`，因为 Express 已经解析了请求体

## 调试技巧

### 1. 查看服务日志

```bash
pm2 logs windsurf-mcp-bridge --lines 50
```

### 2. 检查健康状态

```bash
curl http://localhost:3210/health
```

应返回：
```json
{"status":"ok","browserAlive":true,"uptime":12345}
```

### 3. 检查 SSE 连接

在浏览器访问 `http://localhost:3210/sse`，应看到：
```
event: endpoint
data: /messages?sessionId=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

### 4. 查看活跃连接

在日志中添加调试信息：
```typescript
console.log(`[SSE] 当前活跃sessions: ${Object.keys(transports).join(', ')}`);
```

## 常见错误及解决方案

### 错误 1: "stream is not readable"

**原因**：消息无法路由到正确的 transport

**解决**：确保用 sessionId 存储和查找 transport

### 错误 2: "SSEServerTransport already started"

**原因**：手动调用了 `transport.start()`

**解决**：不需要手动调用，`mcpServer.connect(transport)` 会自动调用

### 错误 3: "No transport found for sessionId"

**原因**：
1. transport 已被清理
2. sessionId 不匹配

**解决**：
1. 检查 `res.on('close')` 是否正确清理
2. 确保 POST 请求的 sessionId 与 SSE 连接一致

## MCP 工具开发指南

### 注册新工具

```typescript
server.tool(
  'tool_name',           // 工具名称
  '工具描述',             // 工具描述
  {                      // 输入参数 Schema
    type: 'object',
    properties: {
      param1: { type: 'string', description: '参数1' }
    },
    required: ['param1']
  },
  async (args) => {      // 处理函数
    // 执行操作
    const result = await doSomething(args.param1);
    
    // 返回结果
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }]
    };
  }
);
```

### 工具返回格式

```typescript
// 成功返回
return {
  content: [
    { type: 'text', text: JSON.stringify({ success: true, data: result }) }
  ]
};

// 错误返回
return {
  content: [
    { type: 'text', text: JSON.stringify({ success: false, error: 'error message' }) }
  ],
  isError: true
};
```

## 参考资料

- [MCP SDK GitHub](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP 协议规范](https://spec.modelcontextprotocol.io/)
- [SSE 规范](https://html.spec.whatwg.org/multipage/server-sent-events.html)

## 总结

MCP SSE 连接的核心是 **sessionId 路由**：

1. 每个 SSE 连接有唯一的 sessionId
2. 服务器必须用 Record/Map 存储 transport
3. POST 消息时用 sessionId 找到对应的 transport
4. 连接关闭时清理 transport

按照这个模式，就能正确实现 MCP SSE 通信。
