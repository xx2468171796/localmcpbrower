# AI 工作指引(Claude Code / Codex 通用)

本仓提供两个本地 MCP:**浏览器操控**与**数据库访问**。

> 这份是**索引**,别一上来通读全部文档(共 100KB+)。按下表只读需要的那份。

| 你要做什么 | 读哪份 |
|---|---|
| 在**别的机器**上安装/升级 | **`UPDATE-PROMPT.md`** —— 唯一权威,整段贴给那台机的 AI 即可 |
| 部署时逐步执行 + 故障处置 | `AI-DEPLOY.md` |
| 了解工具怎么配合用 | `USAGE.md` |
| 了解协议/架构为什么这么设计、踩过哪些坑 | **`MCP-V2-PLAN.md`**(含七条踩坑清单) |
| **验证本机装得对不对** | 跑 `npm run test:smoke`(浏览器 46 工具)+ `npm run test:smoke:db`(数据库 15 工具) |
| Codex 专属配置与排错 | `CODEX.md` |
| ~~`HTTP-DESIGN.md`~~ | 描述的是**已被 pipe 取代**的旧会话架构,只作历史参考 |

## 当前形态(2026-08-31)

- **MCP SDK v2**,v1 已完全移除。服务端新旧协议双线都支持;
  **日常实际走 `2025-11-25`** —— 客户端在 stdio 上不探测新协议,客户端升级后会自动走新的
- 三个常驻服务(PM2):`claudemcp-headless` 3215 / `claudemcp-browser`(有头)3213 / `claudemcp-database` 3214
- 客户端经 **`bin/shim.mjs`** 以 stdio 接入,shim 把字节转发到常驻进程的 named pipe / unix socket。
  **一条 socket = 一个客户端窗口**
- 工具数:浏览器 **46**、数据库 **15**

## 会话语义(容易搞错,先看清)

| | 行为 | 切换 |
|---|---|---|
| **登录态 / cookie** | **始终共享**,与下面两个开关无关 | — |
| **浏览器标签页** | **默认共享** —— 任何窗口都能接管别的窗口开的页 | `PIPE_ISOLATED=1` 切隔离 |
| **数据库当前库指针** | **默认隔离** | `PIPE_SHARED=1` 切共享(慎用) |

数据库跟浏览器**故意不一致**:共享的话 B 窗口一句 `switch_db('prod')` 会让 A 窗口后续 SQL
全跑到生产库上 —— 浏览器串台最多拿错数据,**数据库串台可能写错库**。

## 客户端注册

```bash
node claude/mcp.mjs config     # 打印适配本机的注册命令(含绝对路径),照它执行
```

Codex 写 `~/.codex/config.toml` 时,Windows 路径**必须用 TOML 字面量字符串(单引号)**:
双引号会把 `"D:\nodejs\node.exe"` 里的 `\n` 当成换行,路径直接废掉。

## 改代码前必须知道的

1. **`page.evaluate` 跑在隔离世界。** 判断注入脚本有没有执行**必须走 DOM**(跨世界共享),
   用 `page.evaluate` 读主世界的 `window.X` 会把"执行了"误判成"没执行"。
2. **`addInitScript` 在 patchright 1.62.2 下不执行**(context 级和 page 级都不执行,
   CDP `addScriptToEvaluateOnNewDocument` 也不执行)。唯一可用通道是 route 拦 HTML 注 `<script>`,
   见 `claude/src/inject.ts`。
3. **数据库包有独立 `tsconfig`**,主包 `npm run build` **不带它**,必须分别构建。
4. **别把 pipe 腿的 `legacy` 改成 `'reject'`** —— 客户端在 stdio 上不探测新协议,改了全部连不上。
5. **共享会话 id 必须带代际** —— `BrowserManager` 回收时会立墓碑,固定 id 会导致
   "最后一个窗口关掉后永远连不上"。
6. **v2 里报「`ZodObject` 不能赋给 `ZodRawShape`」时先查 `outputSchema`** —— 真凶多半是它,
   报错指向反了。
7. **数据库只读护栏不能只看语句开头。** `query` / `export_csv` / `explain_query` 都标着
   `readOnlyHint:true`,宿主据此**不弹确认**,所以判错 = 静默写库。两种绕过实测有效过:
   分号多语句(`SELECT 1; INSERT …`,pg 简单查询协议逐条执行)和可写 CTE
   (`WITH x AS (INSERT …) SELECT …`,以 WITH 开头)。现在的做法是**引擎级只读事务兜底**
   (`BEGIN READ ONLY`)+ 文本层拒多语句/查写关键字。回归用例在 `test/smoke-database.mjs`,别删。

更完整的踩坑清单见 `MCP-V2-PLAN.md` 第 3 节。

## 开发约束

- **stdio 一等公民**:不依赖 PM2 或端口也要能跑(`node dist/server.js --stdio`)
- HTTP 腿保留:**跨机共享只有这条路**(named pipe 只能本机用)
- 不提交 `.env` 与任何凭据(本仓 push 后会**强制镜像到 GitHub 私有仓**;私有归私有,
  但 Git 历史永久留存、仓库可见性又随时可能改,凭据一旦进去就很难真正清掉)
- 改了工具行为 → 更新 `USAGE.md`;改了安装/配置行为 → 更新 `UPDATE-PROMPT.md` 与 `mcp.mjs config`
- 改完 TypeScript 记得在 `claude/` 下构建(**两个包**),然后跑 `npm run test:smoke` + `test:smoke:db`
- 测试脚本里**不许出现凭据**,数据库测试的连接信息一律走 `.env` 预设(理由同上)

## 更新本机 MCP

用户说"更新本地 MCP"时:

```bash
node claude/mcp.mjs update
```

它会 `git pull --ff-only`、重装两个包的依赖、校验 Chromium、重建 `dist/`、重启在跑的 PM2 服务。
工作区有未提交改动会安全中止 —— 让用户先提交或 stash。
完事提醒用户:Claude Code 输入 `/mcp` 重连,Codex 重启。

⚠️ 从 **v1 升到 v2** 时 `mcp.mjs update` 不够,必须先 `rm -rf node_modules package-lock.json`
再装 —— 包名整个换了,旧目录会让构建拿到过期依赖。详见 `UPDATE-PROMPT.md`。
