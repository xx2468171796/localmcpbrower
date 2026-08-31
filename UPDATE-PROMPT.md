# AI 升级提示词(直接从 Gitea 拉取)

> 把下面**分隔线之间的整段**贴给目标机器上的 AI(Claude Code / Codex),它会全自主完成安装或升级。
> 不依赖 ankottipublic,只认这一个仓库 —— 任意机器可用。

---

请把这台机器的**浏览器 MCP 与数据库 MCP** 升级到最新版(MCP SDK v2 + pipe 传输)。
**全自主做完,别反复问我**;做完用大白话给我一张「装了啥 / 升了啥 / 我该注意啥」清单。

> 💻 **先判断本机是 Windows / macOS / Linux,命令按系统适配**(Windows 用 PowerShell 等价写法:
> `~` → `$env:USERPROFILE`,无 `chmod`)。`node` / `git` / `pm2` 三端通用,**别照抄不适配**。
> 前置:**Node 24**(公司标准栈最低版本);没有 pm2 就 `npm i -g pm2`。

## ⚠️ 这次是大版本升级,三个坑先说在前面

**① 必须重装依赖,不能只 `git pull`。**
本次从 `@modelcontextprotocol/sdk` v1 换成了 `@modelcontextprotocol/{core,server,client,node,express}` v2,
**包名全变了**。旧 `node_modules` 留着会让构建拿到过期依赖。

**② 两个包要分别构建。**
`mcp-database` 有**自己的 tsconfig**,主包 `npm run build` **不会**带上它。
只构建主包的话,数据库服务跑的还是旧 dist —— 表现是「浏览器好了,数据库连不上」,很难查。

**③ 注册方式变了:HTTP → stdio + shim。**
旧的 `claude mcp add --transport http ... :3215/mcp` 仍然能用(HTTP 腿保留着),
但**新的会话管理走 pipe**,要按下面第 3 步重新注册才拿得到。

## 1. 拉代码

```bash
# 没有就克隆
git clone http://192.168.110.246:3001/xuan/localmcpbrower.git ~/code/localmcpbrower
# 已有就更新
cd ~/code/localmcpbrower && git pull --ff-only
```

## 2. 重装 + 构建(**两个包都要**)

```bash
cd ~/code/localmcpbrower/claude

# ① 清掉 v1 残留 —— 这一步不能省
rm -rf node_modules package-lock.json
npm install

# ② 主包(浏览器)
npm run build

# ③ 数据库包 —— 独立 tsconfig,必须单独来
cd mcp-database && npm install && npm run build && cd ..

# ④ 确认 v1 已清干净(应该只列出 client/core/express/node/server)
ls node_modules/@modelcontextprotocol
```

首次安装(这台机从没装过)还要下载 Chromium:

```bash
node mcp.mjs install
```

> **仅 Linux** 若缺系统库,按提示让我本人在终端补一次(要 sudo,只此一次):
> `cd ~/code/localmcpbrower/claude && sudo npx patchright install-deps chromium`
> **Linux 无图形界面**时有头浏览器会自动降级为无头并告警,不会启动失败。

## 3. 起服务 + 注册客户端

```bash
node mcp.mjs start              # PM2 拉起三个服务
node mcp.mjs autostart --apply  # 开机自启(平台自适应)
```

注册**改用 shim**(把绝对路径换成本机真实路径):

```bash
# Claude Code
claude mcp remove browser -s user; claude mcp remove browser-headed -s user; claude mcp remove database -s user
claude mcp add browser        -s user -- node <绝对路径>/claude/bin/shim.mjs headless
claude mcp add browser-headed -s user -- node <绝对路径>/claude/bin/shim.mjs headed
claude mcp add database       -s user -- node <绝对路径>/claude/bin/shim.mjs db
```

Codex 改 `~/.codex/config.toml`(⚠️ Windows 路径用 **TOML 字面量字符串**,即单引号,
否则 `"D:\nodejs\node.exe"` 里的 `\n` 会被当成换行):

```toml
[mcp_servers.browser]
command = 'D:\nodejs\node.exe'
args = ['C:\...\claude\bin\shim.mjs', 'headless']
type = "stdio"
startup_timeout_sec = 30
```

## 4. 校验(必须做,别只看命令有没有报错)

```bash
cd ~/code/localmcpbrower/claude && node mcp.mjs status
```

期望 `claudemcp-browser`(3213)/ `claudemcp-headless`(3215)/ `claudemcp-database`(3214)均 **online**,
且日志里每个服务都有一行 `[Pipe] 监听 ...`。

再做真实握手校验(比看进程状态可靠,能确认工具数):

```bash
cd ~/code/localmcpbrower/claude && node -e "
(async () => {
const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
const SHIM = process.cwd() + '/bin/shim.mjs';
for (const [name, svc, want] of [['浏览器','headless',46],['有头','headed',46],['数据库','db',15]]) {
  try {
    const c = new Client({name:'probe',version:'1'}, {capabilities:{elicitation:{}}});
    await c.connect(new StdioClientTransport({command: process.execPath, args:[SHIM, svc]}));
    const n = (await c.listTools()).tools.length;
    console.log((n===want?'[OK]  ':'[FAIL]') + ' ' + name + ' ' + svc + ' 工具 ' + n + '/' + want);
    await c.close();
  } catch (e) { console.log('[FAIL] ' + name + ' -> ' + (e.message||e)); }
}
})();"
```

**三行都是 `[OK]` 才算成功。** 若 `[FAIL]`,**不要硬切**:先 `pm2 logs --lines 50` 看原因,
把错误告诉我。旧的 HTTP 注册还留着,随时能退回去。

## 5. 绝对不要做的事(踩了要返工)

- **Windows 不要注册成系统服务**(「不管用户是否登录都运行」)。必须用户级自启,
  否则进程落在 Session 0,有头浏览器窗口永久不可见。`node mcp.mjs autostart --apply` 已正确处理。
- **不要绑 `0.0.0.0`**。默认只绑 `127.0.0.1`。浏览器里存着已登录的公司系统会话,
  裸端口等于把控制权交出去。确需跨机必须同时配 `MCP_AUTH_TOKEN` 与 `MCP_ALLOWED_HOSTS`,
  少一个要么不安全要么连不上(SDK 有 DNS rebinding 防护,只改 HOST 会一律 403)。
- **不要改有头/无头各自的 `USER_DATA_DIR`**。两个服务共用一份 profile 会抢锁,必有一个起不来。
- **不要把 pipe 腿的 `legacy` 改成 `'reject'`**。看着像"只收新协议更干净",实则
  **客户端在 stdio 上不探测新协议**,改了会让所有工具直接连不上(`-32022`)。
- **改了 PM2 配置后不要 `pm2 restart <进程名>`**,那样复用缓存的旧环境变量;用 `node mcp.mjs restart`。

## 6. 收尾

**提醒我**:Claude Code 里输入 `/mcp` 重连(或重开窗口)、Codex 重启,新工具才生效。
然后给我那张大白话清单。

---

## 附:这次改了什么(讲给我听时用得上)

**协议与 SDK**:换到 MCP SDK v2,v1 完全移除。服务端**新旧协议双线都支持**;
日常实际仍走 `2025-11-25`(客户端在 stdio 上不探测新协议),**客户端哪天升级会自动走新的,不用再改**。

**修好了三个一直坏着、但不报错的东西**(不是本次迁移引入的,是一直如此):

- **反爬指纹伪装整段从未执行** —— `navigator.webdriver` 一直暴露、`window.chrome` 不存在、
  plugins 为空,**爬公网站点基本会被当成机器人**
- `get_console_logs` 恒返回空数组 —— 页面报错完全看不到
- `snapshot` 的 `deep:true` 静默失效 —— 与 `deep:false` 输出逐字节相同

**新增两个工具**(44 → 46):

- `wait_for_human` —— 阻塞等人在可见窗口里扫码/过验证码,靠盯页面变化判断完成,**不弹窗**,
  在全自主(bypassPermissions)模式下照常工作
- `request_human` —— 走协议 elicitation 弹窗。⚠️ 在 bypassPermissions 下会被客户端**自动拒绝**
  且界面无提示,那种模式下请用 `wait_for_human`

**长任务有进度了**:`crawl_pages`(最多 50 页)、`batch_fetch` 现在会实时上报进度,不再是黑盒。

**跨平台**:`killPortProcess` 原本是纯 Windows 实现,Linux/macOS 上端口被占清不掉,现已三平台各有实现。

**会话行为**(与上一版不同,注意):

- **浏览器默认共享** —— 所有窗口看到同一批标签页,任何窗口都能接管别的窗口开的页面;
  有头浏览器里**人手动打开**的页面 AI 也直接可见。要各窗口互不干扰设 `PIPE_ISOLATED=1`
- **数据库默认隔离** —— 各窗口「当前连的是哪个库」互相独立。
  这里不跟浏览器一致是刻意的:共享的话 B 窗口一句 `switch_db('prod')`
  会让 A 窗口后续的 SQL 全跑到生产库上,**浏览器串台最多拿错数据,数据库串台可能写错库**
- 登录态(cookie)**始终共享**,与上面两个开关无关 —— 登录一次全部通用

**稳定性**:浏览器窗口被关/崩溃 → 下次调工具约 1 秒自动重开;服务进程挂 → PM2 重启;
整机重启 → 开机自启恢复。以前**关一个标签页就可能把整个服务连同浏览器和登录态干掉**,已修。
