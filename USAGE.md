# MCP Browser 工具调用规则

> 给 AI 看的调用手册。遵守这些规则可以让调用更快、更稳定、更少出错。
>
> 数据库 MCP 已于 2026-09-25 撤下，库一律用堡垒机 baolei MCP 的 `db_*`（历史版本见 git 历史）。

---

## 一、服务管理（先启动再用）

### 推荐：HTTP 常驻服务

两个长驻服务由 PM2 托管，所有客户端窗口共用（一份 Chromium、一份登录态）。

```bash
node mcp.mjs start          # 启动全部两个服务 + 端点健康检查
node mcp.mjs status         # 查看 PM2 进程状态
node mcp.mjs stop           # 停止
node mcp.mjs autostart      # 开机自启指引（--apply 落地）
```

**MCP 端点（默认只绑 127.0.0.1，三平台端口一致）：**
- 无头浏览器 `http://127.0.0.1:3215/mcp` —— **日常只用这一个**。2.3.0 起要人工处理时 `wait_for_human`
  会自动弹出可见窗口（见「四、人工接管」），不用再切到有头服务
- 有头浏览器 `http://127.0.0.1:3213/mcp` —— 窗口常开，可实时观察；为兼容保留一个版本，之后撤掉

**会话隔离（多窗口并行时的关键语义）：**
- **浏览器标签页默认共享**(设 PIPE_ISOLATED=1 切隔离)，console / 网络记录、`set_block_rules` 的拦截规则
  也是各自独立的；`list_tabs` / `switch_tab` / `close_tab` 只看得到、也只动得了本会话的标签页。
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

示例（搜索：填关键词→点搜索→等结果→读条数，一次调用）：
run_script({ script: `
  __ego.fill('#q', '无人机');
  __ego.click('button[type=submit]');
  await __ego.waitFor('.result', 5000);
  return { n: __ego.$$('.result').length };
`, timeoutMs: 20000 })

支持顶层 await 与 return，返回值 JSON 序列化回传；timeoutMs 默认 30 秒（最多 300 秒），超时返回 TIMEOUT。
仍需复杂原生 DOM 时才退回 execute_js。**登录别用它填密码**，见规则 11。
页面会跳转的多步操作用 run_flow（规则 10），run_script 跨不过导航。
```

### 规则 10：跨页面的多步操作用 run_flow

```
run_flow 在服务端按步骤调现有工具，页面跳转也不断；后面的步骤用 {{名字.路径}} 引用前面 as 存下的 data：
run_flow({ steps: [
  { tool: "navigate",      args: { url: "https://shop.example.com/list" } },
  { tool: "extract_links", args: { filter: "/item/" }, as: "L" },
  { tool: "navigate",      args: { url: "{{L.links.0.href}}" } },
  { tool: "extract_data",  args: { itemSelector: ".sku", fields: [...] }, as: "D", retry: 1 }
] })
失败时返回 code 和已完成的 steps / vars，从断点续跑即可。retry 只重试会好的错（超时、找不到元素），
参数错 / 人在接管 / 白名单拦下不重试。
```

### 规则 11：登录公司系统用堡垒机资产（明文不经过 AI）

```
login_with_asset({ asset: "资产 id 或名称", user: { ref: "e3" }, pass: { ref: "e4" }, otp: { ref: "e5" }, submit: { ref: "e6" } })
fill_secret({ asset: "...", field: "secret" | "account" | "otp" | "<资产自定义字段>", ref: "e4" })
- 浏览器 MCP 用本机（或工位）的堡垒机密钥直接取值、直接填，结果只回「已填 N 位」，事件时间线也打码。
- 只有输入框所在站点和资产登记的地址（address / 标签里的域名）对得上才填，否则 SECRET_ORIGIN_MISMATCH——
  资产没登记地址就先去堡垒机补上。
- 别再 get_asset 拿明文后 type / run_script 填：明文会进对话记录。
```

### 规则 12：让人教一遍——录制 → 回放

```
record_start()                 # 人在窗口（本机弹窗 / 工位远程画面）里操作一遍
record_stop()                  # 拿到 run_flow 步骤；密码框不记内容，变成 fill_secret，回放前把 asset 改成资产
run_flow({ steps })            # 以后直接回放，不用 AI 一步步想
需要有窗口的浏览器（自带扩展只在完整版 Chromium 里加载）；无头时 record_start 会返回 UNSUPPORTED。
```

### 规则 13：看懂错误码，人接管时别硬做

```
失败结果都带 code（结果信封和 MCP isError 都标了失败）：
  DESK_PAUSED            人正在接管这个浏览器：等一会儿再试，别换别的办法绕
  DOMAIN_BLOCKED         网站不在本工位白名单：别绕，告诉用户
  ELEMENT_NOT_FOUND      找不到元素：重新 snapshot 拿 ref
  TIMEOUT / NAVIGATION_FAILED / SCRIPT_ERROR / PATH_DENIED / SECRET_* / CDP_ERROR / UNSUPPORTED / INVALID_ARGS
结果里出现 recycled: true = 这次之前标签页被空闲回收 / 重启清掉过，页面已重建——之前的页面状态没了，重新导航。
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

## 四、完整工具清单（浏览器 MCP，57 个）

### 3.0 新增（10 个）
| 工具 | 参数 | 说明 |
|------|------|------|
| `cdp_send` | method, params?, timeoutMs? | 直接发 CDP 命令。默认只开放页面级的域（白名单），读写本机文件 / 打开 file:// / 改下载目录 / 浏览器级的命令都不开放，要服务端 `ALLOW_BROWSER_CDP=1` |
| `fill_secret` | asset, field?, ref/selector, typing? | 用堡垒机资产填输入框，明文不回给 AI，站点对不上拒填 |
| `login_with_asset` | asset, user?, pass?, otp?, submit?, typing? | 一次填账号 / 密码 / 两步码并提交 |
| `run_flow` | steps[], timeoutMs? | 多步流程一次跑完，跨导航；`{{变量.路径}}` 引用前面结果 |
| `record_start` / `record_stop` / `record_status` | — | 录制人的操作并转成 run_flow 步骤（需自带扩展） |
| `browser_tabs` | — | 整个浏览器所有窗口的标签页（需自带扩展） |
| `browser_downloads` | limit? | 最近下载（需自带扩展） |
| `browser_block_rules` | patterns[], resourceTypes[] | 浏览器内部拦请求，比 set_block_rules 快（需自带扩展） |

**3.0 对原有工具的变化**：`execute_js` / `run_script` 加 `timeoutMs`；`batch_fetch` 最多 50 个、`crawl_pages` 最多 100 页（接近调用期限返回已抓部分并标 `incomplete`）；
`click` / `keyboard_press` 回报 `navigated` / `newTab` / `download`；`navigate` 的 `url` 改为最终网址（另有 `requestedUrl`、`status`）；
`snapshot` 不再输出密码框内容；`type` 只回长度；`fill_form` 支持 `radio`、自定义下拉框和 iframe；`scroll` 能滚内部容器；
`intercept_requests` 加 `off`；`go_back` / `go_forward` 回报 `moved`。截图名 / PDF 路径 / 上传文件收口到数据目录（工位模式或 `STRICT_PATHS=1` 时 PDF 绝对路径也不许）。

### 人工接管（3 个）
| 工具 | 参数 | 说明 |
|------|------|------|
| `wait_for_human` | appears? / disappears? / urlChanges? / timeoutSec? / show? | **遇到验证码 / 扫码 / 登录就调它。** 当前是无头时**自动弹出可见窗口**(show 默认 true;同一份登录态,标签页网址原样恢复),然后阻塞等人操作完。判据三选一可组合:等元素出现 / 等元素消失 / 等网址变化。不发客户端弹窗,靠盯页面变化判断,因此在全自主(bypassPermissions)模式下**照常工作**。结果里 `switchedToHeaded` = 这次新弹了窗、`headed` = 现在有没有窗口(Linux 无图形界面时为 false,`showNote` 说原因)。用法:先导航到要人处理的那一步、在对话里告诉用户要做什么,再调本工具 |
| `hide_window` | — | 人处理完收起窗口,当前工作区换回无头(cookie、标签页网址带过去)。本来就无头时什么都不做。不调也行:临时弹出的窗口空闲 10 分钟(`HEADED_IDLE_CLOSE_MIN`)自动收掉,人手动关掉窗口也一样回到无头 |
| `request_human` | message / show? | 同样先弹出可见窗口,再走协议 elicitation 问用户。⚠️ **在 bypassPermissions 模式下会被客户端自动拒绝且界面无任何提示** —— 那种模式请改用 `wait_for_human`。保留供其它客户端/权限模式使用 |

**换窗口的边界**(弹出 / 收起都是关掉浏览器、用同一个 profile 按新形态重开):
- 带得过去:cookie(含会话 cookie)、localStorage 等 profile 里的数据、各标签页网址和焦点。
- 带不过去:sessionStorage、表单里没提交的输入、页面内存里的 JS 状态 —— 所以先导航到要人处理的那一步、**别先填一半**再弹窗。
- 同一工作区还有**别的调用在跑**(另一个窗口在 navigate / 批量抓取)时拒绝切换并明确报错,不会把人家的调用掐断;等那边跑完再调,或 `space_new` 开个单独工作区处理。

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
| `space_new` | name, headed? | 新建并切换到隔离工作区（独立 cookie/登录态）。headed 一般不用给：默认无头，要人工时 wait_for_human 自动弹窗 |
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

---

## 五、工位模式与管理接口（3.0）

本机单用什么都不用设，行为和以前一样。一台机器上并排跑多个实例（一个 AI 一个浏览器工位）时：

| 环境变量 | 说明 |
|---|---|
| `DESK_ID` | 设了即托管模式；此时 `USER_DATA_DIR` / `LOCALMCP_DATA_DIR` / `SCREENSHOT_DIR` **必填**（每个工位独立，缺了拒绝启动） |
| `KILL_PORT_ON_START=0` | 启动时不清理端口上的进程（免得杀掉邻居） |
| `PIPE_DISABLE=1` | 不起 pipe 腿，只走 HTTP |
| `ADMIN_TOKEN` | `/admin/*` 的 Bearer 令牌；托管模式必填，不设时只许本机访问；任何时候都校验 Host、拒绝带外来 Origin 的网页请求 |
| `TOOL_DEADLINE_MS` | 单次工具调用总期限，默认 120000，0 = 不限 |
| `PAUSE_WAIT_MAX_MS` | 人接管时 AI 的调用最多等多久，默认 600000；0 = 不等直接返回 DESK_PAUSED |
| `ALLOW_BROWSER_CDP=1` | 允许 cdp_send 发浏览器级命令 |
| `BROWSER_EXTENSION` | 自带扩展：`auto`（默认，只在有窗口的完整版 Chromium 里加载）/ `on`（无头也加载，改用新无头模式）/ `off` |
| `IDLE_CLOSE_MIN` 等 | 空闲回收，0 = 永不回收（长流程建议 0） |
| `DEVTOOLS_PORT` | 浏览器远程调试端口（按工位分配，别撞） |
| `BAOLEI_MCP_URL` + `BAOLEI_MCP_TOKEN` | fill_secret 用的堡垒机地址和密钥（不设则按 ~/.claude.json、~/.codex/config.toml 找本机的） |
| `UPLOAD_ALLOW_DIRS` / `OUTPUT_ALLOW_DIRS` / `STRICT_PATHS=1` | 上传 / 导出允许的额外目录；严格路径 |

管理接口（`/health` 不变，仍会在浏览器死掉时拉起它）：

| 方法 路径 | 用途 |
|---|---|
| `GET /livez` | 进程活着即 200，**不拉起浏览器**（管理服务轮询用这个） |
| `GET /admin/state` | 闸门状态、在途调用、各工作区 / 会话 / 标签页 |
| `GET /admin/events?since=` | 工具调用时间线（参数已打码）；`Accept: text/event-stream` 为实时推送，支持 `Last-Event-ID` |
| `POST /admin/pause` `{by?, reason?, mode?: wait\|reject}` / `POST /admin/resume` | 人接管 / 交还 |
| `PUT /admin/allowlist` `{domains: []}` | 网站白名单（含子域名；空 = 不限；页面内跳转也拦） |
| `GET /admin/screenshot?space=` | 当前活动页截图（不拉起浏览器） |
| `POST /admin/restart?space=` | 重启该工作区浏览器（下一次结果带 `recycled: true`） |
| `GET /admin/metrics` | Chromium 进程树内存（Linux）、本进程内存 |

验证：`node claude/test/desk-e2e.mjs`（无头，任何机器）；`HEADED=1` 另测自带扩展（Linux 需要 DISPLAY）。
