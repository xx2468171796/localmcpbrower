# mcp-tools Spec

## 概述
MCP 工具集，向 AI 助手暴露的原子化浏览器操作能力。

## 工具定义

### navigate
```typescript
const NavigateSchema = z.object({
  url: z.string().url()
});
// 跳转至指定网址，返回页面标题
```

### click
```typescript
const ClickSchema = z.object({
  selector: z.string()
});
// 点击元素，自动滚动到视图内，返回操作结果
```

### type
```typescript
const TypeSchema = z.object({
  selector: z.string(),
  text: z.string()
});
// 模拟键盘输入，返回操作结果
```

### take_screenshot
```typescript
const ScreenshotSchema = z.object({
  name: z.string().optional(),
  fullPage: z.boolean().default(false)
});
// 截图保存至 storage/screenshots，返回文件路径
```

### get_console_logs
```typescript
// 无参数
// 返回页面所有 console 输出
```

### get_network
```typescript
// 无参数
// 返回网络请求列表，包含状态码
```

### execute_js
```typescript
const ExecuteJsSchema = z.object({
  script: z.string()
});
// 执行 JavaScript，返回执行结果
```

## 行为规范

1. **原子化**: 每个工具只做一件事
2. **Zod 验证**: 所有输入必须通过 Schema 验证
3. **结构化返回**: 统一返回 `{ success: boolean, data?: T, error?: string }`
4. **日志收集**: 所有工具执行时自动收集 console 日志

## 依赖
- browser-singleton
- zod
- @modelcontextprotocol/sdk
