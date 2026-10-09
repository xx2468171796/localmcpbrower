# Local MCP Browser

为 Claude Code / Codex 等 MCP 客户端提供**本地浏览器操控**能力的 MCP 服务。基于 Patchright（Playwright 反检测分支）+ MCP SDK，让 AI 可以直接驱动本地浏览器。

> 数据库 MCP 已于 2026-09-25 撤下，库一律用堡垒机 baolei MCP 的 `db_*` 工具（历史版本见 git 历史）。

## 特性

- **浏览器 MCP（47 个工具）** —— Patchright 1.63 驱动（自带反检测，Chromium 153）+ MCP SDK 2.x，支持导航、点击、填表、截图、无障碍快照（snapshot+ref 操作）、正文提取（defuddle 转 Markdown）、站点 URL 发现、批量爬取、网络拦截、PDF 导出等。
- **对齐 ego-lite 的三件套** —— ① `run_script` 一次跑完：脚本内直接用 `__ego.click/fill/waitFor/snapshot`，把「填表→点击→等待→读结果」压成单次 MCP 往返，省 token 省延迟；② `snapshot` 与 `click/type/hover` **穿透 iframe(含跨域)**,iframe 内元素同样带 ref、可直接操作;③ **Task Spaces**:`space_new/switch/list/close` 开并行隔离工作区,各自独立 cookie/登录态,适合多任务或多账号。
- **HTTP 常驻形态（推荐）** —— 两个长驻服务，同一个服务的所有客户端窗口共用：一份 Chromium、一份登录态，替代过去「每个窗口各拉一个进程 + 各开一个浏览器」。有头模式下窗口可见，可实时观察 agent 操作并随时**人工接管**（登录 / 验证码 / 二次确认）。
- **会话隔离** —— 每个客户端会话自动分到**自己的标签页**：A 窗口的标签页工具只看得到自己的标签页，console / 网络记录与 `set_block_rules` 的拦截规则同样按会话隔离；**cookie / 登录态则是同一个 space 内共享**（这是省资源的设计意图），需要独立登录态时用 `space_new` 开隔离工作区。注意有头（3213）与无头（3215）是两个进程、两份 profile，**登录态不互通**。
- **安全默认值** —— 两个服务默认只绑 `127.0.0.1`，带 DNS rebinding 防护与限流；跨机共享须显式改 `HOST` + 设 `MCP_AUTH_TOKEN` + 把客户端用的 `host:port` 加进 `MCP_ALLOWED_HOSTS`（未设 token 就绑非回环地址会直接拒绝启动；漏 `MCP_ALLOWED_HOSTS` 则一律 403）。
- **双传输并存** —— HTTP（Streamable HTTP）为推荐形态；**stdio 原生模式**保留为备用，行为与旧版完全一致，客户端改个配置即可回退。
- **跨平台** —— Windows / macOS / Linux 通用，端口一致，单入口 `node mcp.mjs <cmd>`；开机自启一条 `node mcp.mjs autostart` 覆盖三平台。
- **进程安全** —— stdio 模式多重退出兜底（信号 / stdin / ppid 轮询 / exit 钩子），SSH 断开不留孤儿 Chromium。
- **服务级 instructions** —— MCP 在 initialize 时下发使用说明，支持的客户端（Claude Code / Codex 等）会自动注入 AI 上下文，AI 无需读文档即知工具的正确配合方式。
- **国内网络适配** —— `install` / `update` 自动探测 npm 官方源，不可达时自动切换 npmmirror 镜像（含 Chromium 二进制下载），也可用 `NPM_REGISTRY` 环境变量显式指定源。

## 系统要求

- Node.js >= 24
- Windows 10+ / macOS 10.15+ / Linux
- PM2（HTTP 常驻模式；只用 stdio 可不装）

## 服务与端点

| 服务 | 端口 | PM2 名 | 端点 | 浏览器 profile | 适用 |
|------|------|--------|------|----------------|------|
| 有头浏览器 | 3213 | `claudemcp-browser` | `http://127.0.0.1:3213/mcp` | `claude/storage/user_data_headed` | 桌面：窗口可见、可人工接管 |
| 无头浏览器 | 3215 | `claudemcp-headless` | `http://127.0.0.1:3215/mcp` | `claude/storage/user_data` | 服务器 / 后台 |

> 两个浏览器服务的 profile 必须分开：同一目录被两个 Chromium 同时打开时，磁盘上的 Cookies
> 由最后落盘的那个覆盖，另一边的登录态会静默丢失。代价是两个服务各有一份独立登录态 ——
> 想让所有窗口共用一份，就只跑其中一个（桌面机推荐只跑有头）。

## 快速开始

```bash
cd claude

# 1. 安装（跨平台 Node CLI）
node mcp.mjs install

# 2. 启动两个常驻服务（自动做端点健康检查）
node mcp.mjs start

# 3. 打印并执行客户端注册命令
node mcp.mjs config

# 4. 可选：配置开机自启（三平台指引，--apply 落地）
node mcp.mjs autostart
```

注册后形如：

```bash
claude mcp add browser -s user -- node <仓库路径>/claude/bin/shim.mjs headless
claude mcp add browser-headed -s user -- node <仓库路径>/claude/bin/shim.mjs headed
```

> 不想跑常驻服务？`node mcp.mjs config` 的「方式 B」是 stdio 备用路径，行为与旧版一致。

## 日常更新

仓库有新版本时，一条命令完成升级（拉代码 + 重装依赖 + 校验浏览器 + 重新构建 + 重启在跑的 PM2 服务）：

```bash
node claude/mcp.mjs update
```

HTTP 模式在 Claude Code 里 `/mcp` 重连即可生效；stdio 模式下次会话自动生效。对 AI 说"更新本地 MCP"即可触发。

## 考卷（自动评测）与工具调用遥测

- **考卷**：`pnpm eval`（或 `npm run eval`，在仓库根目录或 `claude/` 下都行）跑 50 道固定题，全部打本地测试页、不连外网：
  导航、snapshot ref、点击 / 输入 / 填表、iframe（含跨站）、上传 / 下载 / 截图 / PDF、batch_fetch、crawl_pages 翻页、
  extract_article、run_script（`__ego`）、wait_for_selector、工作区隔离、标签页等。每题核对页面上的真实效果，
  记成功率、耗时、输出字节（token 的代理）和工具报错，写 `claude/eval/results.json`，和 `claude/eval/baseline.json` 比：
  基线通过的题失败、通过率低 5 个百分点以上、工具报错率高 3 个百分点以上 → 不放行（退出码非 0）。
  被测服务起在空闲端口、临时 profile、独立管道名，跑完清干净，**不碰本机 PM2 的 3213 / 3215 和你的登录态**。
- **真实站点冒烟**：`pnpm eval:smoke`，8 个外站，只当参考、不计入放行（公司网络下国外站点可能连不上）。
- **考卷属于裁判层**：`claude/eval/**`、`.ankotti/evolve.json` 只有人能改；更新基线 `npm run eval:baseline` 也只由人做。
  见 `.ankotti/evolve.json` 与堡垒机仓库 `docs/research/2026-10-self-evolving-projects.md` 6.1。
- **遥测**：每次工具调用记 `{tool, ok, ms, bytes, truncated}`，攒批异步发到堡垒机（只有工具名和数字，不带参数、网址、页面内容；
  发不出去不影响工具）。本机配了 baolei MCP 密钥时默认开，`BROWSER_TELEMETRY=0` 关；上报地址和格式见 `claude/src/telemetry.ts` 头部。

## 文档

- [`UPDATE-PROMPT.md`](./UPDATE-PROMPT.md) —— **发给其他机器的升级提示词**（整段贴给那台机器的 AI，它自己从 Gitea 拉取并全自主装好）
- [`AI-DEPLOY.md`](./AI-DEPLOY.md) —— **给 AI 助手的部署 Runbook**（可直接执行的命令序列 + 每步自检 + 不可违背的约束）
- [`DEPLOY.md`](./DEPLOY.md) —— **新机器 / 多机部署指南**（含三平台开机自启、安全默认值、排障）
- [`claude/README.md`](./claude/README.md) —— 完整安装、配置与用法
- [`CODEX.md`](./CODEX.md) —— Codex CLI 全局 MCP 注册、调用与排障
- [`USAGE.md`](./USAGE.md) —— 工具调用规则（给 AI 看的手册）
