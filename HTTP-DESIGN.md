> ⚠️ **本文描述的是已被取代的旧架构,只作历史参考,别照着做。**
>
> 文中的会话隔离建立在 **HTTP 传输的 `Mcp-Session-Id`** 之上。协议 `2026-07-28` 移除了协议级 session,
> 现在的实现改为 **pipe 传输(named pipe / unix socket),一条 socket = 一个客户端窗口**,
> 由内核保证唯一性与生命周期,新旧协议下都成立。
>
> 另外**默认语义也变了**:浏览器标签页现在**默认共享**(文中写的是隔离),数据库仍默认隔离。
>
> 当前架构见 `claude/src/pipe.ts` 头部与 `MCP-V2-PLAN.md`;接入方式见 `UPDATE-PROMPT.md`。
> HTTP 腿本身**仍然保留**并可用 —— 跨机共享只有这条路(named pipe 只能本机用)。

---
# 全面适配 HTTP —— 设计方案 (v3.0.0)

> 目标:把浏览器 MCP 从「每个客户端窗口拉一个 stdio 进程」改造成「一个常驻 HTTP 服务,多客户端共享一个浏览器」。
> 现状代码已是双传输(stdio + Streamable HTTP),但 HTTP 路径从未真正投产,存在安全与并发缺陷。本方案对**会话/资源模型**做重构。

---

## 一、为什么要改(实测依据)

| 问题 | 实测数据 / 代码位置 |
|---|---|
| **资源浪费** | 单个 Claude Code 会话 = 1×`server.js` (157 MB) + 4×chromium (210 MB) = **366 MB**。stdio 模式每个窗口都在启动时预热浏览器(`server.ts` `runStdio()` 开头 `getContext()`)。本机实测同时存在过 **26 个** server 进程 |
| **登录态不共享 + profile 散落** | `browser.ts` 默认 `userDataDir: 'storage/user_data'` 是**相对路径**,按进程 CWD 解析。实测 profile 落在 `d:\code\egolite\storage\user_data` ——即当前项目目录。每个项目一份独立登录态,`storage/` 散落各处 |
| **升级运维重** | 升级要 kill 全部进程 + 每个窗口手动重连 |
| **HTTP 路径不安全** | `server.ts` 监听 `process.env['HOST'] ?? '0.0.0.0'`,CORS `Access-Control-Allow-Origin: *`,无鉴权、无 DNS rebinding 防护 → 局域网内任何人可控制**已登录的**浏览器 |
| **HTTP 路径会并发打架** | `BrowserManager` 是全局单例,`activeSpace` / `page` 全局唯一。多会话同连一个 HTTP 服务会抢同一个活跃页面 |

---

## 二、核心架构:三层资源模型

```
Chromium 进程 ×1                     ← 资源共享,替代原来的 N 份
└── BrowserContext = Space           ← 默认只有 "default";多账号隔离才新建
    │   (独立 userDataDir → 独立 cookie / 登录态)
    ├── Page ← Session A (窗口 1)     ← 每个 MCP 会话自动分到自己的标签页
    ├── Page ← Session B (窗口 2)
    └── Page ← Session C (Codex)
```

**两级隔离,各司其职:**

| 级别 | 粒度 | 触发方式 | 成本 | 用途 |
|---|---|---|---|---|
| **Session → Page** | 标签页 | **自动**(连上即分配) | 极低 | 多窗口并行互不干扰,**共享登录态** |
| **Space → Context** | 浏览器上下文 | **显式** `space_new` | 高(独立 Chromium 上下文) | 多账号 / 需要隔离 cookie 的场景 |

这解决了原本互相矛盾的两个目标:**省资源**(默认共享一个 Chromium 和一份登录态)与**不打架**(每会话独占标签页)。

---

## 三、关键技术设计

### 3.1 会话上下文传递:AsyncLocalStorage(零侵入)

痛点:44 个工具函数签名里都没有 `sessionId`,逐个改动太大且易错。

方案:用 Node 原生 `AsyncLocalStorage` 隐式携带,**工具函数签名一律不动**。

```ts
// src/context.ts (新增)
import { AsyncLocalStorage } from 'node:async_hooks';
export const mcpCtx = new AsyncLocalStorage<{ sessionId: string }>();
export const currentSessionId = () => mcpCtx.getStore()?.sessionId ?? '__stdio__';
```

注册工具时统一包一层(`server.ts` 里加一个高阶函数,44 处注册各套一次):

```ts
const wrap = <T extends Function>(fn: T): T =>
  ((...a: unknown[]) => mcpCtx.run({ sessionId }, () => fn(...a))) as unknown as T;

server.registerTool('navigate', {...}, wrap(async (args) => text(await tools.navigate(args))));
```

`BrowserManager.getPage()` 内部读 `currentSessionId()` 决定返回哪个 page。
**stdio 模式下 ALS 为空 → 回落 `__stdio__` 单会话行为,与现有完全一致(向后兼容)。**

> HTTP 模式下现有代码已经是「每个会话 `createMcpServer()` 一个独立实例」(`server.ts` 的 `isInit` 分支),所以 `sessionId` 直接用闭包捕获即可,连 `extra.sessionId` 都不必依赖。

### 3.2 BrowserManager 重构(本次改动最大的部分)

现状:`Space { context, page, consoleLogs, networkRequests }` —— 每个 space **单个** page。
改为:

```ts
interface Space {
  name: string; userDataDir: string;
  context: BrowserContext | null;
  sessions: Map<string, SessionState>;   // ← 新增:会话 → 自己的标签页集合
  chromiumPid: number | null;
}
interface SessionState {
  pages: Page[];          // 该会话拥有的标签页(支持 new_tab / switch_tab)
  activeIndex: number;
  consoleLogs: ConsoleLogEntry[];      // ← 日志/网络记录下沉到会话级
  networkRequests: NetworkRequestEntry[];
}
```

- `getPage()`:取当前会话的活跃 page;不存在则在其 space 的 context 里 `newPage()` 建一个。
- `sessionSpace: Map<sessionId, spaceName>`:`space_switch` 只影响**本会话**,不再是全局状态。
- console/network 缓冲从 space 级下沉到**会话级** —— 否则 A 窗口会看到 B 窗口的日志(现有 HTTP 路径的隐性 bug)。

### 3.3 多标签工具语义收敛

`list_tabs` / `new_tab` / `switch_tab` / `close_tab` 现在枚举的是 `context.pages()`(全 context)。多会话下必须**收敛到本会话自己的 pages**,否则 A 会列出并能关掉 B 的标签页。

### 3.4 会话生命周期与回收

- `onsessioninitialized(sid)` → 建会话状态(**懒建 page**,首次用到才开标签页,避免空连接白占资源)
- `onsessionclosed(sid)`(SDK 原生钩子,已确认存在)+ 现有 30 分钟 TTL 清理 → 关闭该会话所有 page、清缓冲
- 最后一个会话退出:**保留 context 不关**(热启动,下次连上秒开);可加 `IDLE_CLOSE_MS` 空闲超时兜底
- 保留现有 `process.on('exit')` SIGKILL chromium 的兜底,防孤儿

### 3.5 Profile 路径修复(stdio 模式也受益)

`browser.ts` 默认 `userDataDir` 改为**相对服务安装目录**解析,而非 `process.cwd()`:

```ts
const INSTALL_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..'); // dist/../
userDataDir: process.env['USER_DATA_DIR'] ?? path.join(INSTALL_ROOT, 'storage/user_data')
```

效果:登录态固定一份,不再随项目目录漂移,`storage/` 不再散落。**即使不切 HTTP 也应该改。**

### 3.6 数据库 MCP:同样切 HTTP,且必须做会话隔离(风险高于浏览器)

**现状缺陷(切 HTTP 前必须修,否则会出数据事故):**

| 问题 | 代码位置 | 后果 |
|---|---|---|
| `DatabaseManager` 全局单例,`currentType`/`currentConfig` 全局唯一 | `mcp-database/src/database.ts:11-16` | 窗口 A `switch_db('prod')` 后,窗口 B 以为在测试库执行 `execute()` → **写进生产库** |
| 查询缓存 key 为 `${sql}:${params}`,**不含库标识** | `mcp-database/src/database.ts:91` | 同一条 SELECT 在切库后 60s 内返回**上一个库的缓存结果**。此 bug **当前 stdio 下已存在**,共享后被放大 |

**设计(与浏览器复用同一套 ALS 机制):**

```
连接池注册表 Map<configKey, Pool>        ← 全服务共享(这才是连接池的意义)
会话指针     Map<sessionId, configKey>   ← 每个会话「当前指向哪个库」独立
```

- `connect` / `switch_db` / `disconnect`:**只改调用方会话自己的指针**,不影响其他会话
- 池按 `configKey`(host:port:db:user)复用;引用计数归零 + 空闲超时后关闭
- **缓存 key 加入 `configKey`**(顺手修掉上述既有 bug)
- 会话首次连接时套用 `.env` 默认库;`onsessionclosed` 释放该会话的池引用

**切 HTTP 的实际收益(此前低估了):** 当前 N 个 stdio 进程 = **最多 N 套独立连接池**同时打 Postgres/MySQL;合并为常驻服务后是**一套共享池**,连接数与握手开销大幅下降。

---

## 四、安全设计(HTTP 上线前必须做完)

| 项 | 现状 | 改为 |
|---|---|---|
| 监听地址 | `0.0.0.0`(`server.ts` runHttp) | **默认 `127.0.0.1`**,跨机共享需显式设 `HOST` |
| DNS rebinding | 无 | `enableDnsRebindingProtection: true` + `allowedHosts: ['127.0.0.1:<port>','localhost:<port>']`(SDK 原生,已确认支持) |
| CORS | `Access-Control-Allow-Origin: *` | 收紧到本地来源 / `allowedOrigins` |
| 鉴权 | 无 | 可选 `MCP_AUTH_TOKEN`,设了就校验 `Authorization: Bearer`。**跨机部署时强制** |
| 限流 | 已有 100 req/s per IP | 保留 |

> 这条最要紧:浏览器里存着**已登录的公司系统会话**,HTTP 端口等于把这些会话的控制权暴露出去。绑 127.0.0.1 是底线。

---

## 五、部署方案

| 服务 | 端口 | PM2 名 | 模式 |
|---|---|---|---|
| 无头浏览器 | 3215 | `claudemcp-headless` | **切 HTTP 常驻** |
| 有头浏览器 | 3213 | `claudemcp-browser` | **切 HTTP 常驻**(仓库既有 `ecosystem.config.cjs` 本就是这么设计的) |
| 数据库 | 3214 | `claudemcp-database` | **切 HTTP 常驻**(共享连接池;前提是先做完 §3.6 会话隔离) |

PM2 已安装(本机 7.0.1)。

**有头模式的唯一约束:进程必须跑在「已登录的交互桌面会话」里,窗口才可见。这取决于自启方式,与 HTTP 无关:**

| 自启方式 | 窗口可见 |
|---|---|
| 终端 `pm2 start` / `node mcp.mjs start` | ✅ |
| 用户级自启(启动文件夹 / 任务计划程序「**只在用户登录时运行**」)+ `pm2 save` | ✅ |
| 注册为 Windows **系统服务**(「不管用户是否登录都运行」) | ❌ Session 0,窗口不可见 |

→ **只要不选最后一种即可。** 若该机器将来要纯远程无桌面运行,再把有头退回 stdio 或改无头。

**有头切 HTTP 的额外收益(比无头更大):**
- 现状 stdio:每个客户端窗口弹一个独立浏览器窗口,N 个窗口满屏
- 切换后:**一个可见浏览器**,各会话占各自标签页;可实时观察 agent 操作,并随时**人工接管**(登录、验证码、二次确认)
- 即 ego-lite 主打的「人与 agent 在同一浏览器内并行工作」模型,在现有架构上即可实现

客户端注册从 stdio 改为:
```jsonc
"browser": { "command": "node", "args": ["<仓库路径>/claude/bin/shim.mjs", "headless"] },
```

---

## 六、风险与回滚

| 风险 | 缓解 |
|---|---|
| 服务挂掉 → 所有窗口浏览器工具全废(stdio 不会有此问题) | PM2 `autorestart` + 开机自启;保留 stdio 配置随时切回 |
| 一个会话把浏览器搞崩,影响所有人 | 现有 `page.on('crash')` 重建;context 级崩溃触发整体重启 |
| 多会话共享登录态 = 一个窗口登出影响所有窗口 | 需要隔离的场景用 `space_new`(这正是 Task Spaces 的用途) |
| 重构引入回归 | 双传输并存,stdio 路径保持不变;冒烟脚本对**两种传输**各跑一遍 |

**回滚**:客户端配置改回 stdio 即可,代码无需回退(双模式并存)。

---

## 七、实施阶段

| 阶段 | 内容 | 风险 |
|---|---|---|
| **P0** | Profile 路径修复(§3.5) | 极低,stdio 也受益,可独立上线 |
| **P1** | 安全加固(§四):绑 127.0.0.1 + DNS rebinding + CORS + 可选 token | 低 |
| **P2** | 浏览器会话模型重构(§3.1–3.4):ALS + 每会话 page + 标签工具收敛 + 日志下沉 | **中,本次核心** |
| **P2.5** | 数据库会话隔离(§3.6):共享池 + 每会话指针 + 缓存 key 修复 | **中,数据安全相关** |
| **P3** | PM2 部署(有头 3213 / 无头 3215 / 数据库 3214)+ 冒烟(stdio & HTTP 双跑)+ 客户端切换 | 中 |
| **P4** | 观察一周 → 是否推广到团队(ankottipublic `mcp/servers.json` 需支持 http 型 + setup 时拉起服务) | — |

---

## 八、终局路线图与「现在就必须定」的架构决策

终局:**跨机器共享 + Windows/macOS/Linux 全平台 + 全团队推广**。V1 只做本机,但以下几点若不在 V1 就留好口子,后期必然返工。

### 8.1 鉴权:V1 就内置,只是默认不开

跨机是既定终局,**鉴权不能等到那时再加**(retrofit 鉴权要动全部路由与客户端配置)。

- V1 实现 `MCP_AUTH_TOKEN`:未设置 = 不校验(本机 loopback 场景)
- **绑定非 loopback 地址时强制要求 token**,否则拒绝启动(fail-fast,防止误开裸端口)
- 校验 `Authorization: Bearer <token>`,与现有限流叠加

### 8.2 身份 → Space 映射(跨机多用户的关键)

多人共享一个服务时,**登录态绝不能串**——A 的公司系统 cookie 不能被 B 用到。因此 space 分配策略必须可插拔:

| 场景 | 策略 | 效果 |
|---|---|---|
| V1 本机单人 | 所有会话 → `default` space | 共享登录态(**这正是本机想要的**) |
| 终局跨机多人 | token/身份 → **每身份独立 space** | 每人独立 profile,cookie 不互串 |

实现:`resolveSpace(sessionId, identity)` 单一函数决定映射,V1 恒返回 `default`;多用户时按身份返回。**架构上预留这一层,V1 不实现多用户逻辑。**

### 8.3 跨平台约束

| 平台 | 无头 | 有头 | 自启方式 |
|---|---|---|---|
| Windows | ✅ | ✅(须用户级自启,非系统服务) | 启动文件夹 / 任务计划「只在用户登录时运行」 |
| macOS | ✅ | ✅ | `pm2 startup` (launchd) |
| Linux 桌面 | ✅ | ✅ | `pm2 startup` (systemd) |
| Linux 服务器(无显示) | ✅ | ❌ 需 Xvfb,否则只能无头 | systemd |

- 路径处理一律 `path` 模块 + 相对**安装目录**(§3.5),不依赖 CWD
- 有头服务在无显示环境应**自动降级为无头并告警**,而不是启动失败
- 现有 `browser.ts` 已有 `IS_WIN/IS_MAC/IS_LINUX` 分支(启动参数),保持不动

### 8.4 团队推广所需(V1 不做,但不能挡路)

- `ankottipublic` 的 `mcp/servers.json` 需支持 **http 型条目**(带 `url`,而非 `command/args`)
- `setup-mcp.mjs` 需增加:装依赖 → 构建 → **拉起 PM2 服务** → 注册 http 端点 → 配置自启
- 服务不可达时的兜底:客户端注册保留 stdio 备用条目,或 setup 脚本做健康检查后自动拉起
- 版本对齐:沿用现有 `prompts/version-align-notice.md` 流程

---

## 九、待拍板

1. ~~有头浏览器是否切 HTTP~~ → **已定:一起切**(用户级自启即可保证窗口可见,收益比无头更大)
2. ~~访问范围~~ → **已定:V1 只本机 127.0.0.1**;鉴权代码 V1 内置但默认不开(§8.1),跨机为终局
3. ~~团队推广~~ → **已定:V1 先本机跑通**,团队推广为终局(§8.4),V1 不实现但不挡路
4. ~~数据库 MCP 是否切 HTTP~~ → **已定:一起切**,但必须先完成 §3.6 会话隔离,否则会出跨窗口写错库的数据事故
5. **开机自启**:现在就配用户级自启(`pm2 save` + 启动项),还是先手动 `pm2 start` 跑一阵观察?
