# MCP Browser & Database 工具调用规则

> 给 AI 看的调用手册。遵守这些规则可以让调用更快、更稳定、更少出错。

---

## 一、服务管理（先启动再用）

### 推荐：HTTP 常驻服务

三个长驻服务由 PM2 托管，所有客户端窗口共用（一份 Chromium、一份登录态、一套数据库连接池）。

```bash
node mcp.mjs start          # 启动全部三个服务 + 端点健康检查
node mcp.mjs status         # 查看 PM2 进程状态
node mcp.mjs restart db     # 改了 mcp-database/.env 后重启数据库服务
node mcp.mjs stop           # 停止
node mcp.mjs autostart      # 开机自启指引（--apply 落地）
```

**MCP 端点（默认只绑 127.0.0.1，三平台端口一致）：**
- 有头浏览器 `http://127.0.0.1:3213/mcp` —— 窗口可见，可实时观察、随时人工接管
- 无头浏览器 `http://127.0.0.1:3215/mcp` —— 后台 / 服务器
- 数据库 `http://127.0.0.1:3214/mcp`

**会话隔离（多窗口并行时的关键语义）：**
- **浏览器标签页默认共享**(设 PIPE_ISOLATED=1 切隔离)，console / 网络记录、`set_block_rules` 的拦截规则
  也是各自独立的；`list_tabs` / `switch_tab` / `close_tab` 只看得到、也只动得了本会话的标签页。
- 每个会话有**自己的数据库指针**：`switch_db` / `connect` / `disconnect` 只改本会话指向哪个库，
  不会把别的窗口带走；连接池按库共享。
- **同一个服务内**默认所有会话共用 `default` 工作区，也就是**共享登录态**
  （在这个服务上登录一次，它的全部窗口可用）；需要独立 cookie / 登录态时用 `space_new`（见规则 9）。
- **有头（3213）和无头（3215）是两个进程、两份 profile，登录态不互通**
  （`storage/user_data_headed` vs `storage/user_data`）。在有头里登录的账号，无头看不到；
  要所有窗口共用一份登录态，就只用其中一个端点。
  stdio 模式用的也是默认 `storage/user_data`，与无头服务同一份，别同时跑。

### 备用：stdio 原生模式

不想跑常驻服务、或服务不可达时，由客户端直接拉起进程，**不占端口、无需 PM2**，
行为与旧版完全一致（单会话，无上面的多会话隔离概念）。

```bash
# 首次安装 / 重新构建（跨平台）
node mcp.mjs install

# 仓库更新后一键升级（git pull + 重装依赖 + 重建 + 重启在跑的 PM2 服务）
node mcp.mjs update

# 打印客户端注册方式：方式 A = HTTP（推荐），方式 B = stdio（备用）
node mcp.mjs config
```

---

## 二、浏览器 MCP 调用规则

### 规则 1：爬虫任务必须先开启请求拦截

```
爬取数据前，第一步永远是调用 set_block_rules，速度提升 3-5 倍：
set_block_rules({ blockImages: true, blockMedia: true, blockFonts: true, blockAds: true })

规则是**会话级**的：只挂在本会话自己的标签页上（之后 new_tab / 弹窗开出来的新页自动继承），
不会波及共用同一个服务的其他窗口，所以放心开，也不用替别人收拾。
```

### 规则 2：工具选择优先级

| 场景 | 优先用 | 不要用 |
|------|--------|--------|
| 提取列表数据 | `extract_data` | 多次 `get_element_text` |
| 多页爬取 | `crawl_pages` | 手动循环 `click` + `extract_data` |
| 批量抓取不同URL | `batch_fetch` | 循环 `navigate` + `get_page_content` |
| 爬大站前探明页面地址 | `discover_urls`（sitemap+robots+链接）| 逐页 `navigate` 摸索 |
| 动态/Ajax页面 | `wait_and_extract` | 直接 `extract_data`（会拿到空数据）|
| 提取所有链接 | `extract_links` | `execute_js` 手写 querySelectorAll |
| 文章/博客/文档正文 | `extract_article`（defuddle 转 Markdown）| `get_page_content` + 手动清洗 |
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

### 规则 5：用 snapshot + ref 操作元素（省 token）

```
不确定选择器时，先调用 snapshot 获取页面无障碍大纲，
每个可交互元素带 ref 编号（如 e5），再用 ref 操作，无需写 CSS：
snapshot()                          # 获取大纲，读取目标 ref
click({ ref: "e5" })                # 用 ref 点击（selector 与 ref 二选一）
type({ ref: "e3", text: "关键词" })  # 用 ref 输入

ref 在页面重新渲染后失效，SPA 交互失败时重新 snapshot 拿新 ref。
找不到可点击元素时可加 deep:true（CDP 扫描 addEventListener 绑定的元素，较慢）。
snapshot 已自动穿透 iframe（含跨域）：iframe 内容会以「iframe "url"」分组缩进输出，
里面的元素同样带 ref，click/type/hover 传该 ref 即可直接操作，无需切 frame。

正文采集首选 extract_article（defuddle 提取，自动剥离导航/广告，返回干净 Markdown），
比 get_page_content + 手动清洗更省 token。
```

### 规则 6：截图使用场景

```
截图比较慢（~1秒），只在以下情况使用：
- 需要视觉验证页面状态
- 调试元素定位问题
- 需要返回图片给用户查看

不要用截图来"读取"页面内容，用 get_page_content 或 extract_data 更快。
```

### 规则 7：多标签页

```
需要同时保持多个页面时用多标签页，比反复 navigate 快：
new_tab({ url: "https://..." })   # 新开标签
switch_tab({ index: 0 })          # 切回第一个
list_tabs()                        # 查看所有标签

HTTP 模式下这些工具只作用于本会话自己的标签页：
list_tabs 不会列出别的窗口的标签，index 也只在本会话内编号，
所以不用担心 close_tab 关掉别人的页面。
```

### 规则 8：多步交互优先用 run_script 一次跑完（省 token / 省延迟）

```
「填表→点击→等待→读结果」这类多步操作，别一步一个工具往返，
用 run_script 在页面里一次性跑完。脚本内可直接用 __ego 助手：
  __ego.snapshot({interactiveOnly:true})   页面无障碍快照
  __ego.click(selOrRef)                     点击（CSS 选择器或 ref e5 均可）
  __ego.fill(selOrRef, val) / type(...)     写输入框并派发 input/change
  __ego.check / select / text / attr / exists
  __ego.waitFor(selector, ms)               等元素出现且可见
  __ego.sleep(ms) / $(sel) / $$(sel)

示例（登录：填账号密码→点登录→等跳转→读欢迎语，一次调用）：
run_script({ script: `
  __ego.fill('#user', 'alice');
  __ego.fill('#pass', 'secret');
  __ego.click('button[type=submit]');
  await __ego.waitFor('.welcome', 5000);
  return { msg: __ego.text('.welcome') };
` })

支持顶层 await 与 return，返回值 JSON 序列化回传。
仍需复杂原生 DOM 时才退回 execute_js。
```

### 规则 9：并行/隔离任务用 Task Spaces

```
需要并行跑多任务、或同站多账号互不串号时，开独立工作区（各自独立 cookie/登录态）：
space_new({ name: "job1" })    # 新建并切换到 job1（独立 userDataDir）
space_list()                    # 查看所有工作区及当前活跃/URL
space_switch({ name: "default" })  # 切回默认工作区
space_close({ name: "job1" })   # 关闭并释放（default 不可关）

切换后，所有浏览器工具都作用于当前工作区的页面；space_switch 只改本会话，
不会把别的窗口一起切走。不用多工作区时无需关心，default 工作区行为与旧版完全一致。

什么时候必须开新 space：默认所有会话共用 default 的登录态，
一个窗口在某站点登出/换号，其他窗口跟着受影响 —— 需要独立账号或独立登录态就 space_new。
```

---

## 三、爬虫最佳实践

### 标准爬虫流程

```
1. set_block_rules(blockImages+blockAds)   # 开启加速（会话级：本会话的标签页全部生效，不影响别的窗口）
2. navigate({ url: "起始页" })              # 打开页面
3. wait_for_selector({ selector: "数据容器" }) # 等待加载（动态页面）
4. extract_data({ itemSelector, fields })   # 提取数据
5. crawl_pages(...)                         # 如需翻页
```

### 爬整站 / 大站

```
1. discover_urls({ url: "站点入口" })        # 先走 sitemap+robots+页面链接探明全部地址，快且不抓正文
2. 按 URL 规律筛选出目标页面
3. batch_fetch / extract_article 分批抓取正文
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

### 配置数据库

数据库连接信息通过 `claude/mcp-database/.env` 配置，复制示例并编辑：

```bash
cp claude/mcp-database/.env.example claude/mcp-database/.env
```

```env
# PostgreSQL
DB_TYPE=postgresql
DB_HOST=127.0.0.1
DB_PORT=5432
DB_NAME=mydb
DB_USER=postgres
DB_PASSWORD=123456
DB_SSL=false
```

### 添加多个数据库预设

在同一个 `.env` 文件中按 `DB_<别名>_*` 格式追加预设，运行时用 `switch_db` 工具切换：

```env
DB_PROD_TYPE=postgresql
DB_PROD_HOST=prod.server.com
DB_PROD_PORT=5432
DB_PROD_NAME=prod_db
DB_PROD_USER=admin
DB_PROD_PASSWORD=xxx
DB_PROD_SSL=true
```

> stdio 模式修改 `.env` 后重新触发 MCP 即生效；HTTP 模式需 `node mcp.mjs restart db`。
> `.env` 里的默认库只是每个会话连上来时的**初始指针**。

### 读写规则（必读）

```
- query 强制只读：仅接受 SELECT/WITH/SHOW/EXPLAIN/DESCRIBE，其他语句直接报错。
  另外两条限制是**故意的**,别绕:① **一次只能一条 SQL**,分号拼接一律拒(数据库会逐条执行,
  是绕过只读的口子);② 语句里任何位置出现写关键字都会被拒,包括 `WITH x AS (INSERT …) SELECT …`
  这类**可写 CTE**。查询还会跑在**引擎级只读事务**里(`BEGIN READ ONLY`),写不进去。
  要写就用 execute(带 destructiveHint,宿主会要求确认)
- 写操作（INSERT/UPDATE/DELETE/DDL）必须用 execute，它带 destructiveHint，
  执行前向用户确认；execute 成功后 SELECT 缓存自动失效
- SELECT 结果有 60 秒缓存，重复查询很快；需要强制最新数据时改写 SQL（如加注释）
  缓存按「库 + SQL + 参数」区分，切库后不会拿到上一个库的旧结果
- explain_query 对写语句只输出执行计划、不会真执行（PG 的 ANALYZE 仅用于只读语句;
  可写 CTE 现在会被正确判成「写」,不会再被 ANALYZE 真跑一遍）。同样拒多语句
- connect / switch_db / disconnect 只改**本会话**当前指向哪个库，不影响其他窗口；
  写操作前用 status 确认当前库，别凭上一次 switch_db 的印象直接 execute
```

### 数据库工具（15个）

| 工具 | 用途 |
|------|------|
| `query` | 只读查询（SELECT/WITH/SHOW/EXPLAIN），结果短时缓存 |
| `execute` | INSERT/UPDATE/DELETE/DDL（破坏性，需确认） |
| `list_tables` | 列出所有表 |
| `describe_table` | 查看表结构 |
| `list_databases` | 列出所有数据库 |
| `explain_query` | 分析执行计划（写语句只出计划不执行） |
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

## 五、完整工具清单（浏览器 MCP，46 个）

### 人工接管（2 个,新增）
| 工具 | 参数 | 说明 |
|------|------|------|
| `wait_for_human` | appears? / disappears? / urlChanges? / timeoutSec? | **阻塞等人在可见窗口里操作完**(扫码登录、短信/图形验证码、风控确认)。判据三选一可组合:等元素出现 / 等元素消失 / 等网址变化。**不弹窗**,靠盯页面变化判断,因此在全自主(bypassPermissions)模式下**照常工作**。用法:先在对话里告诉用户要做什么,再调本工具等待 |
| `request_human` | message | 走协议 elicitation 主动弹窗问用户。⚠️ **在 bypassPermissions 模式下会被客户端自动拒绝且界面无任何提示** —— 那种模式请改用 `wait_for_human`。保留供其它客户端/权限模式使用 |

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

### 数据提取（13个）
| 工具 | 参数 | 说明 |
|------|------|------|
| `run_script` | script | **一次跑完**：脚本内用 `__ego.click/fill/waitFor/snapshot/text/...`，多步交互压成单次往返，省 token；支持顶层 await/return |
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
| `snapshot` | interactiveOnly?, maxChars?, deep? | 无障碍树快照，返回元素 ref，省 token；**穿透 iframe（含跨域）**；deep 用 CDP 找事件监听元素 |
| `extract_article` | url? | defuddle 提取主正文为 Markdown，剥离导航/广告（Readability 兜底）|

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

### 工作区 Task Spaces（4个）
| 工具 | 参数 | 说明 |
|------|------|------|
| `space_new` | name | 新建并切换到隔离工作区（独立 cookie/登录态）|
| `space_switch` | name | 切换活跃工作区 |
| `space_list` | - | 列出所有工作区及状态 |
| `space_close` | name | 关闭并释放工作区（default 不可关）|

### 爬虫工具（7个）
| 工具 | 参数 | 说明 |
|------|------|------|
| `set_block_rules` | blockImages?, blockMedia?, blockFonts?, blockAds? | 屏蔽请求加速（**会话级**：本会话所有标签页生效，含之后新开的；不影响别的会话）|
| `discover_urls` | url, maxUrls?, sameDomainOnly? | 站点 URL 发现（sitemap+robots+页面链接）|
| `extract_links` | selector?, filter?, limit? | 提取链接 |
| `extract_data` | itemSelector, fields[], limit? | 批量提取结构化数据 |
| `wait_and_extract` | waitSelector, extractSelector, attribute?, timeout? | 等待后提取 |
| `batch_fetch` | urls[], waitFor?, extractSelector?, delay? | 批量抓取URL |
| `crawl_pages` | startUrl, nextPageSelector, itemSelector, fields[], maxPages?, delay? | 自动翻页爬取 |
