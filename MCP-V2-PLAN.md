# MCP SDK v2 迁移与新能力接入方案

> 分支 `feat/mcp-v2`。本文所有结论都标了**验证方式**——没实测的一律写「未验证」。
> 面向:维护这个仓的人,以及其它机器上照着升级的 AI。

---

## 0. 一句话

**阶段一(已完成)**:纯 v2、零 v1 残留、44 个工具全在、线上行为不变。
**阶段二~四(待做)**:补上今天就能用的新能力 → 稳定性与跨平台 → 双协议线支持。

---

## 1. 背景:为什么现在做,以及为什么**不**直接切新协议

### 1.1 协议现状(实测)

| 事实 | 怎么验的 |
|---|---|
| 最新已发布协议修订是 **`2026-07-28`** | GitHub `modelcontextprotocol/modelcontextprotocol` 的 `schema/` 目录:`2024-11-05`/`2025-03-26`/`2025-06-18`/`2025-11-25`/`2026-07-28`/`draft` |
| SDK v2.0.0 于 **2026-07-27** 发布,拆成 `core`/`server`/`client`/`node` + `express`/`hono`/`fastify` 适配器 | npm + GitHub releases |
| **Claude Code 2.1.251 请求的是 `2025-11-25`** | 起探针 MCP 服务器,用 `claude mcp list` 触发其真实握手抓包 |
| **v1 不是 EOL**,v1/v2 长期共存 | [官方 v2 升级指南](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html) |
| **升 v2 ≠ 换协议**:"Nothing in v2 puts a 2026-07-28 byte on the wire by default" | [2026-07-28 支持指南](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28) |

### 1.2 为什么不直接切到 `2026-07-28`

`2026-07-28` **移除了协议级 session**(不再有 `Mcp-Session-Id`)。而本仓最核心的能力——
**一台机一份浏览器、每个客户端会话自动分到自己的标签页/屏蔽规则/数据库指针**——
整个建立在 session 之上(全仓 **158 处**依赖 `sessionId`)。

官方给的替代品 `requestState` **不是 session 的替代**:它是「多步输入流程」的续传令牌
(服务器返回 `inputRequired(...)` 时带上,客户端原样回传),不是「这个窗口长期拥有第 3 个标签页」。
新协议下要保住隔离,只能让 **AI 每次调用显式传 handle**。

所以今天切过去 = **收益 0(没有客户端会说新协议)+ 核心能力退化**。
正确姿势是阶段四的**双线并行**:服务端支持新协议,客户端哪天升级自动走新的。

---

## 2. 阶段一:迁到 v2、清空 v1 ✅ 已完成

提交:`b222636`(引入 v2 依赖)、`c8063d5`(完成迁移)

### 做了什么

1. 跑官方 codemod:`npx @modelcontextprotocol/codemod@2.0.0 v1-to-v2 .`
   - 自动改写 import、符号改名、transport 替换
   - `StreamableHTTPServerTransport` → `NodeStreamableHTTPServerTransport`
2. 手工处理 codemod 标出的 **52 处**:`inputSchema`/`outputSchema` 由**裸 shape** 改为 Standard Schema 对象
   - 原代码写的是 `inputSchema: NavigateSchema.shape`,v2 要求 `inputSchema: NavigateSchema`
3. **`ResultEnvelope` 由裸对象改成 `z.object()`** —— 这是 16 个编译错的**真正根因**:

   > `registerTool` 有两个重载。现代重载要求 `outputSchema` 是 `StandardSchemaWithJSON`;
   > `ResultEnvelope` 是裸对象 → 现代重载匹配失败 → TS 回退到 raw-shape 重载,
   > 于是报出「`ZodObject` 不能赋给 `ZodRawShape`」这种**指向反了**的错误。
   > **排错提示**:v2 里看到这个报错,先查 `outputSchema`,别去改 `inputSchema`。

4. 两个包的 `package.json` 均移除 `@modelcontextprotocol/sdk`;删 `node_modules` + `package-lock.json` 重装

### 验收(全部实测通过)

| 检查 | 结果 |
|---|---|
| `tsc --noEmit` | **0 错误** |
| v1 残留 | 源码 0 处 import、lock 0 处引用、`node_modules/@modelcontextprotocol` 只剩 v2 五件套 |
| 构建 | `npm run build` 通过,`dist/server.js` 55,893 字节 |
| 服务启动 | `/health` = 200,浏览器正常拉起 |
| MCP 握手 | 协商 `2025-11-25` ✓ |
| **工具数** | **44 个,与 v1 完全一致** ✓ |
| 真实调用 | `navigate` 打开 example.com ✓ / `get_page_content` 正常返回 ✓ |
| 参数校验失败 | **已返回 `isError: true`** —— 符合 2026-07-28 新规范,v2 自带,无需改代码 |
| 协议降级 | 客户端请求 `2026-07-28` → 服务端协商回 `2025-11-25`,**不报错不断连** |

> **白赚的一项**:2026-07-28 要求「入参校验失败按工具执行错误返回而非协议错误」,
> v2 已经这么做了。迁移本身就把这条规范落地了。

---

## 3. 阶段二:接上今天就能用的新能力

> 这些**不需要**新协议,当前客户端已支持。优先级最高,收益最直接。

### 2.1 elicitation —— 工具主动向用户要输入

**现状**:全仓 **0 处**使用。但探针实测 Claude Code 握手时**声明了 `elicitation` 能力**,
且 `elicitInput` 就在 SDK 里(v1 的 `server/index.d.ts:158` 即有,v2 同样提供)。

**为什么这是本仓最该补的一项**:
有头浏览器(3213)存在的唯一理由就是**让人工过验证码/登录**。
现在撞到登录墙时,工具只能返回失败 → AI 在聊天里跟用户说「请去登录」→ 用户登完再告诉 AI 继续。
用 elicitation 可以让工具**直接把请求弹到用户面前**,登完自动往下走。

**落点**:`navigate` / `click` / `fill_form` 检测到登录墙或验证码时;新增内部 helper 统一处理。

**写法(v2,同时兼容两条线)**:
```ts
// 现代写法,SDK 的 legacy shim 会在 2025 线客户端上自动转成真实的服务端→客户端请求
return inputRequired({
  inputRequests: {
    login: inputRequired.elicit({
      message: '目标站点要求登录,请在已打开的浏览器窗口中完成登录后确认',
      requestedSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
    }),
  },
});
// 重入时读取:
const done = acceptedContent(ctx.mcpReq.inputResponses, 'login', SCHEMA);
```

### 2.2 进度通知 —— 长任务不再是黑盒

**现状**:全仓 **0 处**使用。而这些工具可能跑几分钟:

| 工具 | 为什么慢 |
|---|---|
| `crawl_pages` | `maxPages` 上限 **50** |
| `batch_fetch` | 多 URL 串行 |
| `discover_urls` | 全站探测 |
| `pdf_export` | 大页面渲染 |
| `wait_for_selector` / `wait_and_extract` | 默认超时 30s/10s |

**改法**:这些工具的 handler 里按页/按条目上报 progress。客户端能看到「第 7/50 页」,
而不是等到超时才知道卡住了。

### 2.3 outputSchema 补全

现状 44 个工具里 **19 个**有 `outputSchema`。补齐其余的,让调用方拿到结构化结果而不是 JSON 字符串。

---

## 4. 阶段三:稳定性、速度、跨平台

### 3.1 已修的崩溃(提交 `ee61d9a`,已在 master)

**「有头浏览器总是自动关闭」的真因**:patchright 内部在新 frame/session 附着时重新下发拦截指令
(`CRNetworkManager.setRequestInterception` → `_forEachSession` → `Network.setCacheDisabled`),
遍历到刚关闭的标签页就抛无主 `ProtocolError`。这条 Promise **不属于任何调用方**,
本仓所有 `route`/`unroute` 都带了 `.catch()` 也兜不住。
而 `unhandledRejection` 处理器无差别 `process.exit(1)` → PM2 重启 → **浏览器连同登录态全丢**。

已改成:只放行「目标已关闭」类良性错误,其余仍 `exit(1)` 快速失败。
**验证方式**:HTTP 模式注入无主拒绝 —— `session closed` → 进程存活且 `/health` 200;
`TypeError` → 仍退出码 1。

### 3.2 跨平台(Windows / Linux / macOS)

**当前缺口**:`killPortProcess` 是**纯 Windows 实现**(`netstat -ano` + `taskkill /F /T`),
在 Linux/macOS 上直接失效 —— 端口被占时清不掉。

改法:抽出平台适配层,按平台分派:

| 平台 | 查监听 PID | 杀进程树 |
|---|---|---|
| Windows | `netstat -ano` + 按列精确解析(**保留现有实现**,见下) | `taskkill /F /T /PID` |
| Linux | `ss -lptn` 或 `lsof -ti:PORT` | `kill -TERM` → `kill -KILL` 进程组 |
| macOS | `lsof -nP -iTCP:PORT -sTCP:LISTEN -t` | 同 Linux |

> ⚠️ **Windows 那份实现不许简化**。原实现用 `netstat -ano | findstr :3211` —— `findstr` 是**子串匹配**,
> `:3211` 会命中 `:32110`,于是 `taskkill /F /T` 掉一个**完全无关**的进程连同整棵进程树。
> 现有代码改成了按列解析 + 三重校验(协议列以 TCP 开头 / 端口字段严格相等 / 状态为 LISTENING)。
> 这是踩过的坑,重构时必须原样继承。

其余平台相关点(已有处理,重构时保留):
- 浏览器启动参数按平台分支(`browser.ts:284-287`)
- `mcp.mjs` 里 `npm`/`npx`/`pm2` 的 `.cmd` 后缀与 cmd.exe 引号处理
- 开机自启:Windows 走「启动」文件夹 + `pm2 resurrect`;Linux/macOS 走各自机制
- **有头浏览器不能注册成系统服务**(Windows Session 0 里窗口不可见,人工接管就失去意义)

### 3.3 速度

- `set_block_rules` 屏蔽图片/广告已有,默认未开——评估是否对爬取类工具默认开启
- HTTP 常驻(3213/3214/3215)已是一台机一份浏览器,避免 stdio 每窗口一套进程
- 待测:`snapshot` 的 `maxChars` 截断策略、`extract_data` 批量路径

---

## 5. 阶段四:双协议线(`2025-11-25` + `2026-07-28` 并存)

### 目标

服务端**同时**服务新旧两条线。客户端升级那天自动走新协议,**中间零改动、零停机**。
这才是「一步到位」的正确形态——而不是今天单方面切过去。

### 关键改动

```ts
// 当前(仅 2025 线)
transport = new NodeStreamableHTTPServerTransport({ ... })

// 目标(双线,一个工厂同时服务)
const handler = createMcpHandler(() => buildServer(), { legacy: 'stateless' })
```

- `createMcpHandler(factory, { legacy: 'stateless' })` 默认**逐请求**同时服务两个时代
- SDK 自带 legacy shim:用现代写法(`inputRequired(...)`)写的 handler,在 2025 线客户端上
  会被自动转成真实的服务端→客户端请求。**所以阶段二按现代写法写,阶段四零返工**
- stdio 侧用 `serveStdio(() => buildServer())`,连接建立时协商时代

### 会话隔离怎么办(**未定,需拍板**)

2026-07-28 没有 session。可选:

| 方案 | 机制 | AI 使用负担 | 风险 |
|---|---|---|---|
| A. 双轨 | 2025 线沿用 session 自动隔离;2026 线要求显式 handle | 仅新协议下需传参 | 两套代码路径 |
| B. 全显式 handle | 两条线都改成工具参数传 handle | AI 每次都要传 | 体验退化,但实现统一 |
| C. 单实例不隔离 | 放弃多会话隔离 | 无 | **核心卖点丢失,不可接受** |

**倾向 A**,但需要在阶段四开工前确认。

---

## 6. 全机群推广

现有 `UPDATE-PROMPT.md` 是发给其它机器的自包含升级提示词,`panel-agent` 支持白名单更新
(`git pull` / 重启 agent / 装 MCP)。推广路径:

1. `feat/mcp-v2` 合入默认分支前,**先在本机灰度**:切服务、跑一天真实使用
2. 更新 `UPDATE-PROMPT.md`,写明 v2 迁移注意事项(尤其 `node_modules` 必须重装,不能只 `git pull`)
3. 通过 panel 推送白名单更新
4. **回滚预案**:v2 与 v1 包名不同,`git revert` + `npm i` 即可回到 v1;
   dist 是构建产物,回滚后重新 `npm run build`

⚠️ **推广前必须确认**:`mcp.mjs` 的 `install`/`update` 流程在 v2 下是否还正确
(它会 `npm install` + 构建 + 重启 PM2)。**未验证**。

---

## 7. 待拍板 / 未验证清单

| 项 | 状态 |
|---|---|
| 阶段四会话隔离选 A/B/C | **待拍板** |
| `mcp.mjs` 的 install/update 在 v2 下是否正常 | **未验证** |
| `mcp-database` 包迁移后的真实连库测试 | **未验证**(仅编译通过) |
| 有头浏览器(3213)在 v2 下的完整验证 | **未验证**(仅无头 3215 测过) |
| 阶段二 elicitation 在 Claude Code 上的真实弹窗表现 | **未验证** |
| Codex 客户端请求哪个协议版本 | **未验证** |
| `@types/jsdom` 28 vs jsdom 29 版本错配 | 未处理 |

---

## 变更记录

- 2026-08-31:阶段一完成(v2 迁移 + 清空 v1),实测验收通过。本方案首版。
