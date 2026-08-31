# MCP SDK v2 + 协议 2026-07-28 迁移方案

> 分支 `feat/mcp-v2`。**目标:纯新协议(`2026-07-28`),不保留旧线。**
> 本文所有结论都标了**验证方式**;没实测的一律写「未验证」。
> 面向:维护这个仓的人,以及其它机器上照着升级的 AI。

---

## 0. 结论先行

| 阶段 | 状态 |
|---|---|
| 一、迁到 SDK v2、清空 v1 | ✅ 已完成并实测 |
| 二、长任务进度通知 | ✅ 已完成并实测 |
| 三、切纯新协议 `2026-07-28` + 上下文句柄 | 🚧 进行中 |
| 四、跨平台(Windows / Linux / macOS) | 🚧 进行中 |
| 五、elicitation(人工过验证码/登录) | 待做 |

---

## 1. ⚠️ 一次判断失误的记录(**必读,别再犯**)

本方案初版写着「切 `2026-07-28` 收益为 0,因为没有客户端支持」。**这个结论是错的**,
而且错法很有代表性,值得留下来:

### 错在哪

我写了一个手搓的 MCP 探针服务器去测 Claude Code 会请求哪个协议版本。它只实现了
`initialize`,**没有实现 `server/discover`**。抓到的日志是:

```
1. server/discover     ← MCP-Protocol-Version: 2026-07-28
2. initialize          ← 2025-11-25
结果: Failed to connect — Version negotiation probe timed out after 5000ms
```

我看到第 2 行「客户端要的是 2025-11-25」就下了结论。**真相是第 1 行**:
客户端**先用新协议发 `server/discover` 探测**,我的探针不应答 → 5 秒超时 → 才回落旧协议。
**是我的探针不合格,不是客户端不支持。**

### 正确的验证方式

用**真 SDK** 起一个 `legacy: 'reject'`(纯新协议、显式拒绝旧线)的服务器,再让客户端连:

| 验证 | 结果 |
|---|---|
| Claude Code 2.1.251 连纯新协议服务器 | ✅ **Connected**(实测 2 次) |
| 同一服务器收到 `2025-11-25` 的 initialize | ❌ `-32022 Unsupported protocol version`,`supported:["2026-07-28"]` |
| v2 官方客户端**默认**配置 | ❌ 被拒(默认走旧线) |
| v2 官方客户端 `versionNegotiation:{mode:{pin:'2026-07-28'}}` | ✅ 通 |
| Codex 0.142.4 二进制 | 含 `2026-07-28` ×22、`server/discover` ×14(**强信号,未实连验证**) |

### 教训

**测协议协商,不能用手搓的半成品服务器当参照物。** 半成品的沉默会被读成
「对方不支持」,而实际是「我方没接住」。要测就用官方 SDK 起真服务器。

---

## 2. 关键事实(全部实测或有出处)

| 事实 | 来源 |
|---|---|
| 最新已发布协议修订 = **`2026-07-28`** | GitHub spec 仓 `schema/` 目录;更新的只有 `draft`(未发布) |
| SDK v2.0.0 于 2026-07-27 发布,拆成 `core`/`server`/`client`/`node` + `express`/`hono`/`fastify` 适配器 | npm + GitHub releases |
| **升 v2 ≠ 换协议**:"Nothing in v2 puts a 2026-07-28 byte on the wire by default" | [官方 2026-07-28 支持指南](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28) |
| v1 **不是** EOL,v1/v2 共存 | [官方 v2 升级指南](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html) |
| `2026-07-28` **移除协议级 session**,需跨调用状态者改用显式 handle | 同上 + spec changelog |
| **`CLIENT_INFO_META_KEY` 不能当身份用** | SDK 源码原文:"self-reported…**servers should not rely on it for behavior or security decisions**" |

---

## 3. 阶段一:迁到 v2、清空 v1 ✅

提交 `b222636` / `c8063d5`

1. 官方 codemod:`npx @modelcontextprotocol/codemod@2.0.0 v1-to-v2 .`
2. 手工修 52 处:`inputSchema`/`outputSchema` 由**裸 shape** 改为 Standard Schema 对象
3. `ResultEnvelope` 由裸对象改成 `z.object()`

> **排错提示(踩过)**:v2 里若看到「`ZodObject` 不能赋给 `ZodRawShape`」,
> **别去改 `inputSchema`** —— 真凶多半是 `outputSchema` 不是 Standard Schema,
> 导致 `registerTool` 现代重载匹配失败、TS 回退到旧重载后报出**指向反了**的错。

**验收(实测)**:`tsc` 0 错误 · v1 零残留(源码/lock/node_modules) · 构建通过 ·
`/health` 200 · **44 个工具与 v1 完全一致** · `navigate`/`get_page_content` 真实可用 ·
参数校验失败自动变 `isError: true`(新规范要求,v2 白送)。

---

## 4. 阶段二:长任务进度通知 ✅

提交 `c632397`

`crawl_pages`(maxPages 上限 50)、`batch_fetch`(多 URL 串行)原本是黑盒。

实现**沿用本仓既有的 AsyncLocalStorage 思路**,44 个工具函数签名一个没改:
- `context.ts` 加 `ProgressReporter` + `reportProgress()`,无上下文时静默 no-op
- `server.ts` 的 `wrap` 从 `ctx.mcpReq._meta.progressToken` 构造上报器塞进 ALS
- 走**请求级** `ctx.mcpReq.notify` 而非全局 notification —— 前者传输层才能把进度关联回那次 `tools/call`
- 故意不 await、失败静默:进度是旁路,绝不能拖慢主流程或让工具失败

**验收(实测)**:带 `_meta.progressToken` 调 `batch_fetch` 三个 URL,
流式读 POST 响应,收到 3 条 `notifications/progress`(`progress`/`total`/`message` 齐全),最终结果正常。

---

## 5. 阶段三:切纯新协议 + 上下文句柄 🚧

### 5.1 入口改造

```ts
// 现在
transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator, eventStore, ... })

// 目标:纯新协议,显式拒绝旧线
const handler = createMcpHandler(() => buildServer(), { legacy: 'reject' })
const nodeHandler = toNodeHandler(handler)
```

### 5.2 会话隔离 → 显式句柄

新协议没有 session,`currentSessionId()` 会永远返回同一个值 → **所有客户端挤在同一个页面上**。
官方唯一正解是显式 handle 当工具参数。

**已实现**(`schemas.ts`):
- `ContextField` —— 可选字符串,字符集受限,带详细 `describe` 供 AI 理解
- `withContext(schema)` —— 在**注册处**统一套一层,不逐个改 44 个 schema 定义
- `ContextOnlySchema` —— 给无自有参数的工具(`go_back`/`list_tabs` 等)用

**设计取舍:`context` 做成可选而非必填。**
不传就落到共享默认上下文,单窗口用户完全无感(等价于旧协议下只有一个会话的行为),
不会因为漏传参数就报错。需要并行/多账号隔离时用 `space_new` 取名字再带上。
该值**只做隔离键**,不参与任何权限判断 —— 它是便利,不是安全边界。

**验收(实测)**:不传通过 · 传合法值通过 · 非法字符被拒 · 原有校验仍生效 ·
JSON Schema 里 `required` 不含 `context` 且 `properties` 含它(AI 看得见)。

### 5.3 待改清单

| 项 | 处理 |
|---|---|
| `wrap` | 从 `args[0].context` 取值塞进 ALS(**深层 47 处调用一行不动**) |
| 44 个工具注册 | `inputSchema: withContext(XxxSchema)` |
| `transports` Map / `SESSION_TTL` / `MAX_SESSIONS` / `releaseSession` / `cleanupSessions` | 整套删除 |
| `eventStore.ts`(浏览器包 + 数据库包各一份) | 删除 —— 新协议移除了断线重放 |
| `app.get('/mcp')` / `app.delete('/mcp')` | 删除 —— 旧协议的会话操作,新协议下返回 405 |
| DNS rebinding 防护 | 换成官方 `localhostHostValidation()` / `originValidation()` |

---

## 6. 阶段四:跨平台(Windows / Linux / macOS)🚧

**当前缺口**:`killPortProcess` 是**纯 Windows 实现**(`netstat -ano` + `taskkill /F /T`),
`if (process.platform === 'win32')` 之外什么都不做 → Linux/macOS 上端口被占时清不掉。

> ⚠️ **Windows 那份实现不许简化。** 原实现用 `netstat -ano | findstr :3211` —— `findstr` 是
> **子串匹配**,`:3211` 会命中 `:32110`,于是 `taskkill /F /T` 掉一个**完全无关**的进程连同整棵进程树。
> 现在是按列解析 + 三重校验(协议列以 TCP 开头 / 端口字段严格相等 / 状态为 LISTENING),
> 还处理了 IPv6 `[::1]:3215` 与非英文 Windows 的本地化表头。**只许抽到平台分支里,不许改逻辑。**

其余平台相关点(已有处理,重构时保留):
- 浏览器启动参数按平台分支(`browser.ts`)
- `mcp.mjs` 里 `npm`/`npx`/`pm2` 的 `.cmd` 后缀与 cmd.exe 引号处理
- 开机自启:Windows 走「启动」文件夹 + `pm2 resurrect`
- **有头浏览器不能注册成 Windows 系统服务** —— Session 0 里窗口不可见,人工接管就失去意义

---

## 7. 阶段五:elicitation(待做)

有头浏览器(3213)存在的唯一理由就是**让人工过验证码/登录**。现状:全仓 **0 处**使用,
撞到登录墙只能返回失败,靠 AI 在聊天里让用户去登录、登完再告诉 AI 继续。

新协议下用返回式写法:
```ts
return inputRequired({
  inputRequests: { login: inputRequired.elicit({
    message: '目标站点要求登录,请在已打开的浏览器窗口完成登录后确认',
    requestedSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'] },
  }) },
});
// 重入:const done = acceptedContent(ctx.mcpReq.inputResponses, 'login', SCHEMA)
```

---

## 8. 全机群推广

1. 合入默认分支前**先在本机灰度**:切服务、跑一天真实使用
2. 更新 `UPDATE-PROMPT.md`:v2 必须**重装 node_modules**,不能只 `git pull`
3. 通过 `panel-agent` 白名单更新推送
4. **回滚**:v1/v2 包名不同,`git revert` + `npm i` + `npm run build` 即可退回

⚠️ **推广前必须确认**:纯新协议后,**所有客户端都必须支持 `2026-07-28`**。
Claude Code 2.1.251 已实测通过;**Codex 仅有二进制强信号,未实连验证** —— 推广前务必补验。

---

## 9. 待拍板 / 未验证清单

| 项 | 状态 |
|---|---|
| Codex 实连纯新协议服务器 | **未验证**(仅二进制信号) |
| `mcp.mjs` 的 install/update 在 v2 + 纯新协议下是否正常 | **未验证** |
| `mcp-database` 包迁移后真实连库 | **未验证**(仅编译通过) |
| 有头浏览器(3213)在新架构下完整验证 | **未验证** |
| 进度通知在纯新协议(非旧线)下是否照常工作 | **未验证** |
| `@types/jsdom` 28 与 jsdom 29 版本错配 | 未处理 |

---

## 变更记录

- 2026-08-31 二版:**纠正初版的错误结论**(见 §1)。目标改为纯新协议 `2026-07-28`,不保留旧线。
  阶段一、二完成并实测;阶段三、四进行中。
- 2026-08-31 初版:阶段一完成。
