# MCP SDK v2 迁移记录与待办

> 状态:**已上线并在本机日常使用**(2026-08-31)。分支已并入 master。
> 本文所有结论都标了验证方式;没实测的一律写「未验证」。
> 面向:维护这个仓的人,以及其它机器上照着升级的 AI。

---

## 0. 现在是什么状态

| 项 | 状态 |
|---|---|
| SDK | **纯 v2.0.0**,v1 零残留(源码 / lock / node_modules) |
| 协议(日常实际) | **`2025-11-25`** —— 客户端在 stdio 上不探测新协议 |
| 协议(服务端能力) | 新旧双线都支持,客户端钉死 `2026-07-28` 也能连(实测) |
| 传输 | pipe(named pipe / unix socket)+ HTTP 并存 |
| 工具数 | **46**(原 44 + `request_human` + `wait_for_human`) |
| 三个服务 | headless 3215 / headed 3213 / database 3214,均已切新版 |

⚠️ **别把"服务端支持新协议"说成"在用新协议"。** 实测:默认连接协商到
`2025-11-25`;只有显式 `versionNegotiation: { pin: '2026-07-28' }` 才走新线。

---

## 1. 待办(按可动工条件排序)

### 1.1 Tasks —— **阻塞中,触发条件明确**

**触发条件:SDK v2 出服务端 task API。** 在那之前不要动手。

现状(2026-08-31 核实):

| 包 | task 相关导出 |
|---|---|
| `core` | 只有 17 个 **Schema**(线路格式定义) |
| `server` | 只有 `RELATED_TASK_META_KEY`、`isTaskAugmentedRequestParams` |
| `client` | 同上 |

**没有** `createTask`、没有 task store、`ServerOptions` 里没有 tasks 配置。
`TaskMetadata` 类型上直接标着 `@deprecated … **with no SDK runtime**;
kept importable for interoperability only`;
类型注释里另写明 `execution.taskSupport` / `capabilities.tasks` 属于 2026 wire 的
**已删除字段集** —— 2025 那套 task 词汇在新协议里被删了,新的还没落到 SDK。

现在做等于**手搓一套只有我们自己遵守的实现**(自管生命周期、自己响应
`tasks/get|result|list`、自己发 `notifications/tasks/status`),
官方支持一出来大概率推翻重写,且没有第二个实现能与之互操作。

**价值**:长任务(`crawl_pages` 最多 50 页 / `batch_fetch` / `discover_urls`)
脱离连接、断线可恢复、随时查进度。目前已有的**进度通知**覆盖了大部分体感,
缺的是"断了还能捡回来"。

**怎么判断可以动工**:
```bash
node --input-type=module -e 'import * as s from "@modelcontextprotocol/server";
  console.log(Object.keys(s).filter(x=>/task/i.test(x)).join(", "))'
# 出现 createTask / TaskStore / 类似的**运行时** API,而不只是那两个常量,才算可做
```

### 1.2 订阅流 / cache hints —— 同上

`ServerOptions` 里同样没有对应服务端配置。等 SDK。

### 1.3 其它

| 项 | 说明 |
|---|---|
| macOS 实机验证 | 跨平台代码的解析层用真实 Linux 输出验过,**macOS 无实机**;`npm run test:smoke` 可在 Mac 上直接复验 |
| kill 路径实机验证 | 只验了"找谁在监听"这一半;kill 分支未在真实系统执行过(验证机跑着在用的服务) |
| 其它机器推广 | `UPDATE-PROMPT.md` 需更新:v2 **必须重装 node_modules**,不能只 `git pull` |
| `@types/jsdom` | 28 与 jsdom 29 版本错配,未处理 |
| HTTP 腿是否保留 | **建议保留**:named pipe 只能本机用,跨机共享(`HOST` + `MCP_AUTH_TOKEN`)只有 HTTP 这一条路,而"跨机是既定终局"写在 server.ts 里 |

---

## 2. 这次实际拿到了什么

### 2.1 修好了三个一直存在、但没人发现的缺陷

| 缺陷 | 影响 |
|---|---|
| **反爬指纹伪装整段从未执行** | `navigator.webdriver` 直接暴露、`window.chrome` 不存在、plugins 为空 —— 爬公网基本被当机器人。**不是本次迁移引入的,一直如此** |
| **`get_console_logs` 恒返回空** | 同一根因(注入通道失效) |
| **`snapshot` 的 `deep:true` 静默 no-op** | 与 `deep:false` 输出逐字节相同,调用方以为"这页确实没有隐藏可点元素"。⚠️ **功能没恢复**,改为如实报不可用 |

根因都在 patchright 1.62.2 下 `addInitScript` **不执行**。四条通道逐条实测,
只有「route 拦 HTML 响应注 `<script>`」可用。详见 `claude/src/inject.ts`。

### 2.2 补上了本来就该有、却一处没用的能力

- **长任务进度通知**(`crawl_pages` / `batch_fetch`)—— 2025 线就支持,原来全仓 0 处使用
- **参数校验失败返回 `isError`** —— v2 自带,符合 2026-07-28 规范

### 2.3 跨平台

`killPortProcess` 原本是纯 Windows 实现,Linux/macOS 上端口被占时清不掉。
现三平台各有实现 + 4 个可测的纯解析函数。Windows 那份**逐字节保留**
(它挡着一次真实事故:`findstr :3211` 子串匹配会误杀 `:32110` 的无关进程)。

### 2.4 数据库只读护栏(2026-08-31 实测发现,修前可真实写库)

`query` / `export_csv` / `explain_query` 都标 `readOnlyHint:true` → 宿主不弹确认 →
判错就是**静默写库**。原判断只看开头一个词,两条绕过实测有效:

| 绕过写法 | 为什么能过 | 实测结果 |
|---|---|---|
| `SELECT 1; CREATE TEMP TABLE t(x int); INSERT INTO t VALUES (42)` | 开头是 SELECT | pg 简单查询协议**逐条执行**,42 能读回来 |
| `WITH x AS (INSERT … RETURNING 1) SELECT * FROM x` | 开头是 WITH | 语句真去执行了(仅因表不存在而报错) |
| 同上交给 `explain_query` | 被判只读 → 加 `ANALYZE` | **`EXPLAIN ANALYZE` 会真正执行**,等于分析着把数据删了 |

现在三层:① `stripSqlNoise` 剥字符串/注释/美元引用再判断(避免 `SELECT 'delete'` 误杀)
② 拒多语句 + 全文查写关键字(含 `into`,`SELECT … INTO 新表` 在 PG 里是建表)
③ **引擎级只读事务兜底** `BEGIN READ ONLY` / `START TRANSACTION READ ONLY` —— 这层不依赖
"我们把所有花样都想全了",实测 `SHOW transaction_read_only` = `on`。

回归用例:`claude/test/smoke-database.mjs`,**别删**。

### 2.5 人工接管

- `wait_for_human`:**不弹窗**,盯页面变化(URL 变 / 元素出现 / 元素消失)。
  在 `bypassPermissions` 下**照常工作**
- `request_human`:走 elicitation。⚠️ 实测 `bypassPermissions` 下会被客户端
  **自动 decline 且界面无任何提示**,故本机不可用;保留供其它客户端/权限模式使用

### 2.6 架构

会话身份从"协议 session"换成"OS socket",为 2026-07-28 删除协议级 session 做好了准备,
且**新旧协议下都成立**。浏览器默认共享、数据库默认隔离(`switch_db` 串台会写错库)。

---

## 3. 踩过的坑(重写时别再犯)

1. **`page.evaluate` 跑在隔离世界** —— 判断"注入脚本有没有执行"必须走 DOM(跨世界共享),
   用 `page.evaluate` 读主世界的 `window.X` 会把"执行了"误判成"没执行"。
2. **测协议协商不能用手搓的半成品服务器** —— 半成品不应答 `server/discover`,
   客户端超时回落旧协议,会被误读成"客户端不支持新协议"。要用官方 SDK 起真服务器。
3. **同一客户端在不同传输上协议行为不同** —— Claude Code 走 HTTP 会探测新协议,
   走 stdio 不探测。HTTP 上验过的结论不能套到 stdio。
4. **共享会话 id 必须带代际** —— `BrowserManager` 回收时会立墓碑防止在途调用复活会话;
   固定 id 会导致"最后一个窗口关闭后永远连不上"。
5. **elicitation 的"没问过"和"被拒绝"必须分开** —— 混为一谈会无限重问,
   撞 `maxRounds`(8)后报一个用户看不懂的错。
6. **数据库包有独立 tsconfig**,主包 `npm run build` **不会**带上它,切版本要分别构建。
7. **v2 里报「`ZodObject` 不能赋给 `ZodRawShape`」时,先查 `outputSchema`** ——
   真凶多半是它不是 Standard Schema,导致现代重载匹配失败、TS 回退后报出指向反了的错。

---

## 变更记录

- 2026-08-31:v2 迁移完成并上线;修复三个既有缺陷;补进度通知、跨平台、人工接管;
  会话身份改为 socket。Tasks 因 SDK 缺服务端 API 转入待办。
- 2026-08-31(同日,全量实测):61 个工具逐个真调一遍(浏览器 46 + 数据库 15),
  发现并修掉**数据库只读护栏可被绕过**(见 2.4)。新增 `test/smoke-browser.mjs` /
  `test/smoke-database.mjs` 两个冒烟测试并挂到 npm scripts,把这次的用例固化成回归。
  另实测确认:杀掉浏览器进程后下次调用自动重开,且**重开后注入与屏蔽规则都还在**;
  服务重启后 shim 自动重连;浏览器共享 / 数据库隔离与文档描述一致。
