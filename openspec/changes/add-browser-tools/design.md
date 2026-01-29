## Context

当前 MCP Bridge 基于 Playwright 实现了 7 个基础浏览器工具。架构为：
- `src/server.ts` - MCP Server + SSE Transport
- `src/tools.ts` - 工具函数实现
- `src/schemas.ts` - Zod 输入校验
- `src/browser.ts` - BrowserManager 单例

新增 13 个工具需要遵循现有架构模式，保持代码一致性。

## Goals / Non-Goals

**Goals:**
- 新增 13 个 Playwright 工具，覆盖常见浏览器自动化场景
- 保持与现有工具一致的接口风格和错误处理
- 所有工具支持 Zod Schema 输入校验

**Non-Goals:**
- 不修改现有 7 个工具的接口
- 不引入新的外部依赖
- 不实现多标签页管理（复杂度高，后续迭代）

## Decisions

### 1. 工具分组设计

| 模块 | 工具 | 理由 |
|------|------|------|
| browser-navigation | scroll, go_back, go_forward | 页面导航相关 |
| element-interaction | hover, wait_for_selector, get_element_text, get_element_attribute | 元素操作相关 |
| form-operations | select_option, fill_form | 表单操作相关 |
| page-content | get_page_content, pdf_export | 内容获取相关 |
| cookie-management | get_cookies, set_cookies | Cookie 相关 |

### 2. 统一返回格式

```typescript
interface ToolResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}
```

沿用现有格式，保持一致性。

### 3. wait_for_selector 状态选项

支持四种等待状态：`visible` | `hidden` | `attached` | `detached`
- 默认 `visible`
- 超时时间默认 30s，可配置

### 4. fill_form 批量填充设计

```typescript
interface FillFormInput {
  fields: Array<{
    selector: string;
    value: string;
    type?: 'text' | 'select' | 'checkbox';
  }>;
}
```

支持文本、下拉框、复选框三种类型。

## Risks / Trade-offs

| 风险 | 缓解措施 |
|------|----------|
| PDF 导出可能失败（复杂页面） | 添加 timeout 参数，默认 30s |
| Cookie 操作可能有安全风险 | 仅操作当前域的 Cookie |
| fill_form 选择器可能不准确 | 提供详细错误信息帮助调试 |
