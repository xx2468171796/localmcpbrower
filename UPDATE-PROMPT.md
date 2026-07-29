# AI 升级提示词(直接从 Gitea 拉取)

> 把下面**分隔线之间的整段**贴给目标机器上的 AI(Claude Code / Codex),它会全自主完成安装或升级。
> 不依赖 ankottipublic,只认这一个仓库 —— 任意机器可用。

---

请把这台机器的**浏览器 MCP 与数据库 MCP** 安装/升级到最新版,并以 **HTTP 常驻**形态运行。**全自主做完,别反复问我**;做完用大白话给我一张「装了啥 / 升了啥 + 我该注意啥」清单。

> 💻 **先判断本机是 Windows / macOS / Linux,命令按系统适配**(Windows 用 PowerShell 等价写法:`~` → `$env:USERPROFILE`,无 `chmod`)。`node` / `git` / `pm2` 三端通用,**别照抄不适配**。
> 前置:Node ≥ 20;没有 pm2 就 `npm i -g pm2`。

## 1. 从 Gitea 拉代码

仓库:`http://192.168.110.246:3001/xuan/localmcpbrower.git`(凭据用公司发我的 Gitea 账号)

```bash
# 没有就克隆
git clone http://192.168.110.246:3001/xuan/localmcpbrower.git ~/code/localmcpbrower
# 已有就更新
cd ~/code/localmcpbrower && git pull --ff-only
```

## 2. 照仓库自带的部署手册做

拉下来后**先读 `~/code/localmcpbrower/AI-DEPLOY.md`** —— 那是给 AI 执行的完整 Runbook(每步带自检、含不可违背的约束、故障处置表),按它做即可。核心就三条命令:

```bash
cd ~/code/localmcpbrower/claude
node mcp.mjs install          # 装依赖 + 下载 Chromium + 构建
node mcp.mjs start            # 拉起 PM2 常驻服务
node mcp.mjs autostart --apply  # 配开机自启(平台自适应)
```

> **Linux 无图形界面**时有头浏览器会自动降级为无头并告警,不会启动失败;只想跑无头用 `node mcp.mjs start headless`。
> **仅 Linux** 若缺系统库,按提示让我本人在终端补一次(要 sudo,只此一次):
> `cd ~/code/localmcpbrower/claude && sudo npx patchright install-deps chromium`

## 3. 注册到客户端

```bash
node mcp.mjs config     # 打印适配本机的注册命令,照它执行
```

等价于:

```bash
claude mcp add --transport http browser  http://127.0.0.1:3215/mcp -s user
claude mcp add --transport http database http://127.0.0.1:3214/mcp -s user
# Codex:
codex mcp add browser  --url http://127.0.0.1:3215/mcp
codex mcp add database --url http://127.0.0.1:3214/mcp
```

**若这台机器以前是 stdio 形态**:上面的 `mcp add` 会覆盖同名旧条目;确认新条目是 `http` 型即可,不用手动删。

## 4. 校验(必须做,别只看命令有没有报错)

```bash
cd ~/code/localmcpbrower/claude && node mcp.mjs status
```

期望 `claudemcp-headless`(3215)与 `claudemcp-database`(3214)均为 **online**。

再做一次真实握手校验(比看进程状态可靠,能确认工具数):

```bash
node -e "
for (const [n,p,want] of [['浏览器',3215,44],['数据库',3214,15]]) {
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
    const c=((await parse(r2))?.result?.tools||[]).length;
    console.log(\`\${c===want?'[OK]':'[FAIL]'} \${n} :\${p} v\${m?.result?.serverInfo?.version} 工具 \${c}/\${want}\`);
    await fetch(base,{method:'DELETE',headers:h2});
  }catch(e){console.log(\`[FAIL] \${n} :\${p} -> \${e.message}\`);}
}"
```

**两行都是 `[OK]` 才算成功。** 若是 `[FAIL]`,**不要硬切**:先 `pm2 logs --lines 50` 看原因;仍搞不定就退回 stdio 形态保证可用(`node mcp.mjs config` 里有 stdio 写法),把错误告诉我。

## 5. 绝对不要做的事(踩了要返工)

- **Windows 不要注册成系统服务**(「不管用户是否登录都运行」)。必须用户级自启,否则进程落在 Session 0,有头浏览器窗口永久不可见。`node mcp.mjs autostart --apply` 已正确处理,别自作主张改。
- **不要绑 `0.0.0.0`**。默认只绑 `127.0.0.1`。浏览器里存着我已登录的公司系统会话,裸端口等于把控制权交出去。确需跨机必须同时配 `MCP_AUTH_TOKEN` 与 `MCP_ALLOWED_HOSTS`,少一个要么不安全要么连不上(SDK 有 DNS rebinding 防护,只改 HOST 会一律 403)。
- **不要改有头/无头各自的 `USER_DATA_DIR`**。两个服务共用一份 profile 会抢锁,必有一个起不来。
- **改了 PM2 配置后不要 `pm2 restart <进程名>`**,那样复用缓存的旧环境变量、改动不生效;用 `node mcp.mjs restart`。

## 6. 有头浏览器(可选,默认不开)

需要**看着 AI 操作**或**自己接管登录/过验证码**时再开(它会弹出可见窗口):

```bash
cd ~/code/localmcpbrower/claude && node mcp.mjs start headed
claude mcp add --transport http browser-headed http://127.0.0.1:3213/mcp -s user
```

## 7. 收尾

**提醒我**:Claude Code 里输入 `/mcp` 重连(或重开窗口)、Codex 重启,新工具才生效。然后给我那张大白话清单。

---

## 附:这次改了什么(讲给我听时用得上)

**以前**:每开一个 AI 窗口就单独拉一套进程 + 一份浏览器(实测单窗口约 366 MB,峰值同时跑过 26 个进程);浏览器数据按当前项目目录存放,**换个项目就得重新登录一次**。

**现在**:一台机器一份浏览器,所有窗口共用。登录一次全部通用。每个窗口自动分到**自己的标签页**,互不抢占。窗口开得越多省得越明显。

**要隔离时**:多账号互不干扰用 `space_new` 开独立工作区(cookie/登录态完全分开)。

**数据库同理**:各窗口「当前连的是哪个库」互相独立 —— 以前是共用的,存在「以为在测试库、其实在生产库」的风险。

**服务开机自启**,重启电脑自动恢复。
