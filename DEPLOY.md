# 部署指南（新机器 / 多机部署）

把这套 MCP 服务部署到一台新机器（macOS / Linux / Windows 通用）。
**每台要用的机器执行一次即可**，之后所有项目自动可用。

> MCP 注册写的是**本机绝对路径**，不会跟着仓库同步到别的机器 —— 所以每台机器都要单独跑一遍下面的步骤。

---

## 前置要求

- **Node.js >= 20**（`node -v` 确认）
- **git**
- **Claude Code** 已安装（`claude` 命令可用）

---

## 部署步骤

### 1. 克隆仓库

```bash
git clone https://github.com/xx2468171796/localmcpbrower
cd localmcpbrower/claude
```

> 放在一个**长期固定**的目录（不要放 `/tmp` 等临时目录），注册后路径不能再变动。

### 2. 安装

```bash
node mcp.mjs install
```

一条命令完成：浏览器 + 数据库依赖安装、Chromium 下载、TypeScript 构建。三平台行为一致。

- **Linux**：会自动用 `--with-deps` 安装 Chromium 所需系统库（`libnss3` 等），可能需要 `sudo` 权限。
- **Windows**：直接可用；也可改用 `install-all.ps1`（PowerShell）。

### 3. 注册到 Claude Code

```bash
node mcp.mjs config
```

它会打印出**本机专属**的 `claude mcp add` 命令，复制执行即可。形如：

```bash
claude mcp add browser -- node "<本机绝对路径>/claude/dist/server.js" --stdio
claude mcp add database -e MCP_TRANSPORT=stdio -- node "<本机绝对路径>/claude/mcp-database/dist/server.js" --stdio
```

> 默认 **stdio 模式 + 用户级（user scope）**：注册一次，**所有项目、所有目录**的 Claude Code 会话都自动加载，无需再配置。

### 4. 验证

```bash
claude mcp list
```

看到 `browser` 和 `database` 显示 **✓ Connected** 即成功。新开一个 Claude Code 会话即可使用。

---

## 平台说明

| 平台 | 浏览器模式 | 备注 |
|------|-----------|------|
| **Linux**（服务器 / SSH） | **默认无头**，零配置 | `headless` 默认开启，无需 GUI |
| **Windows** | 默认无头 | JSON 配置里路径反斜杠需转义 `\\` |
| **macOS** | 默认无头 | 想看浏览器界面：注册时加 `-e HEADLESS=false` |

---

## 接入其他 MCP 客户端（Codex CLI / Cursor 等）

本服务用的是 **MCP 标准 stdio 传输**，不是 Claude 专属 —— 任何支持 MCP 的客户端都能连**同一个** `dist/server.js`。依赖、构建产物、Chromium **完全复用**，无需为每个客户端重装；多个客户端可同时各自连接。区别只在各家配置文件格式不同。

### Codex CLI（OpenAI）

配置文件 `~/.codex/config.toml`（**TOML** 格式）。

命令行方式：

```bash
codex mcp add browser -- node <绝对路径>/claude/dist/server.js --stdio
codex mcp add database --env MCP_TRANSPORT=stdio -- node <绝对路径>/claude/mcp-database/dist/server.js --stdio
```

或直接编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.browser]
command = "node"
args = ["<绝对路径>/claude/dist/server.js", "--stdio"]

[mcp_servers.database]
command = "node"
args = ["<绝对路径>/claude/mcp-database/dist/server.js", "--stdio"]
env = { MCP_TRANSPORT = "stdio" }
```

### Cursor / Windsurf / Cline 等

使用 JSON 配置（如 Cursor 的 `.cursor/mcp.json`），格式与本仓库 [`claude/.mcp.json.example`](./claude/.mcp.json.example) 一致：

```json
{
  "mcpServers": {
    "browser":  { "command": "node", "args": ["<绝对路径>/claude/dist/server.js", "--stdio"] },
    "database": { "command": "node", "args": ["<绝对路径>/claude/mcp-database/dist/server.js", "--stdio"], "env": { "MCP_TRANSPORT": "stdio" } }
  }
}
```

### 各客户端对照

| 客户端 | 配置文件 | 格式 | 添加命令 |
|--------|----------|------|----------|
| Claude Code | `~/.claude.json` / 项目 `.mcp.json` | JSON | `claude mcp add` |
| Codex CLI | `~/.codex/config.toml` | TOML | `codex mcp add` |
| Cursor | `.cursor/mcp.json` | JSON | 手动编辑 |
| Windsurf / Cline 等 | 各自的 MCP 配置文件 | JSON | 手动编辑 |

> `<绝对路径>` 用 `node mcp.mjs config` 可一键获取本机路径。Windows 上 JSON 里的反斜杠需转义为 `\\`。

---

## 运维特性（stdio 模式 —— 无需操心）

stdio 模式下服务进程由 **Claude Code 自己管理**，因此天然满足"不掉线、自动开启"：

- **自动启动** —— 每次新开 Claude Code 会话自动拉起，**无需 PM2、无需开机自启**。
- **不掉线** —— 进程意外退出时 Claude Code 会重启；浏览器崩溃时下次调用自动重建。
- **自动回收** —— 会话结束进程自动关闭，不留僵尸进程。

> 仅当使用 **HTTP 模式**（多机共享 / 长驻服务）时才需要 PM2 保活，见 [`claude/README.md`](./claude/README.md)。

---

## 数据库配置（可选）

数据库 MCP 可在启动时自动连库 —— 复制并编辑 `claude/mcp-database/.env`：

```bash
cp claude/mcp-database/.env.example claude/mcp-database/.env
# 填入 DB_TYPE / DB_HOST / DB_PORT / DB_NAME / DB_USER / DB_PASSWORD
```

不配也行：运行时让 Claude 用 `connect` 工具按需连接。

---

## 升级 / 卸载

```bash
# 升级：拉取最新代码后重新安装
git pull && node mcp.mjs install

# 卸载：移除 Claude Code 注册
claude mcp remove browser -s user
claude mcp remove database -s user
```
