## Why

当前 MCP Bridge 只提供基础的浏览器操作工具，缺少页面分析和报告生成能力。用户需要快速获取页面的结构化分析信息，包括页面性能、可访问性、网络请求等。

## What Changes

### 新增工具
- `generate_page_report` - 生成页面综合分析报告
- `get_accessibility_report` - 获取页面无障碍检查报告
- `get_performance_metrics` - 获取页面性能指标

### 报告内容
- 页面基本信息（URL、标题、DOM元素数量）
- 链接统计（内链、外链、死链）
- 表单统计
- 图片统计（有/无alt属性）
- 性能指标（加载时间、资源大小）
- 无障碍问题列表

## Capabilities

### New Capabilities
- `page-report`: 页面分析报告生成（generate_page_report, get_accessibility_report, get_performance_metrics）

### Modified Capabilities
<!-- 无 -->

## Impact

- **代码影响**：
  - `src/tools.ts` - 新增 3 个报告工具函数
  - `src/schemas.ts` - 新增 3 个 Zod Schema
  - `src/server.ts` - 注册新工具

- **依赖**：无新增依赖，使用 Playwright 内置 API
