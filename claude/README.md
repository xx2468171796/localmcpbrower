# Claude Code MCP 服务 (macOS / Linux / Windows)

为 Claude Code 提供**浏览器自动化**和**数据库操作**能力的 MCP 服务。

基于 Playwright + Express + MCP SDK，**v2.0.0** 起同时支持两种传输方式：

- **stdio 原生模式** — Claude Code 直接拉起进程，**无需 PM2、无需端口**，最简单，**推荐**。
- **HTTP（Streamable HTTP）模式** — 长驻服务，适合服务器环境或多个客户端共享。

> 浏览器服务现已支持 **Windows**（Playwright Chromium 原生运行于 win32）。

## 系统要求

- macOS 10.15+ / Linux (Debian 12+、Ubuntu 等) / Windows 10+
- **Node.js >= 20**
- HTTP 模式额外需要 PM2（`npm install -g pm2`）；stdio 模式不需要

## 服务一览

| 服务 | 传输 | 端口（仅 HTTP 模式） | PM2 配置 | 说明 |
|------|------|------|----------|------|
| Browser MCP（有头） | stdio / HTTP | 3213 | `ecosystem.config.cjs` | 可视化浏览器，桌面调试 |
| Browser MCP（无头） | stdio / HTTP | 3215 | `ecosystem.headless.cjs` | 无头，服务器 / SSH 环境 |
| Database MCP | stdio / HTTP | 3214 | `mcp-database/ecosystem.config.cjs` | PostgreSQL / MySQL |

> 有头与无头使用**同一套源码**，通过 `HEADLESS` 环境变量切换。
> stdio 模式下浏览器是否有头由各自的环境变量决定，不占用端口。

---

## 一、安装

跨平台统一入口是 `mcp.mjs`（纯 Node，无依赖），在三个平台上行为一致：

```bash
# macOS / Linux / Windows 通用
node mcp.mjs install
```

该命令会为浏览器目录和数据库目录依次执行：`npm install` → `npx playwright install chromium` → `npm run build`。

### 平台原生脚本（可选）

如不想用 Node CLI，也可使用各平台原生安装脚本：

```bash
# macOS / Linux
bash install-all.sh

# Windows (PowerShell)
.\install-all.ps1
```

---

## 二、推荐用法：stdio 原生模式（无需 PM2 / 端口）

Claude Code 会直接以子进程方式拉起 MCP 服务，最简单可靠。

### 方式 1：`claude mcp add` 命令

获取适配你机器的命令：

```bash
node mcp.mjs config
```

它会打印类似以下命令（路径为绝对路径）：

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

- macOS / Linux 路径形如 `/Users/you/local-mcp/claude/...`
- Windows 路径形如 `C:\\Users\\you\\local-mcp\\claude\\...`（JSON 中反斜杠需转义为 `\\`）
- `--stdio` 参数或 `MCP_TRANSPORT=stdio` 环境变量都可触发 stdio 模式

数据库连接信息仍通过 `mcp-database/.env` 配置（见下文「数据库配置」）。

---

## 三、HTTP / PM2 模式（服务器或多客户端共享）

服务以 PM2 长驻进程方式运行，多个客户端可共享同一服务。

### 启动 / 停止 / 状态

```bash
# 跨平台 Node CLI（推荐）
node mcp.mjs start          # 启动全部 (browser + db)
node mcp.mjs start browser  # 仅启动浏览器
node mcp.mjs start db       # 仅启动数据库
node mcp.mjs stop           # 停止
node mcp.mjs restart        # 重启
node mcp.mjs status         # 查看 PM2 状态
```

平台原生方式：

```bash
# macOS / Linux —— 交互式菜单或命令行
bash manage.sh
bash manage.sh start

# Windows (PowerShell)
.\manage.ps1            # 交互式菜单
.\manage.ps1 start
.\manage.ps1 status

# Windows (CMD) —— start.bat / stop.bat 委托给 mcp.mjs
start.bat
stop.bat
```

直接用 PM2：

```bash
pm2 start ecosystem.headless.cjs            # 无头浏览器  (3215)
pm2 start ecosystem.config.cjs              # 有头浏览器  (3213)
pm2 start mcp-database/ecosystem.config.cjs # 数据库      (3214)
```

### 注册 HTTP 端点到 Claude Code

```bash
claude mcp add --transport http browser-headless http://localhost:3215/mcp
claude mcp add --transport http browser-headed   http://localhost:3213/mcp
claude mcp add --transport http database          http://localhost:3214/mcp
```

或编辑 `~/.config/claude-code/mcp.json`：

```json
{
  "mcpServers": {
    "browser-headless": { "type": "http", "url": "http://localhost:3215/mcp" },
    "browser-headed":   { "type": "http", "url": "http://localhost:3213/mcp" },
    "database":         { "type": "http", "url": "http://localhost:3214/mcp" }
  }
}
```

> 服务器 / SSH 环境通常只需无头浏览器 + 数据库；桌面环境可再加有头浏览器。

---

## 四、`mcp.mjs` 子命令一览

| 子命令 | 说明 |
|--------|------|
| `node mcp.mjs install` | 安装依赖 + Chromium + 构建（浏览器 + 数据库） |
| `node mcp.mjs start [browser\|db\|all]` | 通过 PM2 启动服务（默认 all） |
| `node mcp.mjs stop [browser\|db\|all]` | 停止服务 |
| `node mcp.mjs restart [browser\|db\|all]` | 重启服务 |
| `node mcp.mjs status` | 查看 PM2 进程状态 |
| `node mcp.mjs config` | 打印 stdio 与 HTTP 两种配置命令 |
| `node mcp.mjs --help` | 显示帮助 |

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

> HTTP / PM2 模式下修改 `.env` 后需 `node mcp.mjs restart db` 生效。

---

## 六、脚本说明

| 文件 | 平台 | 说明 |
|------|------|------|
| `mcp.mjs` | 全平台 | **跨平台主入口**：安装 / 启停 / 配置 |
| `install-all.sh` / `install.sh` | macOS / Linux | 一键安装（bash 原生回退） |
| `manage.sh` | macOS / Linux | 交互式服务管理 |
| `mcp-all-manage.sh` | macOS / Linux | 总管理脚本（浏览器 + 数据库） |
| `check-mcp-health.sh` | macOS / Linux | HTTP 模式健康检查 |
| `diagnose.sh` | macOS / Linux | 安装 / 运行环境诊断 |
| `install-all.ps1` | Windows | 一键安装（PowerShell 原生） |
| `manage.ps1` | Windows | 服务管理（PowerShell 原生） |
| `start.bat` / `stop.bat` | Windows | CMD 入口，委托给 `mcp.mjs` |
| `.mcp.json.example` | — | 项目级 stdio 配置模板 |

---

## 七、浏览器 MCP 工具（38 个）

导航、点击、填表、截图、多标签页管理、Cookie 操作、JS 执行、
网络拦截、PDF 导出、元素提取、页面爬取、拖拽、键盘输入、
无障碍快照（snapshot）、正文提取（extract_article）等。
完整清单见仓库根目录 `USAGE.md`。

## 八、数据库 MCP 工具（15 个）

SQL 查询、表结构查看、索引分析、外键关系、数据导出（CSV）、多数据库切换等。
完整清单见仓库根目录 `USAGE.md`。

---

## 九、故障排查

```bash
# 环境诊断 (macOS / Linux)
bash diagnose.sh

# HTTP 模式健康检查
bash check-mcp-health.sh        # macOS / Linux
node mcp.mjs status             # 全平台

# 查看 PM2 日志
pm2 logs claudemcp-headless --lines 50
pm2 logs claudemcp-database --lines 50

# 检查端口 (HTTP 模式)
ss -tlnp | grep -E '3213|3214|3215'      # Linux
lsof -i :3213,3214,3215                  # macOS
netstat -ano | findstr "3213 3214 3215"  # Windows
```

- **stdio 模式不占用端口**，端口检查仅对 HTTP / PM2 模式有意义。
- stdio 模式下若工具不可用，先 `node mcp.mjs install` 确认 `dist/server.js` 已构建，
  再用 `claude mcp list` 检查注册状态。
