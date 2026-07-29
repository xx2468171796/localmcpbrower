# AI 部署手册(Runbook)

> **读者是 AI 助手,不是人。** 面向人的详解见 [`DEPLOY.md`](./DEPLOY.md);本文件是**可直接执行的部署流程**,每步带可自检的预期输出。
>
> 本项目提供两个 MCP 服务:**浏览器 MCP(44 工具)** 与 **数据库 MCP(15 工具)**,推荐以 **HTTP 常驻**形态部署(v3 起),stdio 为备用形态。

---

## 0. 不可违背的约束(先读,踩了要返工)

| # | 约束 | 违反后果 |
|---|---|---|
| 1 | **Windows 严禁把服务注册成系统服务**(「不管用户是否登录都运行」) | 进程落在 Session 0,有头浏览器窗口永久不可见,人工接管登录/验证码无从谈起。必须用**用户级自启** |
| 2 | **有头与无头必须各自独立 `USER_DATA_DIR`** | 两个 Chromium 抢同一个 profile 锁,必有一个起不来(仓库自带的 ecosystem 配置已分开,不要改掉) |
| 3 | **PM2 重启必须传 ecosystem 文件路径,不能传进程名** | 按名字重启会复用 dump 里缓存的 `pm2_env`,**改了 HOST/PORT/USER_DATA_DIR 一律不生效** |
| 4 | **ecosystem 文件名后缀只能是** `.json`/`.yml`/`.yaml`/`.config.js`/`.config.cjs`/`.config.mjs` | 其它后缀会被 PM2 当**普通脚本**执行,进程名与 env 全错(本项目历史上踩过) |
| 5 | **绑定非回环地址时必须设 `MCP_AUTH_TOKEN`** | 服务默认只绑 `127.0.0.1`;绑 `0.0.0.0` 而不设 token 会被 fail-fast 拒绝启动(这是有意设计,不要绕过)。浏览器里存着**已登录的会话**,裸端口等于交出控制权 |
| 6 | **跨机访问必须同时配 `MCP_ALLOWED_HOSTS`** | SDK 有 DNS rebinding 防护,只改 HOST 不配白名单会一律 403,表现为"配了却连不上" |
| 7 | **不要 `npm install` 就以为依赖最新** | `package-lock.json` 会锁版本,范围内的新版需要 `npm update` 才会拿到 |

---

## 1. 前置检查

```bash
node -v          # 需 >= 20
git --version
pm2 -v           # 没有则: npm i -g pm2
```

**平台自适应**:后续命令中 `mcp.mjs` 会自行按平台分流(Windows / macOS / Linux),**无需手动选择分支**。

---

## 2. 部署流程

### 2.1 获取代码

```bash
git clone http://192.168.110.246:3001/xuan/localmcpbrower.git ~/code/localmcpbrower
cd ~/code/localmcpbrower/claude
```

> 已存在则改用 `git pull --ff-only`。凭据走用户的 Gitea 身份。

### 2.2 安装(装依赖 + 下载 Chromium + 构建)

```bash
node mcp.mjs install
```

**验证门**:两个 `dist/server.js` 必须存在。

```bash
test -f dist/server.js && test -f mcp-database/dist/server.js && echo OK
```

失败时:`npm install` 的网络问题会自动切 npmmirror 镜像;Linux 缺系统库时按提示执行一次
`sudo npx patchright install-deps chromium`(需要 sudo,只此一次,Mac/Windows 不需要)。

### 2.3 启动三个常驻服务

```bash
node mcp.mjs start
```

**预期输出**(三个都必须 `online`,且健康检查三个 `[✓]`):

```
│ claudemcp-browser   │ online │   ← 有头,端口 3213
│ claudemcp-database  │ online │   ← 数据库,端口 3214
│ claudemcp-headless  │ online │   ← 无头,端口 3215

── 端点健康检查
  [✓] 无头浏览器 MCP (3215)  http://127.0.0.1:3215/mcp
  [✓] 有头浏览器 MCP (3213)  http://127.0.0.1:3213/mcp
  [✓] 数据库 MCP (3214)      http://127.0.0.1:3214/mcp
```

> **无显示环境(Linux 服务器 / SSH)**:有头服务会自动降级为无头并告警,不会启动失败。
> 若只想跑无头:`node mcp.mjs start headless`。

### 2.4 注册到客户端

```bash
node mcp.mjs config      # 打印适配本机的注册命令
```

**Claude Code**:

```bash
claude mcp add --transport http browser        http://127.0.0.1:3215/mcp
claude mcp add --transport http browser-headed http://127.0.0.1:3213/mcp
claude mcp add --transport http database       http://127.0.0.1:3214/mcp
```

或直接写配置(`~/.claude.json` 的 `mcpServers`,或项目级 `.mcp.json`):

```jsonc
{
  "mcpServers": {
    "browser":        { "type": "http", "url": "http://127.0.0.1:3215/mcp" },
    "browser-headed": { "type": "http", "url": "http://127.0.0.1:3213/mcp" },
    "database":       { "type": "http", "url": "http://127.0.0.1:3214/mcp" }
  }
}
```

> **改完配置必须让客户端重连**:Claude Code 里执行 `/mcp`,或重开窗口。Codex 需重启。

### 2.5 开机自启(平台自适应)

```bash
node mcp.mjs autostart            # 只看指引,不改本机
node mcp.mjs autostart --apply    # 真正落地
```

自动分流:Windows → 用户级启动文件夹(`pm2 resurrect`);macOS → launchd;Linux → systemd。
macOS/Linux 下 `pm2 startup` 会打印一条 `sudo ...` 命令,**需要人工执行一次**。

---

## 3. 验证清单(部署后逐条跑)

```bash
# ① 三服务在线
node mcp.mjs status

# ② 端口只绑回环(不应出现 0.0.0.0,除非有意跨机且已配 token)
#    Windows: netstat -ano | findstr "3213 3214 3215"
#    Linux/mac:
ss -ltnp 2>/dev/null | grep -E ':(3213|3214|3215)' || netstat -an | grep -E '\.(3213|3214|3215) '

# ③ 健康检查(自动跟随 HOST/PORT 环境变量)
bash check-mcp-health.sh
```

**④ 真实 MCP 握手验证**(最可靠,能确认工具数正确):

```bash
node -e "
const eps=[['无头',3215,44],['有头',3213,44],['数据库',3214,15]];
for(const [n,p,want] of eps){
  const base=\`http://127.0.0.1:\${p}/mcp\`;
  const h={'Content-Type':'application/json',Accept:'application/json, text/event-stream'};
  const parse=async r=>{const ct=r.headers.get('content-type')||'';const b=await r.text();
    if(ct.includes('event-stream')){const d=b.split('\n').filter(l=>l.startsWith('data:')).pop();return d?JSON.parse(d.slice(5)):null;}
    return JSON.parse(b);};
  try{
    const r=await fetch(base,{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'probe',version:'1'}}})});
    const sid=r.headers.get('mcp-session-id'); const m=await parse(r);
    const h2={...h,'mcp-session-id':sid};
    await fetch(base,{method:'POST',headers:h2,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}})});
    const r2=await fetch(base,{method:'POST',headers:h2,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}})});
    const n2=((await parse(r2))?.result?.tools||[]).length;
    console.log(\`\${n2===want?'[OK]':'[FAIL]'} \${n} :\${p} \${m?.result?.serverInfo?.version} 工具 \${n2}/\${want}\`);
    await fetch(base,{method:'DELETE',headers:h2});
  }catch(e){console.log(\`[FAIL] \${n} :\${p} -> \${e.message}\`);}
}"
```

**⑤ 自启验证**(不必真重启):

```bash
pm2 kill && pm2 resurrect && node mcp.mjs status
```

Windows 另需确认自启脚本是**纯 ASCII**(cmd.exe 按 OEM 代码页解析,混入中文会乱码):

```bash
node -e "const b=require('fs').readFileSync(process.env.APPDATA+'/Microsoft/Windows/Start Menu/Programs/Startup/claudemcp-autostart.cmd');console.log('非ASCII字节:',[...b].filter(x=>x>127).length)"
# 期望输出 0
```

---

## 4. 会话隔离语义(部署后要向用户说明)

| 层级 | 粒度 | 触发 | 效果 |
|---|---|---|---|
| **会话 → 标签页** | 自动 | 客户端连上即分配 | 多窗口并行互不抢页;**共享登录态** |
| **Space → 上下文** | 显式 `space_new` | 需要隔离 cookie 时 | 独立 profile,多账号互不干扰 |

- 每个会话独立:标签页、console/network 缓冲、`set_block_rules`、数据库当前库指针
- 同一 space 内的会话**共享 cookie/登录态**(这是设计意图,不是 bug)
- 数据库:`connect`/`switch_db`/`disconnect` 只改**调用方会话**的指针,不影响其他窗口

---

## 5. 故障 → 处置

| 现象 | 原因 | 处置 |
|---|---|---|
| 端点连不上,PM2 显示 online | 浏览器冷启动未完成 | 等 10~30s 再探;`pm2 logs <name>` 看进度 |
| `pm2 list` 出现名为 `ecosystem.headless` 的 errored 进程 | 用了旧文件名(后缀不被 PM2 认) | `pm2 delete ecosystem.headless`,改用 `ecosystem.headless.config.cjs` |
| 改了 ecosystem 的 HOST/PORT 却不生效 | 按进程名重启复用了缓存 env | 用 `node mcp.mjs restart`(内部传 ecosystem 文件),或 `pm2 delete <name>` 后重新 start |
| 跨机配置后一律 403 | 缺 DNS rebinding 白名单 | 设 `MCP_ALLOWED_HOSTS=<对外host:port>`,与 `HOST`、`MCP_AUTH_TOKEN` 三件一起配 |
| 有头服务起了但看不见窗口 | 注册成了系统服务(Session 0) | 改用用户级自启;删掉系统服务 |
| 启动报 profile 锁失败 | 上次的 chromium 变孤儿 | `pm2 delete all` 后确认无残留 chromium 再 start |
| 端口被占清不掉 | — | `node mcp.mjs stop` 后手工查占用进程 |
| `space_new` 后旧登录态"丢了" | v3 起 space 目录规则改为 `<userDataDir>-spaces/<name>` | 数据没丢,在旧 `storage/spaces/<name>`;手工搬过去或忽略 |

---

## 6. 升级 / 回滚 / 卸载

```bash
# 升级(拉代码 + 重装依赖 + 校验 Chromium + 重建 + 重启在跑的服务)
node mcp.mjs update

# 依赖拿最新(注意:npm install 受 lock 锁定,不会升范围内新版)
cd claude && npm update && npm run build
cd mcp-database && npm update && npm run build

# 回滚到 stdio 形态(HTTP 出问题时的退路)
node mcp.mjs config          # 里面同时给出 stdio 注册写法
# 客户端配置改成: {"command":"node","args":["<绝对路径>/claude/dist/server.js","--stdio"]}

# 卸载
node mcp.mjs stop
pm2 delete claudemcp-browser claudemcp-headless claudemcp-database
# Windows 另删: %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\claudemcp-autostart.cmd
```

---

## 7. 跨机共享(默认关闭,需显式开启)

三件事**必须一起做**,少一件就连不上或不安全:

```bash
# ecosystem 配置的 env 里:
HOST: '0.0.0.0'                              # ① 监听对外地址
MCP_AUTH_TOKEN: '<足够长的随机串>'             # ② 无此项会 fail-fast 拒绝启动
MCP_ALLOWED_HOSTS: '192.168.1.10:3215'       # ③ 否则 DNS rebinding 防护一律 403
```

客户端侧需带 `Authorization: Bearer <token>`。

> **多用户共享的登录态问题**:当前 `resolveSpace()` 恒返回 `default`,即所有人共享同一份 cookie。
> 真正多人使用前必须改成「按身份返回独立 space」,否则 A 的公司系统会话 B 能直接用。
> 代码里已预留该映射点(`browser.ts` 的 `resolveSpace`),见 [`HTTP-DESIGN.md`](./HTTP-DESIGN.md) §8.2。

---

## 8. 交接状态自检片段

接手时先跑这段,一次看清全貌:

```bash
cd ~/code/localmcpbrower && echo "版本: $(git log --oneline -1)" && \
echo "落后远端: $(git fetch -q origin; git rev-list --count HEAD..origin/master)" && \
node claude/mcp.mjs status
```

---

## 9. 已知缺陷(部署无关,勿误判为部署失败)

- **`get_console_logs` 抓不到页面日志**:`patchright` 禁用 CDP Console 域后,`exposeBinding` 旁路当前失效。
  **改造前就存在**,已用改造前版本对照确认。影响 `get_console_logs` 与 `generate_page_report`,其余工具不受影响。
