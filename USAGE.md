# MCP Browser 工具调用指南

> 给 AI 看的快速参考手册。服务启动后通过 HTTP POST 调用，无需任何 SDK。

## 快速启动

```bash
mcp start cursor      # 启动服务（Browser:3211, Database:3212）
mcp health cursor     # 确认服务就绪
```

## 调用格式

```bash
# 所有工具统一格式
curl -s -X POST http://localhost:3211/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: <SESSION_ID>" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"<工具名>","arguments":{...}},"id":1}'
```

## 建立会话（每次新对话必须先做）

```bash
# 1. 初始化，获取 session id
curl -s -D /tmp/h -X POST http://localhost:3211/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"ai","version":"1.0"}},"id":1}'
SESSION=$(grep -i "mcp-session-id" /tmp/h | awk '{print $2}' | tr -d '\r\n')

# 2. 发送 initialized 通知
curl -s -X POST http://localhost:3211/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'
```

---

## 工具速查表

### 基础操作

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `navigate` | 打开 URL | `url` |
| `click` | 点击元素（自动 force fallback） | `selector` |
| `type` | 输入文本（自动 force fallback） | `selector`, `text` |
| `hover` | 悬停元素 | `selector` |
| `scroll` | 滚动页面 | `y`（像素）或 `selector` |
| `go_back` | 返回上一页 | — |
| `go_forward` | 前进下一页 | — |
| `set_viewport` | 设置视口大小 | `width`, `height` |

### 内容提取

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `get_page_content` | 获取完整 HTML | — |
| `get_element_text` | 获取元素文本 | `selector` |
| `get_element_attribute` | 获取元素属性 | `selector`, `attribute` |
| `execute_js` | 执行 JS 返回结果 | `script` |
| `take_screenshot` | 截图（返回 base64） | `name`, `fullPage` |
| `pdf_export` | 导出 PDF | `path` |

### 调试 & 监控

| 工具 | 说明 |
|------|------|
| `get_console_logs` | 获取 console 输出 |
| `get_network` | 获取所有网络请求 |
| `get_cookies` | 获取 cookies |
| `set_cookies` | 设置 cookies |
| `generate_page_report` | 页面结构分析报告 |

### 爬虫工具（新增）

| 工具 | 说明 | 关键参数 |
|------|------|----------|
| `set_block_rules` | **爬取前先调用**，屏蔽图片/广告，速度提升 3-5x | `blockImages`, `blockAds` |
| `extract_links` | 提取页面所有链接 | `selector`, `filter`, `limit` |
| `extract_data` | 批量提取结构化数据（列表/表格） | `itemSelector`, `fields` |
| `wait_and_extract` | 等待动态内容后提取（SPA/懒加载） | `waitSelector`, `extractSelector` |
| `batch_fetch` | 批量抓取多个 URL（最多20个） | `urls`, `extractSelector`, `delay` |
| `crawl_pages` | 自动分页爬取 | `startUrl`, `nextPageSelector`, `itemSelector`, `fields` |

---

## 高效调用规则

### 规则 1：爬取前先开启请求拦截

```json
// 爬取任何页面前先调用，速度提升 3-5 倍
{"name": "set_block_rules", "arguments": {"blockImages": true, "blockMedia": true, "blockAds": true}}
```

### 规则 2：navigate 用 commit 模式（已内置）

服务已配置 `waitUntil: 'commit'`，页面开始响应就返回，不等全部资源加载完。

### 规则 3：click 失败不要重试，直接用 execute_js

```json
// 如果 click 返回 success:false，改用 JS 点击
{"name": "execute_js", "arguments": {"script": "document.querySelector('#btn').click()"}}
```

### 规则 4：提取数据优先用 extract_data，不要用 execute_js 手写

```json
// 好：一次提取所有商品
{
  "name": "extract_data",
  "arguments": {
    "itemSelector": ".product-item",
    "fields": [
      {"name": "title", "selector": ".title"},
      {"name": "price", "selector": ".price"},
      {"name": "link", "selector": "a", "attribute": "href", "type": "attr"}
    ]
  }
}
```

### 规则 5：动态页面用 wait_and_extract

```json
// 等 .list-item 出现后再提取，适合 React/Vue 等 SPA
{
  "name": "wait_and_extract",
  "arguments": {
    "waitSelector": ".list-item",
    "extractSelector": ".list-item .title"
  }
}
```

### 规则 6：多页数据用 crawl_pages，不要手动循环

```json
{
  "name": "crawl_pages",
  "arguments": {
    "startUrl": "https://example.com/list",
    "nextPageSelector": ".pagination .next",
    "itemSelector": ".item",
    "fields": [{"name": "title", "selector": "h3"}, {"name": "url", "selector": "a", "attribute": "href", "type": "attr"}],
    "maxPages": 10,
    "delay": 500
  }
}
```

---

## 典型场景示例

### 场景 A：搜索并截图

```bash
# 1. 打开页面
navigate {"url": "https://www.baidu.com"}
# 2. 输入搜索词
type {"selector": "#kw", "text": "playwright"}
# 3. 点击搜索
click {"selector": "#su"}
# 4. 截图
take_screenshot {"name": "result"}
```

### 场景 B：爬取商品列表（多页）

```bash
# 1. 开启加速模式
set_block_rules {"blockImages": true, "blockAds": true}
# 2. 分页爬取
crawl_pages {
  "startUrl": "https://shop.example.com/products",
  "nextPageSelector": ".next-page",
  "itemSelector": ".product",
  "fields": [{"name":"name","selector":".name"},{"name":"price","selector":".price"}],
  "maxPages": 5
}
```

### 场景 C：批量抓取文章内容

```bash
batch_fetch {
  "urls": ["https://a.com/1", "https://a.com/2", "https://a.com/3"],
  "extractSelector": "article",
  "delay": 300
}
```

### 场景 D：登录后操作

```bash
# 1. 打开登录页
navigate {"url": "https://example.com/login"}
# 2. 填写表单
type {"selector": "#username", "text": "myuser"}
type {"selector": "#password", "text": "mypass"}
# 3. 提交
click {"selector": "button[type=submit]"}
# 4. 等待登录完成
wait_for_selector {"selector": ".dashboard", "timeout": 10000}
```

---

## 端口说明

| IDE | Browser MCP | Database MCP |
|-----|-------------|--------------|
| Cursor | `http://localhost:3211/mcp` | `http://localhost:3212/mcp` |
| Windsurf | `http://localhost:3213/mcp` | `http://localhost:3214/mcp` |

## 服务管理

```bash
mcp start cursor        # 启动
mcp stop cursor         # 停止
mcp restart cursor      # 重启（代码更新后）
mcp health cursor       # 健康检查
mcp-database set cursor --type mysql --host 127.0.0.1 --port 3306 --name mydb --user root --password xxx
```
