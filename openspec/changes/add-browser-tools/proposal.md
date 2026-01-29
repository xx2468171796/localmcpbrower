## Why

当前 MCP Bridge 只有 7 个基础浏览器工具（navigate/click/type/screenshot/console_logs/network/execute_js），无法满足复杂的浏览器自动化场景。用户需要更丰富的工具来实现：页面滚动、元素等待、表单操作、Cookie 管理、多标签页控制等功能。

## What Changes

### 新增工具
- `scroll` - 页面滚动到指定位置或元素
- `wait_for_selector` - 等待元素出现/消失/可见/隐藏
- `get_element_text` - 获取元素的文本内容
- `get_element_attribute` - 获取元素的属性值
- `hover` - 鼠标悬停触发 hover 效果
- `select_option` - 选择下拉框选项
- `fill_form` - 批量填充表单字段
- `get_page_content` - 获取页面 HTML 或纯文本内容
- `get_cookies` - 读取页面 Cookie
- `set_cookies` - 设置 Cookie
- `go_back` - 浏览器后退
- `go_forward` - 浏览器前进
- `pdf_export` - 导出页面为 PDF

### 现有工具不变
- 保持现有 7 个工具的接口和行为不变

## Capabilities

### New Capabilities
- `browser-navigation`: 浏览器导航控制（go_back, go_forward, scroll）
- `element-interaction`: 元素交互增强（hover, wait_for_selector, get_element_text, get_element_attribute）
- `form-operations`: 表单操作（select_option, fill_form）
- `page-content`: 页面内容获取（get_page_content, pdf_export）
- `cookie-management`: Cookie 管理（get_cookies, set_cookies）

### Modified Capabilities
<!-- 无需修改现有 spec -->

## Impact

- **代码影响**：
  - `src/tools.ts` - 新增 13 个工具函数
  - `src/schemas.ts` - 新增 13 个 Zod Schema
  - `src/server.ts` - 注册新工具到 MCP Server
  - `src/types.ts` - 新增类型定义

- **依赖**：无新增依赖，所有功能基于现有 Playwright API

- **API 兼容性**：完全向后兼容，只增不改
