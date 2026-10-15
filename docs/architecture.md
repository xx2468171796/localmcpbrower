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
| `DEVTOOLS_PORT` | 9222 | 按工位分配 | 调试端口不撞 |
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
- **防外泄（不变量）**：只有当前页面的站点和资产登记的地址（`address` 或标签里的域名）对得上才填，对不上返回 `SECRET_ORIGIN_MISMATCH`——防止 AI 被诱导把密码填进别的网站。值只在内存里过一遍，不进事件流、日志、遥测、工具结果；`type` / `fill_form` 的参数摘要同样打码。
- **审计**：每次取用都是堡垒机里一次 `get_asset` 调用，归属到这台机器 / 这个工位的密钥，堡垒机自带审计。
- **站点判定细节**（2026-10-15 独立审查后加固）：读输入框所在文档自己的 `location.origin`，不看 `frame.url()`；
  不透明来源（`data:` / 沙箱 iframe）和隔离世界里读不到确定来源的 `srcdoc` 一律拒填（宁可不填）；
  资产登记的网址全是 https 时页面也必须 https；站点检查紧挨着填写做（取 2FA 码的网络往返之后）。
  填写 / 提交出错时 Playwright 报错末尾带调用日志 `fill("<值>")`，**原文一律不外传**，只给错误码和固定说明，另有兜底把值从任何错误信息里抹掉。
- **重定向**：页面请求不在服务端跟随跳转（否则最终内容挂在原网址下，站点检查和白名单都被骗）；
  白名单生效时服务端把整条跳转链逐跳过一遍，有一跳不许整个拦下，全许才把第一跳交回浏览器自己跳。
- **做不到的（如实写清）**：值已经在页面里，AI 若主动用 `execute_js` / `get_element_attribute` 读输入框仍能读到——
  只要 AI 能在页面里跑脚本就挡不住。本设计防的是「明文意外进对话 / 日志 / 时间线」，
  防不了「被页面内容诱导、主动去偷的 AI」，后者靠站点白名单、人工监督（时间线 + 接管）兜底。
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
| 4 工位管理服务（新仓库） | 增删改查工位、汇总监测、自动拉起、MCP 工具；可视工位（有头 + 虚拟屏 + Selkies）/ 后台工位（无头）/ 按需挂屏 | 一条命令开出 / 关掉一个工位，资源全部回收 |
| 5 Hermes 面板 | 左聊天右画面 + 时间线 + 接管按钮 | 你在 hm-admin 里边聊边看边接管 |
| 6 编排 | fork n8n，加「浏览器工位」节点 | 定时流程跑通「登录 → 导出 → 通知」 |

第三层（自编译 Chromium）不排期：只在某个网站用前两层确实过不去时再评估。

## 10. 约束

- 裁判层（`claude/eval/**`、各 `package.json`、`claude/tsconfig.json`、`.ankotti/evolve.json`、CI）AI 不改；`/health` 字段与 `browserAlive: true` 行为不改；`_meta['localmcp/result']` 与 `{success,data,error}` 外形不改。
- 改了工具行为 → 更新 `USAGE.md`；改了安装 / 配置 → 更新 `UPDATE-PROMPT.md` 与 `mcp.mjs config`。
- 发布：合并后由发布中心出包，各机 ai-kit 在浏览器空闲时自动换版本；ai-desk 上手动 `git pull` + 构建 + 重启（第 4 期由管理服务接管）。
