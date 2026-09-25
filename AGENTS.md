# AI 工作指引(Claude Code / Codex 通用)

本仓提供一个本地 MCP:**浏览器操控**。

> 数据库 MCP 已于 2026-09-25 撤下,库一律用堡垒机 baolei MCP 的 `db_*`(历史版本见 git 历史)。

> 这份是**索引**,别一上来通读全部文档(共 100KB+)。按下表只读需要的那份。

| 你要做什么 | 读哪份 |
|---|---|
| 在**别的机器**上安装/升级 | **`UPDATE-PROMPT.md`** —— 唯一权威,整段贴给那台机的 AI 即可 |
| 部署时逐步执行 + 故障处置 | `AI-DEPLOY.md` |
| 了解工具怎么配合用 | `USAGE.md` |
| 了解协议/架构为什么这么设计、踩过哪些坑 | **`MCP-V2-PLAN.md`**(含七条踩坑清单) |
| **验证本机装得对不对** | 跑 `npm run test:smoke`(浏览器 46 工具) |
| Codex 专属配置与排错 | `CODEX.md` |
| ~~`HTTP-DESIGN.md`~~ | 描述的是**已被 pipe 取代**的旧会话架构,只作历史参考 |

## 当前形态(2026-09-25)

- **MCP SDK v2**,v1 已完全移除。服务端新旧协议双线都支持;
  **日常实际走 `2025-11-25`** —— 客户端在 stdio 上不探测新协议,客户端升级后会自动走新的
- 两个常驻服务(PM2):`claudemcp-headless` 3215 / `claudemcp-browser`(有头)3213
- 客户端经 **`bin/shim.mjs`** 以 stdio 接入,shim 把字节转发到常驻进程的 named pipe / unix socket。
  **一条 socket = 一个客户端窗口**
- 工具数:浏览器 **46**

## 会话语义(容易搞错,先看清)

| | 行为 | 切换 |
|---|---|---|
| **登录态 / cookie** | **始终共享**,与下面开关无关 | — |
| **浏览器标签页** | **默认共享** —— 任何窗口都能接管别的窗口开的页 | `PIPE_ISOLATED=1` 切隔离 |

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
3. **别把 pipe 腿的 `legacy` 改成 `'reject'`** —— 客户端在 stdio 上不探测新协议,改了全部连不上。
4. **共享会话 id 必须带代际** —— `BrowserManager` 回收时会立墓碑,固定 id 会导致
   "最后一个窗口关掉后永远连不上"。
5. **v2 里报「`ZodObject` 不能赋给 `ZodRawShape`」时先查 `outputSchema`** —— 真凶多半是它,
   报错指向反了。

更完整的踩坑清单见 `MCP-V2-PLAN.md` 第 3 节。

## 开发约束

- **stdio 一等公民**:不依赖 PM2 或端口也要能跑(`node dist/server.js --stdio`)
- HTTP 腿保留:**跨机共享只有这条路**(named pipe 只能本机用)
- 不提交 `.env` 与任何凭据(本仓 push 后会**强制镜像到 GitHub 私有仓**;私有归私有,
  但 Git 历史永久留存、仓库可见性又随时可能改,凭据一旦进去就很难真正清掉)
- 改了工具行为 → 更新 `USAGE.md`;改了安装/配置行为 → 更新 `UPDATE-PROMPT.md` 与 `mcp.mjs config`
- 改完 TypeScript 记得在 `claude/` 下构建,然后跑 `npm run test:smoke`

## 更新本机 MCP

用户说"更新本地 MCP"时:

```bash
node claude/mcp.mjs update
```

它会 `git pull --ff-only`、重装依赖、校验 Chromium、重建 `dist/`、重启在跑的 PM2 服务。
工作区有未提交改动会安全中止 —— 让用户先提交或 stash。
完事提醒用户:Claude Code 输入 `/mcp` 重连,Codex 重启。

⚠️ 从 **v1 升到 v2** 时 `mcp.mjs update` 不够,必须先 `rm -rf node_modules package-lock.json`
再装 —— 包名整个换了,旧目录会让构建拿到过期依赖。详见 `UPDATE-PROMPT.md`。
