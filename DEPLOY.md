# 部署指南（新机器 / 多机部署）

把这套 MCP 服务部署到一台新机器（Windows / macOS / Linux 通用）。
**每台要用的机器执行一次即可**，之后所有项目自动可用。

> 推荐形态是 **HTTP 常驻服务**：一台机器上跑三个长驻服务，所有 Claude Code / Codex 窗口共用。
> stdio 模式（每个窗口各拉一个进程）仍然保留，作为备用路径，行为与旧版完全一致。

---

## 前置要求

- **Node.js >= 20**（`node -v` 确认）
- **git**
- **Claude Code** 已安装（`claude` 命令可用）
- **PM2**（HTTP 常驻模式需要：`npm install -g pm2`；只用 stdio 可跳过）

---

## 部署步骤

### 1. 克隆仓库

```bash
git clone https://github.com/xx2468171796/localmcpbrower
cd localmcpbrower/claude
```

> 放在一个**长期固定**的目录（不要放 `/tmp` 等临时目录）。
> 下文所有路径都相对这个**安装目录**描述：`<安装目录>` 即上面 `localmcpbrower/claude`。

### 2. 安装

```bash
node mcp.mjs install
```

一条命令完成：浏览器 + 数据库依赖安装、Patchright Chromium 下载、TypeScript 构建。三平台行为一致。

- **Linux**：以 root 运行时会自动用 `--with-deps` 装 Chromium 所需系统库（`libnss3` 等）；
  非 root 会跳过并提示你手动执行 `sudo npx patchright install-deps chromium`。
- **Windows**：直接可用，所有命令统一走 `node mcp.mjs <cmd>`。

### 3. 启动常驻服务

```bash
node mcp.mjs start
```

一次拉起三个 PM2 服务，并做端点健康检查：

| 服务 | 端口 | PM2 名 | PM2 配置 | 浏览器 profile | 说明 |
|------|------|--------|----------|----------------|------|
| 有头浏览器 | 3213 | `claudemcp-browser` | `ecosystem.config.cjs` | `storage/user_data_headed` | 窗口可见，可实时观察 agent 操作、随时人工接管（登录 / 验证码 / 二次确认） |
| 无头浏览器 | 3215 | `claudemcp-headless` | `ecosystem.headless.config.cjs` | `storage/user_data` | 后台运行，服务器 / SSH 环境 |
| 数据库 | 3214 | `claudemcp-database` | `mcp-database/ecosystem.config.cjs` | — | PostgreSQL / MySQL，共享连接池 |

> 两个浏览器服务的 profile **必须分开**：同一个目录被两个 Chromium 同时打开时，
> 磁盘上的 Cookies 由最后落盘的那个覆盖，另一边的登录态会静默丢失（见下文「会话隔离」）。

端点分别是 `http://127.0.0.1:<端口>/mcp`，三平台端口一致。

单独控制：

```bash
node mcp.mjs start headed      # 仅有头浏览器 (3213)
node mcp.mjs start headless    # 仅无头浏览器 (3215)
node mcp.mjs start db          # 仅数据库     (3214)
node mcp.mjs stop / restart / status
```

> 旧写法 `browser` 仍等价于 `headless`，`start.bat` 等老脚本不受影响。
> Linux 无图形显示（无 `DISPLAY` / `WAYLAND_DISPLAY`）时，`start`（不带参数）会**自动跳过有头**，
> 只跑无头 + 数据库，避免有头服务反复重启刷日志。

### 4. 注册到客户端

```bash
node mcp.mjs config
```

打印本机专属的注册命令，复制执行即可：

```bash
claude mcp add browser -s user -- node <仓库路径>/claude/bin/shim.mjs headless
claude mcp add browser-headed -s user -- node <仓库路径>/claude/bin/shim.mjs headed
claude mcp add database -s user -- node <仓库路径>/claude/bin/shim.mjs db
```

或写进项目根目录 `.mcp.json`（模板：`<安装目录>/.mcp.http.example.json`）：

```json
{
  "mcpServers": {
    "browser": { "command": "node", "args": ["<仓库路径>/claude/bin/shim.mjs", "headless"] },
    "browser-headed": { "command": "node", "args": ["<仓库路径>/claude/bin/shim.mjs", "headed"] },
    "database": { "command": "node", "args": ["<仓库路径>/claude/bin/shim.mjs", "db"] },
  }
}
```

> HTTP 条目里写的是 **URL 不是路径**，可以跨机器同步；只有 stdio 条目才含本机绝对路径。
> 桌面机通常留 `browser-headed` + `database`；服务器留 `browser`（无头）+ `database`。
> 之前注册过同名 stdio 条目的话先移除：`claude mcp remove browser -s user`。

### 5. 验证

```bash
node mcp.mjs status     # PM2 三个服务应为 online
claude mcp list         # 对应条目应为 ✓ Connected
```

---

## 会话隔离（HTTP 模式下必须知道的语义）

多个客户端窗口共用同一个服务，但**互不打架**：

| 隔离级别 | 粒度 | 触发 | 效果 |
|---|---|---|---|
| 会话 → 标签页 | 浏览器标签页 | **自动**（连上即分配） | 每个客户端窗口有自己的标签页、自己的 console / 网络记录、自己的 `set_block_rules` 拦截规则；`list_tabs` / `switch_tab` / `close_tab` 只看得到、也只动得了自己的标签页 |
| 会话 → 数据库指针 | 当前库 | **自动** | A 窗口 `switch_db('prod')` 不会把 B 窗口带到 prod；连接池按库共享，指针各自独立 |
| Space → 浏览器上下文 | cookie / 登录态 | **显式** `space_new` | 需要多账号或独立登录态时才用；**同一个服务内**默认所有会话共用 `default` space，也就是**共享一份登录态** |
| 有头服务 ↔ 无头服务 | Chromium profile | **固定** | 两个服务是两个进程、两个 Chromium，各占一份 profile —— **两份独立登录态，不互通** |

要点：
- **默认共享登录态**是本机单人场景想要的（登录一次，**同一个服务**的所有窗口都能用）。
- **有头（3213）和无头（3215）不共享登录态**：
  `ecosystem.config.cjs` 用 `storage/user_data_headed`，`ecosystem.headless.config.cjs` 用 `storage/user_data`。
  两个 Chromium 绝不能指向同一个 profile 目录 —— 实测两边同时跑时，磁盘上的 Cookies 由最后落盘的那个覆盖，
  后启动那一侧写入的登录态会**静默丢失**。所以「登录一次全窗口可用」的范围是**单个服务**，不是两个服务之间。
  想让所有窗口真正共用一份登录态，就只跑其中一个服务（推荐桌面机只跑有头）。
- 需要「这个任务别用我的公司账号」这类隔离时，用 `space_new({ name: "job1" })` 开独立工作区。
- 一个窗口在共享 space 里登出，会影响同一服务的其他窗口 —— 这也是 `space_new` 的用途所在。
- stdio 模式没有多会话概念，行为与旧版完全一致（单会话回落）；stdio 用的是默认 `storage/user_data`，
  与无头服务是同一份 profile，所以**别让 stdio 浏览器和无头服务同时跑**。

---

## 安全默认值（务必先看）

浏览器里存着**已登录的公司系统会话**，数据库端点等于一条通往生产库的通道，
所以 HTTP 端口的暴露面必须收住：

| 项 | 默认 | 说明 |
|---|---|---|
| 监听地址 | `127.0.0.1` | 三个 `ecosystem*.cjs` 都显式写死 `HOST=127.0.0.1`，只有本机能连 |
| 鉴权 | 关闭 | 本机回环场景不需要；**绑非回环地址时必须设 `MCP_AUTH_TOKEN`** |
| DNS rebinding 防护 | 开启 | 只接受 `127.0.0.1:<端口>` / `localhost:<端口>` / `[::1]:<端口>` 的 Host；**其它 Host 要靠 `MCP_ALLOWED_HOSTS` 显式放行**，否则 403 |
| CORS | 收紧到本地来源 | 不再是 `*` |
| 限流 | 100 req/s per IP | — |

**跨机共享**（例如让另一台机器连你的浏览器）时**三件事必须同时做，缺一条就连不上**：

1. 在对应 `ecosystem*.cjs` 的 `env` 里把 `HOST` 改成 `0.0.0.0`（或具体网卡地址）；
2. 同时设置 `MCP_AUTH_TOKEN`（不设直接拒绝启动）；
3. 设置 `MCP_ALLOWED_HOSTS`，值是**客户端 URL 里实际写的 `host:port`**（逗号分隔可多个）。

第 3 条最容易漏。MCP SDK 的 DNS rebinding 防护对请求的 `Host` 头做**全等匹配**，
默认白名单只有 `127.0.0.1:<端口>` / `localhost:<端口>` / `[::1]:<端口>` /`<HOST>:<端口>`——
`HOST=0.0.0.0` 时那一条是字面量 `0.0.0.0:3215`，而远端客户端发来的 Host 是 `192.168.1.10:3215`，
对不上就直接 **403 `Invalid Host header`**（数据库 MCP 更严格，`0.0.0.0` 被显式排除在外）。

```js
// claude/ecosystem.headless.config.cjs 的 env 片段
env: {
  PORT: '3215',
  HOST: '0.0.0.0',
  MCP_AUTH_TOKEN: '<足够长的随机串>',
  MCP_ALLOWED_HOSTS: '192.168.1.10:3215',   // ← 客户端 URL 里的 host:port，可写多个
  // 若还要从网页(浏览器环境)直接发起请求，再加 MCP_ALLOWED_ORIGINS: 'http://192.168.1.10:3215'
}
```

改完用 `node mcp.mjs restart headless` 生效（它传的是 ecosystem 文件，会重新加载 env）。
客户端条目加上请求头：

```json
{
  "mcpServers": {
    "browser": {
      "type": "http",
      "url": "http://192.168.1.10:3215/mcp",
      "headers": { "Authorization": "Bearer <你的 token>" }
    }
  }
}
```

> 只改 `HOST` 不设 token 时服务会**拒绝启动**（fail-fast），防止误开裸端口。
> 服务启动日志里会打印 `allowedHosts=...`，照着核对一遍最快。
>
> `node mcp.mjs start` 的健康检查和 `node mcp.mjs config` 打印的端点 URL 都**读同一份 `ecosystem*.cjs`**：
> `HOST` 是 `0.0.0.0` 时按 `127.0.0.1` 探测（绑全部网卡，回环必通），是具体网卡地址时就探那个地址本身
> —— 所以改完 `HOST` 不会再出现「服务其实起来了却报未监听」。

---

## 开机自启（跨平台）

统一入口：

```bash
node mcp.mjs autostart            # 只打印本平台指引，不改动任何配置
node mcp.mjs autostart --apply    # 真正落地（pm2 save + 本平台可自动完成的部分）
```

前提：先 `node mcp.mjs start` 把要自启的服务跑起来，`pm2 save` 才有内容可存。

### Windows —— 必须用户级自启

> **严禁把服务注册成 Windows 系统服务**（`pm2-service-install` / 任务计划里勾「不管用户是否登录都运行」）。
> 系统服务跑在 **Session 0**，有头浏览器窗口永远不可见，也就没法人工接管登录 / 验证码 —— 这正是有头模式的意义所在。

两种等价做法，任选其一：

**A. 启动文件夹（`autostart --apply` 会自动写）**

`--apply` 会在用户启动文件夹
（`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`，可用 `Win+R` → `shell:startup` 打开）
写入 `claudemcp-autostart.cmd`：

```bat
@echo off
REM Claude Code MCP - per-user autostart (restores PM2 apps after desktop logon)
call pm2 resurrect
```

删除该文件即取消自启。

> 脚本刻意保持**纯 ASCII、且不写 `cd /d "<安装目录>"`**：
> `.cmd` 是按 OEM 代码页（中文机器 GBK/936）逐行解析的，而文件是无 BOM UTF-8 —— 混入中文
> （注释或含中文的安装路径）就会解成乱码，`cd` 静默失败且没有任何提示。
> `pm2 resurrect` 从 dump 里读的是每个 app 自己的绝对 `cwd`，本来就不依赖当前目录。
> 如果你要自己往里加中文注释，记得先补一行 `chcp 65001 >nul`。

**B. 任务计划程序**

新建任务 → 触发器选「登录时」→ 操作执行 `pm2 resurrect` →
安全选项保持 **「只在用户登录时运行」**。（「起始位置」留空即可，`pm2 resurrect` 不依赖当前目录。）

### macOS

```bash
pm2 startup                 # 输出一条 sudo 命令
sudo env PATH=... pm2 startup launchd -u <你> --hp <你的家目录>   # 复制它输出的那条执行
pm2 save
```

有头浏览器窗口只在你登录图形会话后才可见，这与 launchd 无关。

### Linux 桌面

```bash
pm2 startup                 # 输出一条 sudo 命令
sudo env PATH=... pm2 startup systemd -u <你> --hp <你的家目录>
pm2 save
```

有头需要图形会话（`DISPLAY` / `WAYLAND_DISPLAY`）。

### Linux 服务器（无显示）

**只能跑无头**（3215）+ 数据库（3214）。`node mcp.mjs start` 会自动跳过有头。

确实要在无显示机器上跑有头，需要虚拟显示：

```bash
sudo apt install -y xvfb
Xvfb :99 -screen 0 1920x1080x24 &
export DISPLAY=:99
node mcp.mjs start headed
```

> 注意：Xvfb 下的窗口没人看得见，「人工接管」失效 —— 这种机器直接用无头更实在。

### 自启校验

重启机器 → 登录桌面 → `node mcp.mjs status`，三个服务应为 `online`。

---

## 平台对照

| 平台 | 无头 | 有头 | 自启方式 |
|------|------|------|----------|
| **Windows** | ✅ | ✅ | 启动文件夹 / 任务计划「只在用户登录时运行」+ `pm2 save`（**不可用系统服务**） |
| **macOS** | ✅ | ✅ | `pm2 startup`（launchd）+ `pm2 save` |
| **Linux 桌面** | ✅ | ✅ | `pm2 startup`（systemd）+ `pm2 save` |
| **Linux 服务器（无显示）** | ✅ | ❌ 需 Xvfb | `pm2 startup`（systemd） |

端口三平台一致（3213 / 3214 / 3215）；所有路径按**安装目录**相对描述，不依赖当前工作目录。

---

## 备用形态：stdio 模式

不想跑常驻服务、或服务临时不可达时，仍可让客户端直接拉起进程。行为与旧版完全一致：
每个窗口一个进程、一个浏览器，不占端口，无需 PM2。

```bash
node mcp.mjs config     # 方式 B 部分即 stdio 命令，路径为本机绝对路径
```

```bash
claude mcp add browser -- node "<安装目录>/dist/server.js" --stdio
claude mcp add database -e MCP_TRANSPORT=stdio -- node "<安装目录>/mcp-database/dist/server.js" --stdio
```

> stdio 条目写的是**本机绝对路径**，不能跟着仓库同步到别的机器。
> 两种传输可以并存：注册成不同名字（如 `browser` 走 HTTP、`browser-stdio` 走 stdio），随时切换。

---

## 接入其他 MCP 客户端（Codex CLI / Cursor 等）

本服务用的是 **MCP 标准传输**（Streamable HTTP + stdio），不是 Claude 专属 ——
任何支持 MCP 的客户端都能连**同一套服务**。HTTP 模式下多个客户端直接共享同一个常驻进程，
依赖、构建产物、Chromium 完全复用。

### Cursor / Windsurf / Cline 等（JSON 配置）

HTTP（推荐，模板见 `<安装目录>/.mcp.http.example.json`）：

```json
{
  "mcpServers": {
    "browser": { "command": "node", "args": ["<仓库路径>/claude/bin/shim.mjs", "headless"] },
    "database": { "command": "node", "args": ["<仓库路径>/claude/bin/shim.mjs", "db"] },
  }
}
```

stdio（备用，模板见 `<安装目录>/.mcp.json.example`）：

```json
{
  "mcpServers": {
    "browser":  { "command": "node", "args": ["<安装目录>/dist/server.js", "--stdio"] },
    "database": { "command": "node", "args": ["<安装目录>/mcp-database/dist/server.js", "--stdio"], "env": { "MCP_TRANSPORT": "stdio" } }
  }
}
```

### Codex CLI（OpenAI）

配置文件 `~/.codex/config.toml`（**TOML** 格式）。

```bash
codex mcp add browser -- node <安装目录>/dist/server.js --stdio
codex mcp add database --env MCP_TRANSPORT=stdio -- node <安装目录> <仓库路径>/claude/bin/shim.mjs db
```

或直接编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.browser]
command = "node"
args = ["<安装目录>/dist/server.js", "--stdio"]
type = "stdio"
cwd = "<安装目录>"
startup_timeout_sec = 30

[mcp_servers.database]
command = "node"
args = ['<仓库路径>/claude/bin/shim.mjs', 'db']
type = "stdio"
cwd = "<安装目录>/mcp-database"
startup_timeout_sec = 30

[mcp_servers.database.env]
MCP_TRANSPORT = "stdio"
```

> Codex 对 http 型 MCP 条目的支持随版本变化，先用 `codex mcp add --help` 确认你的版本是否支持 URL 形式；
> 不支持就继续用上面的 stdio 条目 —— 两种传输并存，将来随时可切。
> 如果 Codex 的 shell 环境找不到 `node`，把 `command = "node"` 改成绝对路径（macOS Apple Silicon 常见 `/opt/homebrew/bin/node`）。

更完整的 Codex 用法见 [`CODEX.md`](./CODEX.md)。项目根目录的 [`AGENTS.md`](./AGENTS.md) 会告诉 Codex 优先使用 `mcp__browser__*` 和 `mcp__database__*` 工具。

### 各客户端对照

| 客户端 | 配置文件 | 格式 | 添加命令 |
|--------|----------|------|----------|
| Claude Code | `~/.claude.json` / 项目 `.mcp.json` | JSON | `claude mcp add <名> -- node <路径>/claude/bin/shim.mjs <服务>` |
| Codex CLI | `~/.codex/config.toml` | TOML | `codex mcp add` |
| Cursor | `.cursor/mcp.json` | JSON | 手动编辑 |
| Windsurf / Cline 等 | 各自的 MCP 配置文件 | JSON | 手动编辑 |

> Windows 上 JSON 里写 stdio 绝对路径时反斜杠需转义为 `\\`；HTTP 条目是 URL，没有这个问题。

---

## 运维特性

**HTTP 常驻模式**

- **不掉线** —— PM2 `autorestart` + `max_memory_restart`，进程异常退出自动拉起。
- **开机自启** —— 见上文「开机自启」。
- **升级零打扰** —— `node mcp.mjs update` 重启在跑的服务，客户端 `/mcp` 重连即可，不必逐个窗口重开。
- **风险点** —— 服务挂掉时所有窗口的对应工具一起不可用；备用 stdio 条目可随时顶上。

**stdio 模式**

- 进程由客户端自己管理：会话开始拉起、结束回收，无需 PM2、无需端口。

---

## 数据库配置（可选）

数据库 MCP 可在启动时自动连库 —— 复制并编辑 `<安装目录>/mcp-database/.env`：

```bash
cp mcp-database/.env.example mcp-database/.env
# 填入 DB_TYPE / DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD
```

不配也行：运行时让 AI 用 `list_presets` / `connect` / `switch_db` 按需连接。

> HTTP 模式下改完 `.env` 需要 `node mcp.mjs restart db` 生效。

---

## 升级 / 卸载

```bash
# 升级：git pull + 重装依赖 + 校验 Chromium + 重建 + 重启在跑的 PM2 服务
node mcp.mjs update

# 卸载：停服务 + 移除注册
node mcp.mjs stop
claude mcp remove browser -s user
claude mcp remove browser-headed -s user
claude mcp remove database -s user
```

> `update` 自带保护：本地有未提交改动会中止；非 git 仓库（复制部署）或分支无远端时
> 自动跳过拉取、只重建。HTTP 模式更新后在 Claude Code 里 `/mcp` 重连；stdio 模式下次会话自动生效。
> 对 AI 说"更新本地 MCP"即可触发这条命令（见 `AGENTS.md`）。

**从更早的版本（服务名/端口/env 变过的那些）升上来时**，建议不要只 `update`，而是：

```bash
node mcp.mjs update
node mcp.mjs stop        # 停掉并从 PM2 里删除旧条目
node mcp.mjs start       # 完全按新的 ecosystem 文件重建
pm2 save                 # 配过自启的话刷新 dump，否则下次开机恢复的还是旧配置
```

原因：PM2 按**进程名**重启时复用的是 dump 里缓存的 `pm2_env`，不会重读 ecosystem 文件
（`mcp.mjs` 的 `restart` / `update` 现在都改成传配置文件路径了，但已经落进 dump 的老条目
仍需要一次 `stop` + `start` 才能彻底换掉）。旧版把 `HOST` 设成 `0.0.0.0` 的机器尤其要走这一步，
否则「收回 `127.0.0.1`」这条安全修复不会生效。

---

## 排障

```bash
node mcp.mjs status                       # PM2 状态
pm2 logs claudemcp-browser --lines 50     # 有头浏览器日志
pm2 logs claudemcp-headless --lines 50
pm2 logs claudemcp-database --lines 50

curl http://127.0.0.1:3215/health         # 端点健康

# 端口占用
netstat -ano | findstr "3213 3214 3215"   # Windows
lsof -i :3213 -i :3214 -i :3215           # macOS
ss -tlnp | grep -E '3213|3214|3215'       # Linux
```

| 症状 | 排查方向 |
|------|----------|
| `claude mcp list` 显示未连接 | 服务没起（`node mcp.mjs status`）；端口被占；URL 写成了 `localhost` 而服务只绑了 `127.0.0.1` 且 DNS 解析异常 |
| 有头浏览器看不到窗口 | 自启方式错了（跑成了系统服务 / Session 0），改用户级自启；或 Linux 无 `DISPLAY` |
| 跨机连不上 | `HOST` 仍是 `127.0.0.1`；或设了非回环地址但没给 `MCP_AUTH_TOKEN` 导致服务拒绝启动；或防火墙 |
| 远端返回 **403 `Invalid Host header`** | 漏了 `MCP_ALLOWED_HOSTS`。把客户端 URL 里的 `host:port`（如 `192.168.1.10:3215`）加进对应 `ecosystem*.cjs` 的 `env`，`node mcp.mjs restart <目标>` 生效；服务启动日志里的 `allowedHosts=...` 可直接对照 |
| 改了 `ecosystem*.cjs` 但不生效 | 老条目的 `pm2_env` 还留在 PM2 dump 里。用 `node mcp.mjs restart`（传的是配置文件、会重读 env）；仍不行就 `node mcp.mjs stop && node mcp.mjs start`，配过自启的再 `pm2 save` |
| 登录态莫名丢失 | 有头和无头**指向了同一个 profile 目录**（两个 Chromium 抢一份 Cookies，后落盘的覆盖先落盘的）。确认 `ecosystem.config.cjs` 是 `storage/user_data_headed`、`ecosystem.headless.config.cjs` 是 `storage/user_data`；stdio 浏览器也用默认 `storage/user_data`，别和无头服务同时跑 |
| 日志刷「有头启动失败」 | 无显示环境跑了 `start headed`，改跑无头或备 Xvfb |
| `pm2 list` 里出现名为 `ecosystem.headless` 的 errored 进程 | 用的是旧文件名。PM2 只把 `.json` / `.yml` / `.yaml` / `.config.js` / `.config.cjs` / `.config.mjs` 当 ecosystem 配置，`ecosystem.headless.cjs` 会被当**普通脚本**执行。升级后文件已改名为 `ecosystem.headless.config.cjs`，`pm2 delete ecosystem.headless` 清掉残留即可 |
