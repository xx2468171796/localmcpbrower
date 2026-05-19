# MCP Browser & Database 工具调用规则

> 给 AI 看的调用手册。遵守这些规则可以让调用更快、更稳定、更少出错。

---

## 一、服务管理（先启动再用）

### Claude 版（v2.0.0，推荐）—— stdio 原生模式

stdio 模式由 Claude Code 直接拉起进程，**无需启动服务、无需端口**。
只要 `.mcp.json` 或 `claude mcp add` 已配置好，工具即可直接调用，无需 `mcp start`。

```bash
# 首次安装 / 重新构建（跨平台）
node mcp.mjs install

# 获取 stdio 配置命令（推荐路径）
node mcp.mjs config
```

### Claude 版 —— HTTP / PM2 模式（服务器或多客户端共享）

```bash
node mcp.mjs start          # 启动全部（browser + db）
node mcp.mjs status         # 查看 PM2 进程状态
node mcp.mjs stop           # 停止
```

### 其他版本（Cursor / Windsurf）

```bash
mcp start cursor        # 启动 Cursor 版（Browser:3211 + Database:3212）
mcp start windsurf      # 启动 Windsurf 版（Browser:3213 + Database:3214）
mcp health cursor       # 检查服务是否正常
mcp status              # 查看所有进程状态
```

**MCP 端点：**
- Cursor Browser:   `http://localhost:3211/mcp`
- Cursor Database:  `http://localhost:3212/mcp`
- Windsurf Browser: `http://localhost:3213/mcp`
- Windsurf Database:`http://localhost:3214/mcp`
- Claude（HTTP 模式）有头浏览器 `:3213` / 无头浏览器 `:3215` / 数据库 `:3214`
  —— stdio 模式不占用端口

---

## 二、浏览器 MCP 调用规则

### 规则 1：爬虫任务必须先开启请求拦截

```
爬取数据前，第一步永远是调用 set_block_rules，速度提升 3-5 倍：
set_block_rules({ blockImages: true, blockMedia: true, blockFonts: true, blockAds: true })
```

### 规则 2：工具选择优先级

| 场景 | 优先用 | 不要用 |
|------|--------|--------|
| 提取列表数据 | `extract_data` | 多次 `get_element_text` |
| 多页爬取 | `crawl_pages` | 手动循环 `click` + `extract_data` |
| 批量抓取不同URL | `batch_fetch` | 循环 `navigate` + `get_page_content` |
| 动态/Ajax页面 | `wait_and_extract` | 直接 `extract_data`（会拿到空数据）|
| 提取所有链接 | `extract_links` | `execute_js` 手写 querySelectorAll |
| 简单页面内容 | `get_page_content` | `take_screenshot`（截图慢且大）|

### 规则 3：等待策略

```
- 静态页面：navigate 后直接操作，无需额外等待
- 动态页面（SPA/React/Vue）：用 wait_for_selector 等关键元素出现
- Ajax 加载：用 wait_and_extract，设 waitSelector 为数据容器
- 翻页后：crawl_pages 内置等待，无需手动处理
```

### 规则 4：click / type 失败处理

```
click 和 type 已内置三级 fallback（正常→force→JS），无需手动重试。
如果仍然失败，改用 execute_js 直接操作 DOM：
execute_js({ script: "document.querySelector('#btn').click()" })
```

### 规则 5：截图使用场景

```
截图比较慢（~1秒），只在以下情况使用：
- 需要视觉验证页面状态
- 调试元素定位问题
- 需要返回图片给用户查看

不要用截图来"读取"页面内容，用 get_page_content 或 extract_data 更快。
```

### 规则 6：多标签页

```
需要同时保持多个页面时用多标签页，比反复 navigate 快：
new_tab({ url: "https://..." })   # 新开标签
switch_tab({ index: 0 })          # 切回第一个
list_tabs()                        # 查看所有标签
```

---

## 三、爬虫最佳实践

### 标准爬虫流程

```
1. set_block_rules(blockImages+blockAds)   # 开启加速
2. navigate({ url: "起始页" })              # 打开页面
3. wait_for_selector({ selector: "数据容器" }) # 等待加载（动态页面）
4. extract_data({ itemSelector, fields })   # 提取数据
5. crawl_pages(...)                         # 如需翻页
```

### 批量抓取多个详情页

```
1. navigate 到列表页
2. extract_links({ filter: "/detail/" })    # 提取所有详情页链接
3. batch_fetch({ urls: [...], extractSelector: ".content", delay: 500 })
```

### 防封号建议

```
- batch_fetch 的 delay 设 500-1000ms
- crawl_pages 的 delay 设 800-1500ms
- 不要并发，顺序执行
```

---

## 四、数据库 MCP 调用规则

### 配置数据库（AI 直接执行）

```bash
# PostgreSQL
mcp-database set cursor --type postgresql --host 127.0.0.1 --port 5432 --name mydb --user postgres --password 123456

# MySQL
mcp-database set cursor --type mysql --host 127.0.0.1 --port 3306 --name shop --user root --password root123

# 配置完重启生效
mcp-database restart cursor
```

### 添加多个数据库预设

```bash
mcp-database add-preset cursor DEV --type postgresql --host 127.0.0.1 --port 5432 --name dev_db --user dev --password dev123
mcp-database add-preset cursor PROD --type postgresql --host prod.server.com --port 5432 --name prod_db --user admin --password xxx --ssl true
mcp-database use-preset cursor DEV    # 切换默认连接
mcp-database restart cursor           # 重启生效
```

### 数据库工具（15个）

| 工具 | 用途 |
|------|------|
| `query` | SELECT 查询 |
| `execute` | INSERT/UPDATE/DELETE |
| `list_tables` | 列出所有表 |
| `describe_table` | 查看表结构 |
| `list_databases` | 列出所有数据库 |
| `explain_query` | 分析查询性能 |
| `table_indexes` | 查看索引 |
| `table_relations` | 查看外键关系 |
| `table_stats` | 表统计信息 |
| `export_csv` | 导出查询结果为 CSV |
| `connect` | 连接数据库 |
| `disconnect` | 断开连接 |
| `status` | 查看连接状态 |
| `list_presets` | 列出预设数据库 |
| `switch_db` | 切换数据库 |

---

## 五、完整工具清单（浏览器 MCP，35个）

### 基础操作（14个）
| 工具 | 参数 | 说明 |
|------|------|------|
| `navigate` | url | 跳转页面 |
| `click` | selector | 点击元素（三级fallback）|
| `type` | selector, text | 输入文本（三级fallback）|
| `hover` | selector | 鼠标悬停 |
| `scroll` | x?, y?, selector? | 滚动页面 |
| `keyboard_press` | key | 按键（Enter/Tab/Escape）|
| `drag_and_drop` | source, target | 拖拽 |
| `select_option` | selector, value | 下拉选择 |
| `fill_form` | fields[] | 批量填表 |
| `file_upload` | selector, filePath | 上传文件 |
| `wait_for_selector` | selector, state?, timeout? | 等待元素 |
| `go_back` | - | 后退 |
| `go_forward` | - | 前进 |
| `set_viewport` | width, height | 设置视口 |

### 数据提取（10个）
| 工具 | 参数 | 说明 |
|------|------|------|
| `get_page_content` | selector? | 获取 HTML |
| `get_element_text` | selector | 获取文本 |
| `get_element_attribute` | selector, attribute | 获取属性 |
| `get_cookies` | name? | 获取 cookies |
| `set_cookies` | cookies[] | 设置 cookies |
| `get_console_logs` | - | 控制台日志 |
| `get_network` | - | 网络请求记录 |
| `execute_js` | script | 执行 JS |
| `generate_page_report` | - | 页面结构报告 |
| `intercept_requests` | urlPattern, action | 拦截请求 |

### 截图导出（2个）
| 工具 | 参数 | 说明 |
|------|------|------|
| `take_screenshot` | name?, fullPage? | 截图（返回base64）|
| `pdf_export` | path, fullPage? | 导出PDF |

### 多标签页（4个）
| 工具 | 参数 | 说明 |
|------|------|------|
| `list_tabs` | - | 列出标签页 |
| `new_tab` | url? | 新建标签页 |
| `switch_tab` | index | 切换标签页 |
| `close_tab` | index | 关闭标签页 |

### 爬虫工具（6个）
| 工具 | 参数 | 说明 |
|------|------|------|
| `set_block_rules` | blockImages?, blockMedia?, blockFonts?, blockAds? | 屏蔽请求加速 |
| `extract_links` | selector?, filter?, limit? | 提取链接 |
| `extract_data` | itemSelector, fields[], limit? | 批量提取结构化数据 |
| `wait_and_extract` | waitSelector, extractSelector, attribute?, timeout? | 等待后提取 |
| `batch_fetch` | urls[], waitFor?, extractSelector?, delay? | 批量抓取URL |
| `crawl_pages` | startUrl, nextPageSelector, itemSelector, fields[], maxPages?, delay? | 自动翻页爬取 |
