# Local MCP Browser

为 Claude Code / Codex 等 MCP 客户端提供**本地浏览器操控**和**数据库操作**能力的 MCP 服务。基于 Patchright（Playwright 反检测分支）+ MCP SDK，让 AI 可以直接驱动本地浏览器并访问数据库。

## 特性

- **浏览器 MCP（44 个工具）** —— Patchright 1.61 驱动（自带反检测，Chromium 149），支持导航、点击、填表、截图、无障碍快照（snapshot+ref 操作）、正文提取（defuddle 转 Markdown）、站点 URL 发现、批量爬取、网络拦截、PDF 导出等。
- **对齐 ego-lite 的三件套** —— ① `run_script` 一次跑完：脚本内直接用 `__ego.click/fill/waitFor/snapshot`，把「填表→点击→等待→读结果」压成单次 MCP 往返，省 token 省延迟；② `snapshot` 与 `click/type/hover` **穿透 iframe（含跨域）**，iframe 内元素同样带 ref、可直接操作；③ **Task Spaces**：`space_new/switch/list/close` 开并行隔离工作区，各自独立 cookie/登录态，适合多任务或多账号。
- **数据库 MCP（15 个工具）** —— PostgreSQL / MySQL 查询、表结构查看、索引分析、CSV 导出、多数据库预设切换；`query` 强制只读，写操作必须走 `execute`。
- **HTTP 常驻形态（推荐）** —— 三个长驻服务，同一个服务的所有客户端窗口共用：一份 Chromium、一份登录态、一套数据库连接池，替代过去「每个窗口各拉一个进程 + 各开一个浏览器」。有头模式下窗口可见，可实时观察 agent 操作并随时**人工接管**（登录 / 验证码 / 二次确认）。
- **会话隔离** —— 每个客户端会话自动分到**自己的标签页**和**自己的数据库指针**：A 窗口 `switch_db('prod')` 不会把 B 窗口带过去，标签页工具也只看得到自己的标签页，console / 网络记录与 `set_block_rules` 的拦截规则同样按会话隔离；**cookie / 登录态则是同一个 space 内共享**（这是省资源的设计意图），需要独立登录态时用 `space_new` 开隔离工作区。注意有头（3213）与无头（3215）是两个进程、两份 profile，**登录态不互通**。
- **安全默认值** —— 三个服务默认只绑 `127.0.0.1`，带 DNS rebinding 防护与限流；跨机共享须显式改 `HOST` + 设 `MCP_AUTH_TOKEN` + 把客户端用的 `host:port` 加进 `MCP_ALLOWED_HOSTS`（未设 token 就绑非回环地址会直接拒绝启动；漏 `MCP_ALLOWED_HOSTS` 则一律 403）。
- **双传输并存** —— HTTP（Streamable HTTP）为推荐形态；**stdio 原生模式**保留为备用，行为与旧版完全一致，客户端改个配置即可回退。
- **跨平台** —— Windows / macOS / Linux 通用，端口一致，单入口 `node mcp.mjs <cmd>`；开机自启一条 `node mcp.mjs autostart` 覆盖三平台。
- **进程安全** —— stdio 模式多重退出兜底（信号 / stdin / ppid 轮询 / exit 钩子），SSH 断开不留孤儿 Chromium。
- **服务级 instructions** —— 两个 MCP 在 initialize 时下发使用说明，支持的客户端（Claude Code / Codex 等）会自动注入 AI 上下文，AI 无需读文档即知工具的正确配合方式。
- **国内网络适配** —— `install` / `update` 自动探测 npm 官方源，不可达时自动切换 npmmirror 镜像（含 Chromium 二进制下载），也可用 `NPM_REGISTRY` 环境变量显式指定源。

## 系统要求

- Node.js >= 20
- Windows 10+ / macOS 10.15+ / Linux
- PM2（HTTP 常驻模式；只用 stdio 可不装）

## 服务与端点

| 服务 | 端口 | PM2 名 | 端点 | 浏览器 profile | 适用 |
|------|------|--------|------|----------------|------|
| 有头浏览器 | 3213 | `claudemcp-browser` | `http://127.0.0.1:3213/mcp` | `claude/storage/user_data_headed` | 桌面：窗口可见、可人工接管 |
| 无头浏览器 | 3215 | `claudemcp-headless` | `http://127.0.0.1:3215/mcp` | `claude/storage/user_data` | 服务器 / 后台 |
| 数据库 | 3214 | `claudemcp-database` | `http://127.0.0.1:3214/mcp` | — | PostgreSQL / MySQL |

> 两个浏览器服务的 profile 必须分开：同一目录被两个 Chromium 同时打开时，磁盘上的 Cookies
> 由最后落盘的那个覆盖，另一边的登录态会静默丢失。代价是两个服务各有一份独立登录态 ——
> 想让所有窗口共用一份，就只跑其中一个（桌面机推荐只跑有头）。

## 快速开始

```bash
cd claude

# 1. 安装（跨平台 Node CLI）
node mcp.mjs install

# 2. 启动三个常驻服务（自动做端点健康检查）
node mcp.mjs start

# 3. 打印并执行客户端注册命令
node mcp.mjs config

# 4. 可选：配置开机自启（三平台指引，--apply 落地）
node mcp.mjs autostart
```

注册后形如：

```bash
claude mcp add --transport http browser        http://127.0.0.1:3215/mcp
claude mcp add --transport http browser-headed http://127.0.0.1:3213/mcp
claude mcp add --transport http database       http://127.0.0.1:3214/mcp
```

> 不想跑常驻服务？`node mcp.mjs config` 的「方式 B」是 stdio 备用路径，行为与旧版一致。

## 日常更新

仓库有新版本时，一条命令完成升级（拉代码 + 重装依赖 + 校验浏览器 + 重新构建 + 重启在跑的 PM2 服务）：

```bash
node claude/mcp.mjs update
```

HTTP 模式在 Claude Code 里 `/mcp` 重连即可生效；stdio 模式下次会话自动生效。对 AI 说"更新本地 MCP"即可触发。

## 文档

- [`AI-DEPLOY.md`](./AI-DEPLOY.md) —— **给 AI 助手的部署 Runbook**（可直接执行的命令序列 + 每步自检 + 不可违背的约束）
- [`DEPLOY.md`](./DEPLOY.md) —— **新机器 / 多机部署指南**（含三平台开机自启、安全默认值、排障）
- [`claude/README.md`](./claude/README.md) —— 完整安装、配置与用法
- [`CODEX.md`](./CODEX.md) —— Codex CLI 全局 MCP 注册、调用与排障
- [`USAGE.md`](./USAGE.md) —— 工具调用规则（给 AI 看的手册）
