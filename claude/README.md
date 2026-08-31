# Claude Code MCP 服务 (Windows / macOS / Linux)

为 Claude Code 提供**浏览器自动化**和**数据库操作**能力的 MCP 服务。

基于 Patchright (Playwright 反检测分支) + Express 5 + MCP SDK，同时支持两种传输方式：

- **HTTP（Streamable HTTP）常驻模式 — 推荐**。三个长驻服务，所有客户端窗口共用一份 Chromium、
  一份登录态、一套数据库连接池；**浏览器标签页默认共享**(任何窗口都能接管别的窗口开的页,设 PIPE_ISOLATED=1 切隔离);**数据库当前库指针默认隔离**。登录态始终共享。
- **stdio 原生模式 — 备用**。客户端直接拉起进程，不占端口、不需要 PM2，行为与旧版完全一致。

> 三平台通用；浏览器服务在 Windows 上原生运行（Patchright Chromium for win32）。

## 系统要求

- Windows 10+ / macOS 10.15+ / Linux (Debian 12+、Ubuntu 等)
- **Node.js >= 20**
- HTTP 模式额外需要 PM2（`npm install -g pm2`）；stdio 模式不需要

## 服务一览

| 服务 | 端口 | PM2 名 | PM2 配置 | 浏览器 profile | 说明 |
|------|------|--------|----------|----------------|------|
| Browser MCP（有头） | 3213 | `claudemcp-browser` | `ecosystem.config.cjs` | `storage/user_data_headed` | 窗口可见，可实时观察并人工接管 |
| Browser MCP（无头） | 3215 | `claudemcp-headless` | `ecosystem.headless.config.cjs` | `storage/user_data` | 后台 / 服务器 / SSH |
| Database MCP | 3214 | `claudemcp-database` | `mcp-database/ecosystem.config.cjs` | — | PostgreSQL / MySQL |

- 端点统一为 `http://127.0.0.1:<端口>/mcp`，健康检查 `GET /health`（不走鉴权），**三平台端口一致**。
- 有头与无头使用**同一套源码**，通过 `HEADLESS` 环境变量切换。
- **两个浏览器服务各占一份 profile，也就是两份独立登录态**：同一个 `user_data` 目录被两个
  Chromium 同时打开时，磁盘上的 Cookies 由最后落盘的那个覆盖，另一边的登录态会静默丢失。
  想让所有窗口共用一份登录态，就只跑其中一个服务。
- PM2 配置文件名必须以 `.config.cjs` 结尾 —— PM2 只认
  `.json` / `.yml` / `.yaml` / `.config.js` / `.config.cjs` / `.config.mjs`，
  其它后缀会被当**普通脚本**执行（旧名 `ecosystem.headless.cjs` 就是踩了这个坑）。
- stdio 模式不占端口，浏览器是否有头由注册时的环境变量决定；stdio 用默认 `storage/user_data`，
  与无头服务同一份 profile，**别和无头服务同时跑**。

---

## 一、安装

跨平台统一入口是 `mcp.mjs`（纯 Node，无依赖），在三个平台上行为一致：

```bash
node mcp.mjs install
```

该命令会为浏览器目录和数据库目录依次执行：`npm install` → `npx patchright install chromium` → `npm run build`。

### bash 安装脚本（可选，macOS / Linux）

```bash
bash install.sh
```

---

## 二、推荐用法：HTTP 常驻模式

### 启动 / 停止 / 状态

```bash
node mcp.mjs start             # 启动全部三个服务 + 端点健康检查
node mcp.mjs start headed      # 仅有头浏览器 (3213)
node mcp.mjs start headless    # 仅无头浏览器 (3215)
node mcp.mjs start db          # 仅数据库     (3214)
node mcp.mjs stop [目标]        # 停止
node mcp.mjs restart [目标]     # 重启
node mcp.mjs status            # 查看 PM2 状态
```

> 旧写法 `browser` 仍等价于 `headless`（`start.bat browser` 等老脚本不受影响）。
> Linux 无图形显示时，不带参数的 `start` 会自动跳过有头，只跑无头 + 数据库。

Windows (CMD) 可用批处理入口，内部委托给 `mcp.mjs`：

```bat
start.bat
stop.bat
```

直接用 PM2：

```bash
pm2 start ecosystem.config.cjs              # 有头浏览器  (3213)
pm2 start ecosystem.headless.config.cjs     # 无头浏览器  (3215)
pm2 start mcp-database/ecosystem.config.cjs # 数据库      (3214)

# 改过 ecosystem 里的 env 后要重启:一定传**配置文件**，别传进程名 ——
# 按名字重启复用的是 PM2 dump 里缓存的 pm2_env，不会重读文件，新 env 不生效
pm2 restart ecosystem.headless.config.cjs --update-env
```

### 注册 HTTP 端点到 Claude Code

```bash
node mcp.mjs config    # 打印本机专属命令
```

```bash
claude mcp add browser -s user -- node <仓库路径>/claude/bin/shim.mjs headless
claude mcp add browser-headed -s user -- node <仓库路径>/claude/bin/shim.mjs headed
claude mcp add database -s user -- node <仓库路径>/claude/bin/shim.mjs db
```

或写入项目根目录 `.mcp.json`（模板 `.mcp.http.example.json`）：

```json
{
  "mcpServers": {
    "browser": { "command": "node", "args": ["<仓库路径>/claude/bin/shim.mjs", "headless"] },
    "browser-headed": { "command": "node", "args": ["<仓库路径>/claude/bin/shim.mjs", "headed"] },
    "database": { "command": "node", "args": ["<仓库路径>/claude/bin/shim.mjs", "db"] },
  }
}
```

> 桌面机常用组合是 `browser-headed` + `database`；服务器 / SSH 用 `browser`（无头）+ `database`。
> 之前注册过同名 stdio 条目要先移除：`claude mcp remove browser -s user`。

### 会话隔离语义（多窗口共用一个服务时）

| 隔离级别 | 粒度 | 触发 | 效果 |
|---|---|---|---|
| 会话 → 标签页 | 标签页 | **自动**（连上即分配） | 每个客户端窗口有自己的标签页、自己的 console / 网络记录、自己的 `set_block_rules` 拦截规则；`list_tabs` / `switch_tab` / `close_tab` 只作用于本会话的标签页 |
| 会话 → 数据库指针 | 当前库 | **自动** | A 窗口 `switch_db('prod')` 不影响 B 窗口；连接池按库共享，指针各自独立 |
| Space → 浏览器上下文 | cookie / 登录态 | **显式** `space_new` | **同一个服务内**默认所有会话共用 `default` space（**共享登录态**）；需要独立登录态时才开新 space |
| 有头服务 ↔ 无头服务 | Chromium profile | **固定** | 两个进程、两个 Chromium、两份 profile —— **登录态不互通** |

要点：默认共享登录态是本机单人场景想要的（登录一次，**同一个服务**的全部窗口可用）；
一个窗口在共享 space 里登出会影响同一服务的其他窗口，需要隔离就用 `space_new({ name: "job1" })`。
**有头（3213）和无头（3215）之间不共享登录态** —— 它们必须各占一份 profile，
否则两个 Chromium 抢同一份 Cookies，后落盘的会把另一边的登录态覆盖掉。
stdio 模式没有多会话概念，回落为单会话行为，与旧版一致。

### 安全默认值

| 项 | 默认 | 说明 |
|---|---|---|
| 监听地址 | `127.0.0.1` | 三个 `ecosystem*.cjs` 都显式写死 `HOST`，只有本机能连 |
| 鉴权 `MCP_AUTH_TOKEN` | 未设 = 不校验 | **绑非回环地址时必须设置**，否则服务拒绝启动。只挡 `/mcp` 和 `/connections`，`/health` 永远放行（留给探活） |
| DNS rebinding 防护 | 开启 | 只接受 `127.0.0.1:<端口>` / `localhost:<端口>` / `[::1]:<端口>`；其它 Host 要用 `MCP_ALLOWED_HOSTS` 显式放行 |
| CORS | 收紧到本地来源 | 不再是 `*`；额外来源用 `MCP_ALLOWED_ORIGINS` |
| 限流 | 100 req/s per IP | — |

跨机共享要在对应 `ecosystem*.cjs` 的 `env` 里**同时**设三项，缺一条就连不上：

```js
env: {
  HOST: '0.0.0.0',
  MCP_AUTH_TOKEN: '<足够长的随机串>',
  MCP_ALLOWED_HOSTS: '192.168.1.10:3215',   // ← 客户端 URL 里实际写的 host:port
}
```

第 3 条最容易漏：SDK 对 `Host` 头做**全等匹配**，`HOST=0.0.0.0` 时白名单里那条是字面量
`0.0.0.0:3215`，而远端客户端发来的是 `192.168.1.10:3215`，对不上就直接返回
**403 `Invalid Host header`**（数据库 MCP 更严格，`0.0.0.0` 被显式排除）。
服务启动日志会打印 `allowedHosts=...`，照着核对最快。改完用
`node mcp.mjs restart headless`（传的是配置文件，会重读 env）。

客户端条目加请求头：

```json
{ "type": "http", "url": "http://192.168.1.10:3215/mcp", "headers": { "Authorization": "Bearer <token>" } }
```

> 浏览器里存着已登录的公司系统会话，数据库端点直通生产库 —— 绑 `127.0.0.1` 是底线。

### 开机自启

```bash
node mcp.mjs autostart            # 打印本平台指引（不改动任何配置）
node mcp.mjs autostart --apply    # 落地：pm2 save + 本平台可自动完成的部分
```

- **Windows**：用户级自启（启动文件夹 / 任务计划「只在用户登录时运行」）+ `pm2 save`。
  **严禁注册成系统服务** —— 进程会落在 Session 0，有头浏览器窗口不可见。
- **macOS**：`pm2 startup`（launchd）+ `pm2 save`。
- **Linux 桌面**：`pm2 startup`（systemd）+ `pm2 save`。
- **Linux 服务器无显示**：只能跑无头；有头需先备 Xvfb。

完整步骤见仓库根目录 [`DEPLOY.md`](../DEPLOY.md)。

---

## 三、备用用法：stdio 原生模式

客户端直接以子进程方式拉起服务，不占端口、不需要 PM2，行为与旧版完全一致。

### 方式 1：`claude mcp add` 命令

```bash
node mcp.mjs config     # 「方式 B」段落即 stdio 命令，路径已按本机填好
```

```bash
# macOS / Linux
claude mcp add browser  -- node "/abs/path/claude/dist/server.js" --stdio
claude mcp add database -e MCP_TRANSPORT=stdio -- node "/abs/path/claude/mcp-database/dist/server.js" --stdio
```

```powershell
# Windows (PowerShell) —— 路径用反斜杠
claude mcp add browser  -- node "C:\abs\path\claude\dist\server.js" --stdio
claude mcp add database -e MCP_TRANSPORT=stdio -- node "C:\abs\path\claude\mcp-database\dist\server.js" --stdio
```

### 方式 2：项目级 `.mcp.json`

把 `.mcp.json.example` 复制到**项目根目录**并改名为 `.mcp.json`，将占位符
`/ABSOLUTE/PATH/TO` 替换为本仓库 `claude/` 目录的**绝对路径**：

```json
{
  "mcpServers": {
    "browser": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/claude/dist/server.js", "--stdio"]
    },
    "database": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/claude/mcp-database/dist/server.js", "--stdio"],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

- Windows 路径形如 `C:\\Users\\you\\local-mcp\\claude\\...`（JSON 中反斜杠需转义为 `\\`）
- `--stdio` 参数或 `MCP_TRANSPORT=stdio` 环境变量都可触发 stdio 模式
- 两种传输可并存：注册成不同名字（`browser` 走 HTTP、`browser-stdio` 走 stdio），随时切换

---

## 四、`mcp.mjs` 子命令一览

| 子命令 | 说明 |
|--------|------|
| `node mcp.mjs install` | 安装依赖 + Chromium + 构建（浏览器 + 数据库） |
| `node mcp.mjs update` | 一键更新：git pull + 重装依赖 + 重新构建 + 重启在跑的 PM2 服务 |
| `node mcp.mjs start [headed\|headless\|db\|all]` | PM2 启动常驻 HTTP 服务（默认 all）+ 端点健康检查 |
| `node mcp.mjs stop [目标]` | 停止服务 |
| `node mcp.mjs restart [目标]` | 重启服务 |
| `node mcp.mjs status` | 查看 PM2 进程状态 |
| `node mcp.mjs autostart [--apply]` | 开机自启（三平台指引，`--apply` 落地本机部分） |
| `node mcp.mjs config` | 打印客户端注册方式（HTTP 优先，stdio 备用） |
| `node mcp.mjs --help` | 显示帮助 |

> 目标别名：`browser` = `headless`、`browser-headed` = `headed`、`database` = `db`。

---

## 五、数据库配置

复制示例并编辑：

```bash
cp mcp-database/.env.example mcp-database/.env
```

```env
DB_TYPE=postgresql
DB_HOST=192.168.50.242
DB_PORT=6432
DB_NAME=csgo
DB_USER=csgo
DB_PASSWORD=your_password_here
DB_SSL=false
PORT=3214
```

支持预设多个数据库，通过别名快速切换：

```env
DB_PROD_TYPE=postgresql
DB_PROD_HOST=prod.example.com
DB_PROD_PORT=5432
DB_PROD_NAME=production
DB_PROD_USER=admin
DB_PROD_PASSWORD=secret
```

> HTTP 模式下修改 `.env` 后需 `node mcp.mjs restart db` 生效。
> `.env` 里的默认库只是每个会话的**初始指针**；某个会话 `switch_db` 不会改变其他会话的当前库。

---

## 六、脚本说明

| 文件 | 平台 | 说明 |
|------|------|------|
| `mcp.mjs` | 全平台 | **跨平台主入口**：安装 / 启停 / 自启 / 配置 |
| `install.sh` | macOS / Linux | bash 安装脚本（`node mcp.mjs install` 的替代） |
| `check-mcp-health.sh` | macOS / Linux | HTTP 模式健康检查 |
| `start.bat` / `stop.bat` | Windows | CMD 入口，委托给 `mcp.mjs` |
| `ecosystem.config.cjs` | 全平台 | 有头浏览器 PM2 配置（3213，`HOST=127.0.0.1`，profile `storage/user_data_headed`） |
| `ecosystem.headless.config.cjs` | 全平台 | 无头浏览器 PM2 配置（3215，`HOST=127.0.0.1`，profile `storage/user_data`） |
| `mcp-database/ecosystem.config.cjs` | 全平台 | 数据库 PM2 配置（3214，`HOST=127.0.0.1`） |
| `.mcp.http.example.json` | — | 项目级 **HTTP** 配置模板（推荐） |
| `.mcp.json.example` | — | 项目级 **stdio** 配置模板（备用） |

---

## 七、浏览器 MCP 工具（46 个）

导航、点击、填表、截图、多标签页管理、Cookie 操作、JS 执行、
网络拦截、PDF 导出、元素提取、页面爬取、拖拽、键盘输入、
无障碍快照（snapshot + ref 操作，**穿透 iframe**）、正文提取（extract_article，defuddle 转 Markdown）、
站点 URL 发现（discover_urls）、`run_script`（`__ego` 一次跑完，多步交互压成单次往返）、
Task Spaces（`space_new/switch/list/close`，并行隔离工作区，独立 cookie/登录态）。
完整清单与调用规则见仓库根目录 `USAGE.md`。

## 八、数据库 MCP 工具（15 个）

SQL 查询、表结构查看、索引分析、外键关系、数据导出（CSV）、多数据库切换等。
`query` 强制只读（SELECT/WITH/SHOW/EXPLAIN），写操作必须走 `execute`。
完整清单见仓库根目录 `USAGE.md`。

---

## 九、故障排查

```bash
# 状态与健康
node mcp.mjs status             # 全平台
bash check-mcp-health.sh        # macOS / Linux
curl http://127.0.0.1:3215/health

# 查看 PM2 日志
pm2 logs claudemcp-browser  --lines 50
pm2 logs claudemcp-headless --lines 50
pm2 logs claudemcp-database --lines 50

# 检查端口 (HTTP 模式)
ss -tlnp | grep -E '3213|3214|3215'      # Linux
lsof -i :3213 -i :3214 -i :3215          # macOS
netstat -ano | findstr "3213 3214 3215"  # Windows
```

- **stdio 模式不占用端口**，端口检查仅对 HTTP / PM2 模式有意义。
- HTTP 模式连不上：先看 `node mcp.mjs status` 是否 online，再看端口是否被占，
  最后确认没把 `HOST` 改成非回环却漏了 `MCP_AUTH_TOKEN`（那种情况服务会拒绝启动）。
- 远端返回 **403 `Invalid Host header`**：漏了 `MCP_ALLOWED_HOSTS`，见上文「安全默认值」。
- **改了 `ecosystem*.cjs` 却不生效**：多半是按进程名重启了（PM2 复用 dump 缓存的 `pm2_env`，
  不重读文件）。用 `node mcp.mjs restart <目标>`，仍不行就 `node mcp.mjs stop && node mcp.mjs start`。
- **登录态莫名丢失**：检查有头 / 无头（以及 stdio 浏览器）是不是指向了同一个 profile 目录。
- `pm2 list` 里出现名为 `ecosystem.headless` 的 errored 进程：用的是旧文件名
  `ecosystem.headless.cjs`（PM2 把它当普通脚本跑了）。现已改名 `ecosystem.headless.config.cjs`，
  `pm2 delete ecosystem.headless` 清掉残留即可。
- 有头浏览器没有窗口：多半是自启方式错了（跑成了 Windows 系统服务 / Session 0），
  改用户级自启；Linux 则检查 `DISPLAY`。
- stdio 模式工具不可用：先 `node mcp.mjs install` 确认 `dist/server.js` 已构建，
  再用 `claude mcp list` 检查注册状态。
