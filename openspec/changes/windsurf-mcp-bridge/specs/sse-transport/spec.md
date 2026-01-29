# sse-transport Spec

## 概述
SSE 传输层，提供 HTTP + SSE 双工通信能力。

## 接口定义

### HTTP 端点

| 路由 | 方法 | 描述 |
|------|------|------|
| `/sse` | GET | SSE 连接端点，供 Windsurf 订阅 |
| `/health` | GET | 健康检查 |

### SSE 事件格式

```typescript
interface SSEMessage {
  event: 'tool_result' | 'error' | 'heartbeat';
  data: {
    id: string;
    result?: unknown;
    error?: string;
  };
}
```

## 行为规范

1. **多客户端**: 支持多个 Windsurf 窗口同时连接
2. **心跳检测**: 每 30s 发送 heartbeat 事件
3. **断线重连**: 客户端断开后自动清理资源
4. **CORS**: 允许 localhost 跨域请求

## 配置项

| 配置 | 类型 | 默认值 | 描述 |
|------|------|--------|------|
| `PORT` | number | 3000 | 服务端口 |
| `HEARTBEAT_INTERVAL` | number | 30000 | 心跳间隔(ms) |

## 依赖
- express
- @modelcontextprotocol/sdk
