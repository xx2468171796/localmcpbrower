# 浏览器 MCP 架构与「AI 浏览器工位」升级设计

> 2026-10-15 起草。先读这份再改代码；新增领域或改边界先改这里。
> 现状细节（协议、pipe、踩坑）仍以 `MCP-V2-PLAN.md`、`AGENTS.md` 为准，这里只写**升级要到哪、边界在哪、怎么验收**。

## 1. 目标与验收

**目标**：让 AI 对浏览器有完全、可观测、可接管的控制权，并能一人一个（一个 AI 一个）地开出去。

| 场景 | 验收依据 |
|---|---|
| 本机（Windows / Linux / macOS）照常用，升级后不退步、更稳 | `pnpm eval` 不低于基线；Windows 本机 + Linux 虚拟机实测；macOS 靠代码不碰平台分支 + 同事抽验 |
| 多个 AI 各开自己的浏览器，互不干扰 | 同一台机起 3 个实例：端口 / 数据目录 / 截图 / 登录态互不串，关一个不误杀别的 |
| 人能看到 AI 在做什么 | 事件时间线：每次工具调用的工具名、参数摘要、耗时、成败、当前网址，实时推送 |
| 人能随时接管、再交还 | 暂停后 AI 的调用等待或收到「人工接管中」，人操作完恢复，AI 接着干 |
| 编排（以后 fork n8n）能可靠调用 | 失败带 `isError` 和错误码；结果有结构化数据；长流程不会被闲置回收悄悄清空 |

## 2. 规模与选型

- **medium**：多个模块、长期迭代、多 AI 并发使用；但浏览器 MCP 本身仍是**单进程 Node 服务**（一个进程 = 一个工位），不拆服务。
- 并发与隔离靠**多进程**（每工位一个进程 + 自己的 Chromium），不在一个进程里做多租户。
- 只在内部使用。编排层以后 fork n8n（Sustainable Use License 允许内部使用和修改）。
- 不新增依赖（`package.json` 属裁判层，要加依赖由人改）。SSE 用 Express 原生实现。

## 3. 总体结构与依赖方向

```
 编排（fork n8n，以后） ─┐
 Hermes「AI 的屏幕」面板 ─┼─→ 工位管理服务（新仓库，第 4 期） ─→ 浏览器 MCP 实例 × N（本仓库）
 Claude Code / 其它 AI ──┘          │                                 ├─ MCP 工具（47 个 + 新增）
                                    └─ 虚拟屏 / Selkies 推流           └─ 管理接口 /admin/*（新增）
```

- 浏览器 MCP **不知道**工位管理服务的存在：只暴露 MCP 工具 + `/admin/*` 管理接口，由环境变量决定运行形态。
- 工位管理服务只通过 `/admin/*` 和进程管理（systemd）操作实例，**不读写实例的数据目录**。
- 本机单用（今天的用法）= 不设托管环境变量，行为与 2.4.0 一致。

## 4. 浏览器 MCP 内部模块

现有大文件（`server.ts` 1168 行、`browser.ts` 1204 行、`tools.ts` 1422 行）超出 500 行规范，属历史遗留，**不整体搬家**；新能力一律放新文件，旧文件只加挂钩点。

| 模块（文件） | 职责 | 不负责 |
|---|---|---|
| `server.ts` | 两条腿（HTTP / pipe）、会话、注册工具、统一包装 `humanizeOutput` | 业务判断；新能力只在包装处挂钩 |
| `browser.ts` `BrowserManager` | 工作区与 Chromium 生命周期、会话标签页、空闲回收、有头/无头切换 | 事件、暂停、权限判断 |
| `tools.ts` | 47 个工具的实现 | 横切逻辑（超时、暂停、记录） |
| **新** `desk/events.ts` `EventRing` | 有界环形缓冲存工具调用事件；订阅者（SSE）推送；按 `since` 补发 | 落盘（不落盘，管理服务自己存） |
| **新** `desk/gate.ts` `DeskGate` | 工位状态机（运行 / 暂停）、网站白名单判定；暴露 `admit(tool)` | 弹窗、显示切换 |
| **新** `desk/admin-routes.ts` | `/admin/*` 路由：状态、事件流、暂停 / 恢复、截图、重启；独立管理令牌 | MCP 协议 |
| **新** `desk/config.ts` | 托管模式环境变量的解析与校验（Zod），启动时一次性读 | — |
| **新** `safe-path.ts` | 截图 / PDF / 上传路径收口到允许的目录 | — |
| **新** `tools-cdp.ts` | 原生 CDP 直通工具 | — |

### 4.1 核心对象与不变量

- **`ToolEvent`**（值对象）：`{ id 单调递增, ts, session, space, tool, args 摘要（截断、去掉 text/value 等可能含密码的字段）, phase: start|end, ok, ms, errorCode, url }`。
- **`EventRing`**：容量固定（默认 2000）；`id` 单调递增不复用；订阅者慢了丢最旧的，不阻塞工具调用。
- **`DeskGate` 状态机**：

  | 状态 | 事件 | 结果 |
  |---|---|---|
  | running | pause（人） | paused；在途调用不打断，新调用按 `PAUSE_MODE` 等待或立即返回 `DESK_PAUSED` |
  | paused | resume（人） | running；等待中的调用继续 |
  | paused | 等待超过 `PAUSE_WAIT_MAX`（默认 10 分钟） | 该调用返回 `DESK_PAUSED`，状态不变 |
  | 任意 | 只读工具（`list_tabs`、`space_list`、`snapshot`、`take_screenshot`）、`wait_for_human` | 放行 |

- **哨兵页不变量**：有头工作区的浏览器活着时至少保留一个标签页。会话关闭时如果它的页是最后的，先开一个无主的 `about:blank` 再关（修 bug：关最后一页 Chrome 退出）。
- **调用期限**：每次工具调用有总期限（`TOOL_DEADLINE_MS`，默认 120 秒，高于考卷单题 60 秒），`run_script` / `execute_js` 另有 `timeoutMs` 参数。超时返回 `TIMEOUT`，并保证在途计数归零。

### 4.2 运行形态（环境变量）

| 变量 | 默认（本机） | 托管工位 | 作用 |
|---|---|---|---|
| `DESK_ID` | 空 | 工位 id | 设了即「托管模式」：下面各项按工位隔离 |
| `KILL_PORT_ON_START` | 1 | 0 | 不再清理端口上的别人 |
| `PIPE_SERVICE` / `PIPE_DISABLE` | 按端口推断 | `desk-<id>` 或关 | 管道名不撞 |
| `USER_DATA_DIR` / `LOCALMCP_DATA_DIR` / `SCREENSHOT_DIR` | 安装目录推断 | 托管模式**必填** | 登录态、截图、清理范围各自独立 |
| `ADMIN_TOKEN` | 空 = `/admin/*` 只许本机回环 | 必填（缺了拒绝启动） | 管理接口独立令牌；另外所有 `/admin/*` 都校验 Host（防 DNS 重绑定）并拒绝带外来 Origin 的请求（被操控的浏览器本身就在本机，网页能直接打 127.0.0.1） |
| `IDLE_CLOSE_MIN` 等 | 现值 | 0（不回收） | 长流程不被悄悄清空 |
| `DEVTOOLS_PORT` | 9222（仅 `DEVTOOLS=true`） | 不设（第 4 期定：回环上的调试端口没有鉴权，同机别的工位用户能直接接管浏览器） | 真要开须按工位分配，不撞 |
| `BROWSER_TELEMETRY` | 现状 | 标签带 `DESK_ID` | 遥测可区分工位 |

## 5. 对外接口

### 5.1 MCP 工具（兼容为先）

- 输出外形不变：`{success, data, error}` + `_meta['localmcp/result']`（考卷读它）。**新增**：失败时 `isError: true`、`error` 带稳定错误码（`TIMEOUT`、`DESK_PAUSED`、`DOMAIN_BLOCKED`、`PATH_DENIED`、`NO_PAGE`、`ELEMENT_NOT_FOUND`…）；有结构的结果同时给 `structuredContent`。
- **新增 `cdp_send`**（第一层「CDP 全开放」）：`{ method, params }`，在当前页的 CDP 会话上直接发命令。
  默认只开放页面级的域（**白名单**：DOM / CSS / Emulation / Input / Network / Page / Runtime / Performance 等），
  并单独挡掉能越过文件 / 网站保护的命令：`DOM.setFileInputFiles`、带文件的 `Input.dispatchDragEvent`、`Network.loadNetworkResource`、
  `Page.setDownloadBehavior`、`Page.close/crash`；`Page.navigate` 只许 http(s) 且过白名单。其余域（Browser / Target / IO / Fetch / Storage …）
  要 `ALLOW_BROWSER_CDP=1`（2026-10-15 审查：黑名单版本一条 `Page.navigate file:///…/.claude.json` 就能读到本机堡垒机密钥）。
- `run_script` 加 `timeoutMs`；以后加 `run_flow`（跨导航的多步流程，一次调用跑完，给编排用）。
- 被回收后重建的页，下一次结果带 `recycled: true`，不再悄悄返回空数据。

### 5.2 管理接口 `/admin/*`（新增，`/health` 一字不改）

| 方法 路径 | 返回 |
|---|---|
| `GET /livez` | 进程活着即 200，**不**拉起浏览器（`/health` 会拉起，考卷依赖这个行为） |
| `GET /admin/state` | 工作区、有头与否、Chromium pid、在途调用、各会话标签页（网址、标题、活动页）、闸门状态 |
| `GET /admin/events?since=<id>` | 补发事件；`Accept: text/event-stream` 时为 SSE（支持 `Last-Event-ID`） |
| `POST /admin/pause` / `POST /admin/resume` | 闸门切换，返回新状态 |
| `PUT /admin/allowlist` | 设网站白名单（空 = 不限） |
| `GET /admin/screenshot?space=` | 当前活动页截图 |
| `POST /admin/restart?space=` | 关掉该工作区浏览器，下次调用重建 |
| `GET /admin/metrics` | Chromium 进程树内存、CPU、调用计数 |
| `GET /admin/display` / `POST /admin/display {width,height}` | 托管工位的虚拟屏分辨率：查 / 切（允许列表、记住、窗口撑满、重启画面），见 §11「分辨率与画质」 |

请求体一律先过 Zod；错误统一 `{ error: { code, message } }`。

## 6. 关键流程

- **人接管**：画面上看到 AI 走偏 → 面板点「接管」→ `POST /admin/pause` → AI 下一次调用等待 → 人在 Selkies 画面里操作 → 点「交还」→ `resume` → 等待中的调用继续，事件流里记一条 `pause` / `resume`。
- **AI 卡住**：事件流里某个 `start` 超过期限没有 `end` → 管理服务告警；调用期限到点自动返回 `TIMEOUT`，在途计数归零。
- **浏览器崩溃**：`context.on('close')` → 工作区标记已关 → 下次调用重建 → 结果带 `recycled: true` → 事件流记一条 `browser_restart`。
- **路径越权**：截图名 / PDF 路径 / 上传文件解析后不在允许目录 → 返回 `PATH_DENIED`，不读不写。

## 7. 堡垒机对接（密钥不进 AI 上下文）

目标：AI 登录网站时**只说用哪条资产**，密码 / 2FA 码由浏览器 MCP 直接从堡垒机取、直接填进页面，AI 全程看不到明文。

- **取密钥的身份**：复用 `telemetry.ts` 的 `baoleiEndpoint()`（环境变量 `BAOLEI_MCP_URL` + `BAOLEI_MCP_TOKEN` → `~/.claude.json` → `~/.codex/config.toml`），即本机主人的堡垒机密钥；托管工位由管理服务注入该工位专属的堡垒机 AI 密钥（只勾「资产」能力）。密钥只发往堡垒机自己的源（沿用遥测的同源检查）。
- **新增工具**（模块 `secrets/`）：
  - `fill_secret { target(ref|selector), asset(id|名称), field: 'secret'|'account'|'otp'|<字段名> }`：调堡垒机 `get_asset`（reveal / otp），把值填进目标输入框，返回只有「已填 N 位」。
  - `login_with_asset { asset, user?, pass?, otp?, submit? }`：一次填账号、密码（和 2FA）并提交，给常见登录页用。
- **防外泄（不变量）**：只有当前页面（及其上层 frame）的站点和资产登记的地址（`address` 或新版堡垒机的 `hosts`，不看标签）对得上才填，对不上返回 `SECRET_ORIGIN_MISMATCH`——防止 AI 被诱导把密码填进别的网站。值只在内存里过一遍，不进事件流、日志、遥测、工具结果；`type` / `fill_form` 的参数摘要同样打码。
- **审计**：每次取用都是堡垒机里一次 `get_asset` 调用，归属到这台机器 / 这个工位的密钥，堡垒机自带审计。
- **站点判定细节**（2026-10-15 独立审查后加固）：读输入框所在文档自己的 `location.origin`，不看 `frame.url()`；
  不透明来源（`data:` / 沙箱 iframe）和隔离世界里读不到确定来源的 `srcdoc` 一律拒填（宁可不填）；
  资产登记的网址全是 https 时页面也必须 https；站点检查紧挨着填写做（取 2FA 码的网络往返之后）。
  填写 / 提交出错时 Playwright 报错末尾带调用日志 `fill("<值>")`，**原文一律不外传**，只给错误码和固定说明，另有兜底把值从任何错误信息里抹掉。
- **重定向**：页面请求不在服务端跟随跳转（否则最终内容挂在原网址下，站点检查和白名单都被骗）；
  白名单生效时服务端把整条跳转链逐跳过一遍，有一跳不许整个拦下，全许才把第一跳交回浏览器自己跳。
- **第二轮安全审计加固**（2026-10-15）：
  - 站点规则：只取 `address` 和新版堡垒机的 `hosts`，**不用自由填写的 tags**；默认精确主机名，`*.example.com` 才认子域名；
    登记里写了端口就比端口；IP / localhost / [IPv6] 都能登记（以前 hosts 混进 tags 后只认域名形状，IP 被丢掉）。实现 `secrets/asset-hosts.ts`。
  - 防改道（`secrets/fill-target.ts`）：绑定到一个 ElementHandle（文档一换句柄即失效、写入失败，不会改写到新文档里同选择器的框）；
    输入框所在文档**和每一层祖先 frame** 都要属于登记站点；一次性填写在同一次隔离世界 evaluate 里核对
    `location.origin` + `location.ancestorOrigins` + 元素类型 + 表单提交去向后用原生 setter 写入；逐字键入每个字前核对焦点和来源，中途不对就清空并中止。
  - 元素限制：secret 只进密码框（或 autocomplete=current/new-password），otp 只进单行输入框，其它字段只进 `<input>`；不进 textarea / contenteditable。
  - 证书：托管工位关掉 `ignoreHTTPSErrors`；本机单用仍忽略（内网自签站点要能打开），但 fill_secret 填 https 站点前在服务端用
    Node 自带 + 系统根证书严格校验一次对方证书（`secrets/tls-check.ts`），不过就拒填。
  - 浏览器子进程的环境去掉令牌 / 密码 / 密钥类变量（`browser-env.ts`）。
  - 填过的框打 `data-ego-secret` 标记：snapshot 显示「(已填资产)」，录制器当敏感框。
  - 等主人批准：取消信号一路传到轮询，期限（`deadlineFor`）按两次等待留够，先到的是 `SECRET_PENDING_APPROVAL` 而不是统一 TIMEOUT；
    旧版堡垒机「不认 use_on」的回退只认窄的 schema 报错特征、只退一次，带 `ASSET_USE_*` 的答复绝不回退。
  - 被操控的页面打不开本服务自己的地址；/admin 不接受本服务自己的 Origin。
- **做不到的（如实写清）**：值已经在页面里，AI 若主动用 `execute_js` / `get_element_attribute` 读输入框仍能读到——
  只要 AI 能在页面里跑脚本就挡不住。本设计防的是「明文意外进对话 / 日志 / 时间线」，
  防不了「被页面内容诱导、主动去偷的 AI」，后者靠站点白名单、人工监督（时间线 + 接管）兜底。
  另外几条残余风险：逐字键入时「核对焦点」和「按下这个键」之间仍有极短窗口，焦点恰在这时被抢走最多漏 1 个字（下一次核对发现后中止并清空）；
  证书校验是服务端另起一条 TLS 连接，浏览器走代理 / 自有 DNS 时两条路径可能不同；本机单用的内网自签 https 站点会被 fill_secret 拒填
  （把自签 CA 装进系统证书库或用 NODE_EXTRA_CA_CERTS 即可）；`data-ego-secret` 标记页面自己能删，删了 snapshot 会显示账号类明文（密码框仍只显示「已填密码」）。
- **反方向（第 4 期）**：堡垒机 MCP 加「工位」工具（开 / 关 / 看 / 接管），经工位管理服务操作；人在堡垒机面板上也能看到所有工位。

## 8. 权限

浏览器 MCP 没有用户体系，按**令牌**分两级：MCP 令牌（能用全部工具）、管理令牌（能看状态、暂停、重启）。谁拿到哪个令牌由工位管理服务决定（第 4 期，按堡垒机身份）。不接 quanxian：这里没有人员 / 角色 / 数据范围，只有「这个进程归哪个 AI」。

## 9. 分期与验收

**业主 2026-10-15 定：本仓库的 1～3 期一次做完，发一个 3.0.0**（旧代码多为早期 AI 所写，借这次整体修好，不分几次小修）。

| 期 | 内容 | 验收 |
|---|---|---|
| **1 修稳 + 隔离** | 6 个 bug（UA 读真实版本 + Client Hints、哨兵页、`/livez`、调用期限 + `run_script` 超时、管道探测误删、路径收口）；托管模式环境变量；`isError` + 错误码；回收开关 + `recycled`；47 个工具逐个过一遍（超时、等待、错误、上限） | `pnpm eval` 不低于基线；Windows 本机 + Linux 虚拟机各跑冒烟；同机 3 实例隔离测试 |
| **2 看得见、接得住** | `EventRing` + `/admin/*`；`DeskGate` 暂停 / 白名单；`cdp_send`；`structuredContent`；**堡垒机 `fill_secret` / `login_with_asset`** | 同上 + 暂停 / 恢复 / 白名单 / 事件流 / 防外泄的单元与集成测试 |
| **3 第二层控制** | 自带 Chrome 扩展（全标签页、下载、浏览器级网络规则、操作录制）；`run_flow` | 有头 / 无头都能加载扩展；录制的流程能不经 AI 回放 |
| 4 工位管理（`deploy/desk/`，见 §11） | 一人一个工位：systemd 模板单元 + `deskctl` 增删查改、轮换、状态；每工位独立 Linux 用户；端口只许 Hermes 宿主机访问；堡垒机当控制面 | 一条命令开出 / 关掉一个工位，资源全部回收；两个工位互相读不到对方登录态 |
| 5 Hermes 面板 | 左聊天右画面 + 时间线 + 接管按钮 | 你在 hm-admin 里边聊边看边接管 |
| 6 编排 | fork n8n，加「浏览器工位」节点 | 定时流程跑通「登录 → 导出 → 通知」 |

第三层（自编译 Chromium）不排期：只在某个网站用前两层确实过不去时再评估。反检测见 §12。

## 11. 工位管理（第 4 期，2026-10-15 定）

**选型（small）**：不另起带数据库的「工位管理服务」。现在只有几个人、一台工位机（ai-desk，PVE VM170），
工位 = 工位机上一组 systemd 模板单元，`deskctl`（bash，root 跑）负责增删查改；**控制面用堡垒机**（权限、审计、远程执行现成：
人或 AI 经堡垒机 `run_command` 调 `deskctl`，以后在 baolei 加 `desk_*` MCP 工具包一层）。
升级条件：工位机超过一台、或要按人自助开工位 / 计费时，再做独立服务（届时 deskctl 的状态文件就是迁移来源）。

**一个工位**（id 匹配 `^[a-z][a-z0-9]{0,26}$`，通常 = 主人的 Hermes 实例名，如 `admin`；最长 27 位是因为 Linux 用户名 `desk-<id>` 最长 32）：
| 组成 | 单元 / 位置 | 说明 |
|---|---|---|
| Linux 用户 | `desk-<id>` | 每工位独立用户：浏览器 profile、截图、下载互相读不到（家目录 700） |
| 单元组 | `desk@<id>.target` | Wants 下面 5 个单元，它们都 `PartOf=` 它：启停 / 重启 target = 整个工位 |
| 虚拟屏 | `desk-xvfb@<id>`：Xvfb `:<20+n>`（n = 工位序号）按 3840x2160 起、`-noreset`，启动后切到工位分辨率（默认 1920x1080） | 显示号从 20 起，避开旧单工位的 `:0` 和验证用的 `:9`。**不用 `-ac`**：X 的抽象 socket 不受 PrivateTmp 隔离，别的工位用户也连得上，必须靠 `~/.Xauthority` 小甜饼（deskctl 生成，FamilyWild） |
| 窗口管理 + 壁纸 | `desk-wm@<id>`、`desk-wallpaper@<id>` | |
| 画面 | `desk-selkies@<id>`：HTTPS `:8080+n` | 主密码 / 只看密码按工位生成，经环境变量 `SELKIES_BASIC_AUTH_PASSWORD` / `SELKIES_BASIC_AUTH_VIEWONLY_PASSWORD` 给（不放命令行，`ps` 看得见）；自签证书各工位一份（`~/.local/state/selkies/`） |
| 浏览器 MCP | `desk-browser-mcp@<id>`：`192.168.110.239:3215+n` | 托管模式：`DESK_ID=<id>`、独立数据目录、MCP 令牌、ADMIN_TOKEN、`PIPE_DISABLE=1`、`KILL_PORT_ON_START=0`、`IDLE_CLOSE_MIN=0`；可选 `BAOLEI_MCP_URL/TOKEN`（该人的「服务代填」服务密钥） |
| 配置 | `/etc/ai-desk/desks/<id>.env`（root 600）| 端口、显示号、令牌、目录；单元经 EnvironmentFile 读 |
| 数据 | `/home/desk-<id>/data/{profile,data,shots}` | |
| 代码 / Chromium | `/opt/ai-desk/browser-mcp`、`/opt/ai-desk/ms-playwright` | 所有工位共用一份，root 所有、只读；`deploy/desk/install.sh` 拉代码构建 |
| 沙箱 | 每个单元 | `NoNewPrivileges`、`ProtectSystem=strict`、`ProtectHome=tmpfs` + 只绑自己的家目录、`PrivateTmp`、`ProtectProc=invisible`、无 capability；浏览器单元 `MemoryMax=3G`；不设 `DEVTOOLS_PORT`（回环上的调试端口没鉴权，邻居能接管） |

**deskctl 命令**：`create <id> [--owner 人] [--index n] [--import 文件] [--no-start]`（分配序号 / 端口、建用户、生成令牌、写 env、起单元、等 /livez；`--import` 从旧 env 文件沿用令牌，迁移用）·`list`·`status [<id>]`（单元状态 + /livez + /admin/state 摘要）·
`restart <id>`·`rotate <id> [mcp|admin|selkies|all]`·`set-baolei <id> [--url]`（从 stdin 读服务密钥）·`show-secrets <id> [--format env|panel|gateway]`（只给 root，给接 Hermes 的脚本用）·`resolution <id> [宽x高]`（看 / 改虚拟屏分辨率，写 env + 工位数据目录并经管理接口马上切）·`delete <id> [--keep-data] --yes`。
可重复执行（幂等）；序号分配记在 `/etc/ai-desk/desks/registry`。另有 `desk-smoke <id>` 冒烟。

**分辨率与画质**（2026-10-16 定，ai-desk 上 t2 实测）：
- 允许 1280x720 / 1600x900 / 1920x1080（默认）/ 2560x1440 / 3840x2160（`claude/src/desk/display.ts` 与 deskctl、desk-proxy 各一份同样的列表）。
- Xvfb 的 RandR 上限 = 启动大小，所以按 3840x2160 起；切换用「给输出加模式 `desk-WxH`（60Hz 时钟）+ `xrandr --output screen --mode`」，不用单独的 `--fb`
  （那会关掉输出，Chromium 看不到显示器、最大化窗口不跟）。**必须 `-noreset`**：不带时最后一个客户端断开 X 就重置，启动时的切换会白做。
- 启动：`desk-xvfb@` 的 `ExecStartPost` 跑 `dist/desk/display-cli.js`，按「工位数据目录 `display-resolution` > env `DESK_RESOLUTION` > 1920x1080」切；之后 wm / 壁纸 / Selkies 才起，看到的就是这个大小。
- 运行中：`POST /admin/display`（浏览器 MCP 以工位用户身份 execFile xrandr、超时 5 秒、串行）→ 记到 `display-resolution` → feh 重铺壁纸 → 窗口最大化
  （浏览器以 `--start-maximized` 起、不给 `--window-size`；openbox 自己会把最大化窗口撑满，被还原的经 CDP `Browser.setWindowBounds` 设回）→ `systemctl restart --no-block desk-selkies@<id>`
  （polkit 规则 `50-ai-desk.rules` 只放行 `desk-<id>` 对自己这个单元的 restart）→ 时间线 `display` 事件。
  选「记在工位自己的数据目录」而不是改 env：env 是 root 600，浏览器 MCP 写不了；`deskctl resolution` 两处一起写，保证一致。
- 为什么要重启 Selkies：它只在连接建立时读屏幕大小；全控连接重连会按新大小，但**只看连接会一直沿用该进程里第一个连接时的大小**（2.0.0 的 `_ensure_viewer_capture` 缓存了布局），
  面板默认就是只看连接。重启约 1–3 秒，所有看的人断开后重连。
- 画质：4:4:4 全彩 + 静止补清晰帧，CRF 16（8–24）、补清晰帧 CRF 8（3–20）、默认 30fps（15–60）。实测（1080P，一个全控观看端）：
  CRF 20→16 CPU 不变、连续滚动码率 33→40 Mbit/s，静止 20 kbit/s；CPU 和帧率成正比 —— 60fps 静止 1.3 核 / 滚动 1.7 核，30fps 静止 0.65 核 / 滚动 0.9 核；
  4K 30fps 1.6–1.9 核。6 核的工位机上几个人同时看 4K 会吃满，4K 只在真需要时开。

**网络**：工位机 nftables（独立表 `inet ai_desk`，`ai-desk-firewall.service` 开机加载）只许 Hermes 宿主机（ubuntu-244，192.168.10.244）、本机和回环访问 8080–8099、3215–3234；其余来源丢弃；22 不动。
**接 Hermes**：ai-workforce-ops 的 `desk-proxy.sh enable <实例>` + 网关 drop-in（20-ai-desk.conf）按 `deskctl show-secrets <id>` 的值写，一人一套（见 ubuntu-244 专题页「AI 助理接工位浏览器」）。
**旧工位 main** 迁成 `admin`（序号 0，端口 8080 / 3215 不变，数据目录搬到 `/home/desk-admin/data`），令牌 / 密码原样沿用，Hermes 侧什么都不用改。
2026-10-15 已完成：停机 6.4 秒；同日开 `leixin`（序号 1）、`wanghaohao`（序号 2）并接上各自的 Hermes。

## 12. 反检测（2026-10-17 定，参考 CloakBrowser 的思路，不用它的闭源内核）

**原则：原生优先，能不伪装就不伪装。** JS 改出来的值本身就是破绽（自有属性、非原生 `toString`、`instanceof` 不对），
所以只走三条原生通道：**内核形态**（完整版 Chromium）→ **启动参数 / 上下文选项**（`--screen-info`、`--accept-lang`、`locale`、`timezoneId`、`proxy`）→ **CDP 覆盖**（UA / Client Hints，已有）。
页面里注入的脚本只剩 console 捕获一件事，而且不留痕迹。验收靠体检脚本 `claude/test/stealth-check.mjs`（本地探针逐项判 + `--online` 看公网检测站），改前改后各跑一次对比。

| 模块（文件） | 职责 | 不负责 |
|---|---|---|
| `browser.ts` 启动处 | 无头一律用完整版 Chromium 的**新无头模式**（不再用 headless shell：它没有 GPU、`window.chrome`、mimeTypes）；无头时 `--screen-info` 给出与身份一致的屏幕；`--accept-lang` 定语言；不再用 `extraHTTPHeaders` 改请求头 | 身份怎么定 |
| `inject.ts` + `browser.ts` `preparePage` | 只注入 console 捕获：按页面经 CDP `Page.addScriptToEvaluateOnNewDocument` 装（先 `Page.enable`；不用 `context.addInitScript`——patchright 1.63 下它让跨站 iframe 加载失败）；方法用 `Proxy` 包（`toString` 仍是原生）、日志存在闭包里、不设全局变量、不插 DOM 节点；跨世界取日志用随机名字的 `CustomEvent`（字符串能跨世界） | 指纹伪装（全部删掉） |
| `document-gate.ts` | 文档请求：白名单为空时交回浏览器自己发（以前为注脚本由 Node 代取，TLS 指纹 / 请求头都不是 Chrome 的，这是最硬的机器人特征）；白名单生效时仍逐跳查重定向链。不再 `bypassCSP`、不再剥 CSP | 本服务地址（route 里拦直接请求；经重定向落过来的由 HTTP 入口按 `Sec-Fetch-Site/Dest` 拒，`desk/gate.ts isForeignNavigation`） |
| `user-agent.ts` | 无头 UA 用 `--user-agent` 启动参数改（Worker 里也一致）；原生 Client Hints 在某内核版本首次启动时于回环小页面读（`about:blank` 不是安全上下文，读不到），按版本缓存 `ua-defaults.json`，读到后立即按参数重启一次；页面上用 CDP 补完整的高熵 Client Hints | 有头（本来就自洽，不碰） |
| **新** `identity.ts` | 工作区身份 `identity.json`（存在该工作区 profile 目录里，跟着登录态走）：屏幕尺寸、时区、语言、代理、拟人开关。首次创建按种子从常见分辨率里挑（默认工作区固定 1920×1080），以后每次启动都一样 = 「同一个回访用户」 | 读写 profile 里别的东西 |
| **新** `geoip.ts` | 有代理时，经这个工作区的浏览器自己（走代理）查一次出口 IP 的时区 / 国家，记进身份；和启动时用的不一致就按新身份重启一次（只发生在第一次或换代理后） | 代理本身的可用性 |
| **新** `humanize/` | 拟人输入：鼠标走带随机扰动的贝塞尔曲线、点在元素内的随机位置、按下抬起有间隔；逐字输入带节奏；滚轮分段缓动。纯计算（`path.ts` / `timing.ts`，随机数可注入，单测可复现）+ 执行（`actions.ts`） | 决定要不要拟人（看身份 / 环境变量） |

**身份不变量**：同一工作区每次启动的屏幕、时区、语言、代理一致；JS、请求头、Worker 里看到的语言 / 时区一致（都用上下文选项，不用页面级覆盖）；平台不伪装（字体和 GPU 跟着真实系统，改平台反而自相矛盾）。
**对外接口**：`space_new` 新增可选 `proxy`（`http://` / `socks5://`，可带账号，存进身份；给 `""` 清掉）、`humanize`（布尔）；环境变量 `BROWSER_HUMANIZE=1` 让所有工作区默认拟人，`BROWSER_PROXY` 给默认工作区挂代理。代理账号密码不进事件流 / 日志 / 工具结果（打码）。
**已知取舍（2026-10-17 独立审查后）**：
- console 捕获的 `console.log.toString()` 不带函数名（Proxy 的限制）；换成在 CDP 会话上开 `Runtime.enable` 更糟（页面打日志会调 `Error.prepareStackTrace`，经典 CDP 检测）。`BROWSER_CONSOLE_CAPTURE=off` 可关。
- 「经重定向落到本服务」靠 `Sec-Fetch-*`，浏览器只对安全上下文目标（https、localhost、127.x）发这些头：服务绑在局域网 IP 的明文 http 上时这道拦不住，此时 `/mcp`、`/admin` 仍要令牌。
- 挂了代理的工作区不忽略证书错误（`fill_secret` 的证书校验是本进程直连验的，代理可以冒充站点）。换代理和换形态走同一条原地重启（拒绝打断别人的在途调用、带上会话 cookie 和标签页）。
- `window.open` 弹出页的第一个文档没有 console 捕获（脚本按页面装，来不及）。

**发版前安全审计（2026-10-17，第二轮）后的规则**：
- **代理来源受限**：AI 经 `space_new` 只能给非默认工作区挂本机 / 局域网代理或 `BROWSER_PROXY_ALLOW` 里的主机；默认工作区只认运维的 `BROWSER_PROXY`（始终以它为准，格式错拒绝启动）。挂了代理：WebRTC 只走代理、`fill_secret` 只填 https 页面且不再本机直连验证书（证书交给浏览器严格校验）、Linux / macOS 上浏览器进程带 `TZ`（Worker 时区也跟出口）。`BROWSER_PROXY` 不传给浏览器子进程和工位其它单元。
- **身份失败即关**：`identity.json` 读不了 / 坏了拒绝启动并在工具结果里说明，`space_new` 显式给 `proxy`（含 `""`）才按默认重建（旧文件留 `.broken-*` 备份）；文件 0600、目录 0700。
- **console 捕获**：事件名每个页面各自随机；取日志只读数据属性、不调 getter；Node 端对应答条数 / 长度 / 类型封顶（页面能伪造应答）。残余：页面传进 `console.*` 的 Proxy 对象，取日志时它的 ownKeys 等陷阱仍会被触发。
- **工位白名单**：托管工位禁用 Service Worker（它能直接回跳转、绕过 route）。残余：白名单生效时重定向链由 Node 先逐跳探测、再交浏览器自己跳，服务器两次回答不同可绕过；一次性链接（OAuth `code`、魔法链接）会被探测请求先用掉。根治要在 CDP `Fetch` 响应阶段查每一跳，另排期。

**做不到的（如实写清）**：没有 GPU 的 Linux 机器（工位机）WebGL 只能是 SwiftShader 软件渲染，这是硬特征，原生改不了、JS 改了又是谎言，不改；体检照实报。canvas / 音频指纹噪声需要改内核（CloakBrowser 那一层），不做。
**Linux 字体**：工位机 / Linux 本机装 CJK、彩色 emoji 和与 Windows 字体等宽的开源字体（`deploy/desk/install.sh`、`mcp.mjs install` 在 Linux 上提示 / 安装），缺字体是被拦的常见原因。

## 13. 约束

- 裁判层（`claude/eval/**`、各 `package.json`、`claude/tsconfig.json`、`.ankotti/evolve.json`、CI）AI 不改；`/health` 字段与 `browserAlive: true` 行为不改；`_meta['localmcp/result']` 与 `{success,data,error}` 外形不改。
- 改了工具行为 → 更新 `USAGE.md`；改了安装 / 配置 → 更新 `UPDATE-PROMPT.md` 与 `mcp.mjs config`。
- 发布：合并后由发布中心出包，各机 ai-kit 在浏览器空闲时自动换版本；ai-desk 上手动 `git pull` + 构建 + 重启（第 4 期由管理服务接管）。
