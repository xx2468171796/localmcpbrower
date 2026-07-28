#!/usr/bin/env node
/**
 * Claude Code MCP - 跨平台命令行管理工具
 * ============================================================
 * 单一入口，在 macOS / Linux / Windows 上行为一致。
 * 纯 Node 实现，无第三方依赖 (ESM)。
 *
 * 子命令:
 *   install                               安装依赖 + Chromium + 构建 (浏览器 + 数据库)
 *   update                                git pull + 重装依赖 + 重新构建 (+重启 PM2 服务)
 *   start  [headed|headless|db|all]       通过 PM2 启动常驻 HTTP 服务 (默认 all)
 *   stop   [headed|headless|db|all]       停止服务
 *   restart[headed|headless|db|all]       重启服务
 *   status                                查看 PM2 进程状态 + 端点健康
 *   autostart [--apply]                   开机自启配置 (三平台，默认只打印指引)
 *   config                                打印客户端注册方式 (HTTP 优先，stdio 备用)
 *   --help                                显示帮助
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const ROOT = dirname(fileURLToPath(import.meta.url));      // claude/
const requireCjs = createRequire(import.meta.url);         // 读 ecosystem*.cjs 用
const DB_DIR = join(ROOT, 'mcp-database');
const NPM = IS_WIN ? 'npm.cmd' : 'npm';
const NPX = IS_WIN ? 'npx.cmd' : 'npx';
const PM2 = IS_WIN ? 'pm2.cmd' : 'pm2';

const BROWSER_SERVER = join(ROOT, 'dist', 'server.js');
const DB_SERVER = join(DB_DIR, 'dist', 'server.js');

// 版本号只认 package.json 一处，避免这里的字面量和实际发布版本长期不同步
const VERSION = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version || '?'; }
  catch { return '?'; }
})();

// ── 服务定义 ──────────────────────────────────────────────
// 三个服务都以 HTTP 常驻形态运行，端口固定且三平台一致 (见 HTTP-DESIGN.md §五)。
// needsDisplay: 有头浏览器必须有图形显示且跑在已登录的交互桌面会话里，窗口才可见。
// eco 文件名必须能被 PM2 认成 ecosystem 配置 (.json/.yml/.yaml/.config.js/.config.cjs/.config.mjs)，
// 否则 `pm2 start <文件>` 会把它当普通脚本跑，服务名和 env 全不对 —— 见 ecosystem.headless.config.cjs 顶部注释。
const SERVICES = {
  headless: { name: 'claudemcp-headless', eco: join(ROOT, 'ecosystem.headless.config.cjs'), label: '无头浏览器 MCP (3215)', port: 3215, needsDisplay: false },
  headed:   { name: 'claudemcp-browser',  eco: join(ROOT, 'ecosystem.config.cjs'),   label: '有头浏览器 MCP (3213)', port: 3213, needsDisplay: true },
  db:       { name: 'claudemcp-database', eco: join(DB_DIR, 'ecosystem.config.cjs'), label: '数据库 MCP (3214)',   port: 3214, needsDisplay: false },
};

// 旧写法 (start.bat browser / 历史文档) 一律保持可用，避免升级后既有脚本失效
const SERVICE_ALIASES = {
  browser: 'headless', 'browser-headless': 'headless',
  'browser-headed': 'headed', headful: 'headed', head: 'headed',
  database: 'db',
};

// ── 工具函数 ──────────────────────────────────────────────
function log(msg)  { console.log(msg); }
function step(msg) { console.log(`\n── ${msg}`); }
function fail(msg) { console.error(`[✗] ${msg}`); process.exit(1); }

// Windows 上所有子进程都走 shell:true(否则找不到 npm.cmd / pm2.cmd),
// 而 cmd.exe 会把整条命令行按空格重新拆分 —— 含空格的路径必须自己加引号,
// 不然 "C:\Program Files\...\ecosystem.config.cjs" 会被拆成两个参数交给被调命令。
// 踩过两次:① Node 装在 "C:\Program Files\nodejs" 时 install 失败;
//          ② 安装目录含空格时 restart 传给 pm2 的配置文件路径是残缺的。
// 因此凡是 shell:IS_WIN 的 spawnSync 一律经 spawnShell,不要再直接写裸的 spawnSync。
const q = (s) => (IS_WIN && typeof s === 'string' && /\s/.test(s) && !s.startsWith('"')) ? `"${s}"` : s;

function spawnShell(cmd, args, opts = {}) {
  return spawnSync(IS_WIN ? q(cmd) : cmd, IS_WIN ? args.map(q) : args, { shell: IS_WIN, ...opts });
}

function run(cmd, args, cwd, env) {
  log(`  $ ${cmd} ${args.join(' ')}${cwd ? `   (cwd: ${cwd})` : ''}`);
  const res = spawnShell(cmd, args, { cwd: cwd || ROOT, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env });
  if (res.status !== 0) {
    fail(`命令失败: ${cmd} ${args.join(' ')} (退出码 ${res.status})`);
  }
}

// 非致命版 run:失败只返回 false,不中止整个流程(用于"可降级/可后补"的步骤)
function runSoft(cmd, args, cwd, env) {
  log(`  $ ${cmd} ${args.join(' ')}${cwd ? `   (cwd: ${cwd})` : ''}`);
  const res = spawnShell(cmd, args, { cwd: cwd || ROOT, stdio: 'inherit', env: env ? { ...process.env, ...env } : process.env });
  return res.status === 0;
}

// ── 国内网络适配 ──────────────────────────────────────────
// npm 官方源在国内常被干扰(SSL 报错/中途断流)。策略:
//   1. NPM_REGISTRY 环境变量显式指定 → 直接用它
//   2. 5 秒探测官方源,不通 → 自动切 npmmirror 镜像
//   3. 官方源探测通过但 install 仍失败 → 再用镜像重试一次(探测过了下载也可能断)
// Chromium 二进制同理,走 PLAYWRIGHT_DOWNLOAD_HOST 的 npmmirror 镜像。
const MIRROR_REGISTRY = 'https://registry.npmmirror.com';
const MIRROR_PW_HOST = 'https://cdn.npmmirror.com/binaries/playwright';

async function detectRegistry() {
  if (process.env.NPM_REGISTRY) {
    log(`  [✓] 使用 NPM_REGISTRY 指定源: ${process.env.NPM_REGISTRY}`);
    return process.env.NPM_REGISTRY;
  }
  try {
    await fetch('https://registry.npmjs.org/-/ping', { signal: AbortSignal.timeout(5000) });
    return null; // 官方源可用,不加 --registry
  } catch {
    log(`  ⚠ npm 官方源不可达,自动切换镜像: ${MIRROR_REGISTRY}`);
    return MIRROR_REGISTRY;
  }
}

function npmInstall(cwd, registry) {
  const args = registry ? ['install', `--registry=${registry}`] : ['install'];
  if (runSoft(NPM, args, cwd)) return;
  if (!registry) {
    log('  ⚠ 官方源安装失败,改用 npmmirror 镜像重试');
    run(NPM, ['install', `--registry=${MIRROR_REGISTRY}`], cwd);
  } else {
    fail(`npm install 失败 (cwd: ${cwd})`);
  }
}

// 安装 Patchright Chromium。关键:Linux 的 --with-deps 用包管理器装系统库(libnss3 等)需要 root;
// 非 root(尤其 AI 的非 tty shell)用 --with-deps 会卡在 sudo 输密码、永久挂起 → 这里降级:
//   非 root 只装 chromium 二进制(不卡、不要 sudo),系统库留给人工一条 sudo 命令补。
// 整步非致命:就算没成也不中止,后续数据库 MCP / 注册 / 配置照常完成。
function installChromium(preferMirror) {
  const isLinux = process.platform === 'linux';
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const pwArgs = (isLinux && isRoot) ? ['install', '--with-deps', 'chromium'] : ['install', 'chromium'];
  // 用户已显式设置 PLAYWRIGHT_DOWNLOAD_HOST 则尊重,不覆盖
  const mirrorEnv = process.env.PLAYWRIGHT_DOWNLOAD_HOST ? undefined : { PLAYWRIGHT_DOWNLOAD_HOST: MIRROR_PW_HOST };
  let ok = runSoft(NPX, ['patchright', ...pwArgs], ROOT, (preferMirror && mirrorEnv) ? mirrorEnv : undefined);
  if (!ok && !preferMirror && mirrorEnv) {
    log('  ⚠ Chromium 官方源下载失败,改用 npmmirror 镜像重试');
    ok = runSoft(NPX, ['patchright', ...pwArgs], ROOT, mirrorEnv);
  }
  if (isLinux && !isRoot) {
    log('  ⚠ 未以 root 运行,已跳过系统库(--with-deps),避免卡在 sudo。');
    log('    浏览器要能真正启动,请在你自己的终端手动跑一次(会要 sudo 密码):');
    log('        sudo npx patchright install-deps chromium');
  }
  if (!ok) log('  ⚠ Chromium 这步未完成,可稍后单独重试;不影响其余 MCP / 初始化继续。');
}

// ── install ──────────────────────────────────────────────
async function cmdInstall() {
  log('============================================================');
  log('  Claude Code MCP - 安装 (浏览器 + 数据库)');
  log('============================================================');

  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) fail(`Node.js 版本过低 (v${process.versions.node})，需要 >= 20`);
  log(`[✓] Node.js v${process.versions.node}  平台: ${process.platform}`);
  const registry = await detectRegistry();

  step('[1/5] 安装浏览器 MCP 依赖');
  npmInstall(ROOT, registry);

  step('[2/5] 安装 Patchright Chromium');
  installChromium(!!registry);

  step('[3/5] 构建浏览器 MCP');
  run(NPM, ['run', 'build'], ROOT);

  step('[4/5] 安装数据库 MCP 依赖');
  npmInstall(DB_DIR, registry);

  step('[5/5] 构建数据库 MCP');
  run(NPM, ['run', 'build'], DB_DIR);

  log('\n============================================================');
  log('  安装完成！');
  log('============================================================');
  log('  下一步 (推荐 HTTP 常驻形态):');
  log('    1) node mcp.mjs start        启动三个服务 (有头 3213 / 无头 3215 / 数据库 3214)');
  log('    2) node mcp.mjs config       获取客户端注册命令');
  log('    3) node mcp.mjs autostart    配置开机自启 (可选，三平台指引)');
}

// ── update ───────────────────────────────────────────────
function runCapture(cmd, args, cwd) {
  const res = spawnShell(cmd, args, { cwd: cwd || ROOT, encoding: 'utf-8' });
  return { status: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

async function cmdUpdate() {
  log('============================================================');
  log('  Claude Code MCP - 更新 (拉取仓库 + 重装依赖 + 重新构建)');
  log('============================================================');

  const REPO = dirname(ROOT); // 仓库根目录 (claude/ 的上一级)

  // ── git 拉取 ──
  step('[1/4] 拉取仓库更新');
  const isRepo = runCapture('git', ['rev-parse', '--is-inside-work-tree'], REPO).stdout === 'true';
  let oldHead = '';
  if (!isRepo) {
    log('  ⚠  非 git 仓库 (可能是复制部署)，跳过拉取，仅重装依赖并重新构建');
  } else {
    oldHead = runCapture('git', ['rev-parse', '--short', 'HEAD'], REPO).stdout;
    // 本地有未提交改动时中止，避免 pull 弄脏/冲掉手头工作
    const dirty = runCapture('git', ['status', '--porcelain'], REPO).stdout;
    if (dirty) {
      fail(`仓库有未提交的本地改动，请先 commit 或 stash 后再更新:\n${dirty.split('\n').slice(0, 10).map(l => '    ' + l).join('\n')}`);
    }
    // 当前分支没有远端 upstream (如本地开发分支) 时跳过拉取，仅重建
    const upstream = runCapture('git', ['rev-parse', '--abbrev-ref', '@{u}'], REPO);
    if (upstream.status !== 0) {
      log('  ⚠  当前分支没有远端 upstream，跳过拉取，仅重装依赖并重新构建');
    } else {
      // --ff-only: 本地分支与远端分叉时拒绝合并，不静默产生 merge commit
      run('git', ['pull', '--ff-only'], REPO);
    }
    const newHead = runCapture('git', ['rev-parse', '--short', 'HEAD'], REPO).stdout;
    if (newHead === oldHead) {
      log(`  [✓] 已是最新 (${newHead})，继续校验依赖与构建产物`);
    } else {
      log(`  [✓] 已更新 ${oldHead} → ${newHead}，变更摘要:`);
      const changed = runCapture('git', ['log', '--oneline', `${oldHead}..${newHead}`], REPO).stdout;
      for (const line of changed.split('\n').slice(0, 15)) log(`      ${line}`);
    }
  }

  // ── 依赖 + 浏览器 ──
  step('[2/4] 更新依赖 (浏览器 + 数据库)');
  const registry = await detectRegistry();
  npmInstall(ROOT, registry);
  npmInstall(DB_DIR, registry);

  step('[3/4] 校验 Patchright Chromium (已存在则跳过下载)');
  installChromium(!!registry);

  // ── 构建 ──
  step('[4/4] 重新构建');
  run(NPM, ['run', 'build'], ROOT);
  run(NPM, ['run', 'build'], DB_DIR);

  // ── PM2 服务在跑则重启，让 HTTP 模式立即用上新代码 ──
  // 注意: pm2 守护进程未启动时 jlist 会先输出 "[PM2] Spawning..." 等日志行，
  // 真正的 JSON 数组在最后一行，需逐行从后往前找
  const pm2List = runCapture(PM2, ['jlist']);
  if (pm2List.status === 0) {
    try {
      const jsonLine = pm2List.stdout.split('\n').reverse()
        .find(l => l.trim().startsWith('[') && !l.trim().startsWith('[PM2]'));
      const procs = jsonLine ? JSON.parse(jsonLine) : [];
      const running = Object.values(SERVICES).filter(svc =>
        procs.some(p => p.name === svc.name && p.pm2_env?.status === 'online'));
      for (const svc of running) {
        step(`重启运行中的 ${svc.label}`);
        // 必须传 ecosystem 文件而不是进程名: 按名字重启会复用 PM2 缓存的 pm2_env，
        // 不重读配置文件，本次改的 HOST / USER_DATA_DIR 等新 env 一律不生效。
        run(PM2, ['restart', svc.eco, '--update-env']);
      }
    } catch { /* pm2 输出异常则跳过，不影响更新结果 */ }
  }

  log('\n============================================================');
  log('  更新完成！');
  log('============================================================');
  log('  HTTP 模式: 上面已重启在跑的服务，客户端在 Claude Code 里 /mcp 重连即可');
  log('  (服务没在跑就先 node mcp.mjs start)');
  log('  stdio 模式: 新代码在下次会话自动生效');
}

// ── PM2 控制 ──────────────────────────────────────────────
// Linux 服务器无图形显示时有头浏览器起不来 (HTTP-DESIGN.md §8.3)，
// 让它进 PM2 只会无限重启刷日志，所以 all 里自动跳过；显式指定 headed 仍然放行 (用户可能挂了 Xvfb)。
function hasDisplay() {
  if (IS_WIN || IS_MAC) return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// skipNoDisplay 只给「会把服务拉起来」的命令(start/restart)用;
// stop 必须照停不误，否则有人用 Xvfb 手动起了有头就再也停不掉。
function resolveTargets(arg, { skipNoDisplay = false } = {}) {
  const t = (arg || 'all').toLowerCase();
  if (t === 'all') {
    const keys = Object.keys(SERVICES);
    if (!skipNoDisplay || hasDisplay()) return keys;
    log('  ⚠ 未检测到图形显示 (DISPLAY / WAYLAND_DISPLAY)，本次跳过有头浏览器，只跑无头 + 数据库。');
    log('    确需有头请先备好 Xvfb 并导出 DISPLAY，再执行:  node mcp.mjs start headed');
    return keys.filter((k) => !SERVICES[k].needsDisplay);
  }
  const key = SERVICE_ALIASES[t] ?? t;
  if (SERVICES[key]) return [key];
  fail(`未知服务: ${arg} (可选: headed | headless | db | all；旧写法 browser = headless)`);
}

// ── 端点解析:一切以 ecosystem 文件里的 env 为准 ─────────────
// PM2 用 ecosystem 的 env 决定服务绑哪个地址/端口，健康探测和打印出来的注册 URL
// 就必须读同一份配置。写死 127.0.0.1 的话，按 DEPLOY.md「跨机共享」把 HOST 改成
// 具体网卡地址(如 192.168.1.10)后，回环根本没人监听 —— 服务明明起来了却报「未监听」。
const ecoEnvCache = new Map();
function ecoEnv(svc) {
  if (!ecoEnvCache.has(svc.eco)) {
    let env = {};
    try {
      const mod = requireCjs(svc.eco);
      const app = Array.isArray(mod?.apps) ? mod.apps[0] : mod?.apps;   // apps 可以是数组也可以是单对象
      env = app?.env ?? {};
    } catch { /* 配置读不出来就回落到内置默认值 */ }
    ecoEnvCache.set(svc.eco, env);
  }
  return ecoEnvCache.get(svc.eco);
}

// 0.0.0.0 / :: 是「绑全部网卡」,此时回环一定可达,探 127.0.0.1 最稳;
// 绑具体网卡地址时回环反而不通,只能探那个地址本身。
const WILDCARD_HOSTS = new Set(['', '0.0.0.0', '::', '*']);
function endpoint(svc) {
  const env = ecoEnv(svc);
  const raw = String(env.HOST ?? '').trim();
  const port = Number(env.PORT) || svc.port;
  // IPv6 字面量(::1 等)进 URL 要加方括号
  const host = WILDCARD_HOSTS.has(raw) ? '127.0.0.1'
    : (raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw);
  return { host, port, url: `http://${host}:${port}` };
}

// /health 不走鉴权(requireAuth 只挂在 /mcp 和 /connections 上)，
// 所以拿到任何 HTTP 响应都算「端口已监听」;只有连不上才算失败。
async function probe(svc) {
  try {
    await fetch(`${endpoint(svc).url}/health`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch { return false; }
}

// server.ts runHttp() 是先 killPortProcess + 冷启 Chromium，最后才 listen ——
// 端口监听被浏览器启动完全阻塞，所以这里要留足预算:
// 冷 profile 无头实测 ~3s，有头 / profile 大 / 机器慢时几十秒也正常。
async function waitHealthy(svc, tries = 30) {
  for (let i = 0; i < tries; i++) {
    if (await probe(svc)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function cmdStart(arg) {
  const targets = resolveTargets(arg, { skipNoDisplay: true });
  for (const key of targets) {
    const svc = SERVICES[key];
    step(`启动 ${svc.label}`);
    if (!existsSync(svc.eco)) fail(`找不到 PM2 配置: ${svc.eco}`);
    spawnShell(PM2, ['delete', svc.name], { stdio: 'ignore' });
    run(PM2, ['start', svc.eco]);
  }

  step('端点健康检查');
  for (const key of targets) {
    const svc = SERVICES[key];
    const ok = await waitHealthy(svc);
    log(`  ${ok ? '[✓]' : '[✗]'} ${svc.label}  ${endpoint(svc).url}/mcp`);
    if (!ok) log(`      未监听，看日志:  pm2 logs ${svc.name} --lines 50`);
  }
  cmdStatus();
  log('\n  注册到客户端:  node mcp.mjs config');
  log('  配置开机自启:  node mcp.mjs autostart');
}

function cmdStop(arg) {
  for (const key of resolveTargets(arg)) {
    const svc = SERVICES[key];
    step(`停止 ${svc.label}`);
    spawnShell(PM2, ['stop', svc.name], { stdio: 'inherit' });
    spawnShell(PM2, ['delete', svc.name], { stdio: 'inherit' });
  }
}

function cmdRestart(arg) {
  // restart 会在服务不存在时退化成 start，同样受无显示保护。
  // 必须传 ecosystem 文件路径:按进程名重启时 PM2 直接复用 dump 里缓存的 pm2_env，
  // 不会重读配置文件 —— 改了 HOST / PORT / USER_DATA_DIR 全都不生效(隐蔽的部署陷阱)。
  // 传配置文件走的是 _startJson(...,'restartProcessId') 分支，env 重新加载，
  // 且进程本来就不存在时会直接把它起来，所以原有 fallback 只当兜底。
  for (const key of resolveTargets(arg, { skipNoDisplay: true })) {
    const svc = SERVICES[key];
    step(`重启 ${svc.label}`);
    // 走 spawnShell 而不是裸 spawnSync:svc.eco 是绝对路径，安装目录含空格时
    // (如 C:\Program Files\...) cmd.exe 会把它拆成两个参数，pm2 收到的是残缺路径。
    const res = spawnShell(PM2, ['restart', svc.eco, '--update-env'], { stdio: 'inherit' });
    if (res.status !== 0) run(PM2, ['start', svc.eco]);
  }
  cmdStatus();
}

function cmdStatus() {
  step('PM2 服务状态');
  spawnShell(PM2, ['list'], { stdio: 'inherit' });
}

// ── autostart ────────────────────────────────────────────
// 三平台开机自启。默认只打印指引 + pm2 save;--apply 才真正落地本机可自动完成的那部分。
function cmdAutostart(arg) {
  const apply = arg === '--apply' || arg === 'apply';

  log('============================================================');
  log('  开机自启配置');
  log('============================================================');
  log('  前提: 先 node mcp.mjs start 把要自启的服务跑起来，pm2 save 才有内容可存。');
  if (!apply) log('  当前为「只看指引」模式，不会改动本机任何配置;要真正落地加 --apply。');

  step('保存当前 PM2 进程列表 (pm2 save)');
  // pm2 save 会覆盖用户已有的 PM2 dump(此刻没服务在跑就存成空表)，
  // 属于有副作用的操作，因此只在 --apply 时才真的执行。
  if (apply) {
    if (!runSoft(PM2, ['save'])) log('  ⚠ pm2 save 失败(通常是当前没有在跑的服务)，先 start 再重试。');
  } else {
    log('  $ pm2 save        (--apply 时自动执行)');
  }

  if (IS_WIN) {
    // Windows 必须走用户级自启:注册成系统服务会落在 Session 0，
    // 有头浏览器窗口永远不可见，也就没法人工接管登录/验证码。
    const startupDir = join(process.env.APPDATA || join(process.env.USERPROFILE || '', 'AppData', 'Roaming'),
      'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const cmdFile = join(startupDir, 'claudemcp-autostart.cmd');
    // 整份脚本必须是纯 ASCII:cmd.exe 按 OEM 代码页(中文机器 GBK/936)逐行解析批处理，
    // 而这里写的是无 BOM UTF-8 —— 只要混入中文(注释或安装路径)就会解成乱码。
    // 所以注释用英文，且不写 `cd /d "<安装目录>"`:pm2 resurrect 从 dump 里读的是
    // 每个 app 自己的绝对 cwd，根本不依赖当前目录，安装路径含中文时那行反而会让 cd 失败。
    const script = [
      '@echo off',
      'REM Claude Code MCP - per-user autostart (restores PM2 apps after desktop logon)',
      'REM Generated by: node mcp.mjs autostart --apply   Delete this file to disable.',
      'REM Keep this file pure ASCII - cmd.exe parses it with the OEM codepage.',
      'call pm2 resurrect',
      '',
    ].join('\r\n');

    step('Windows: 用户级自启 (启动文件夹)');
    log('  ⚠ 严禁把服务注册成 Windows 系统服务(「不管用户是否登录都运行」):');
    log('    那样进程跑在 Session 0，有头浏览器窗口不可见，人工接管无从谈起。');
    log(`  启动文件夹: ${startupDir}`);
    if (apply) {
      try {
        mkdirSync(startupDir, { recursive: true });
        writeFileSync(cmdFile, script, 'utf-8');
        log(`  [✓] 已写入自启脚本: ${cmdFile}`);
        log('      下次登录 Windows 桌面即自动恢复服务；删除该文件即取消。');
      } catch (e) {
        log(`  ⚠ 写入失败: ${e.message}`);
        log('    可手动在启动文件夹新建 claudemcp-autostart.cmd，内容:');
        for (const line of script.split('\r\n')) if (line) log(`        ${line}`);
      }
    } else {
      log('  自动写入:  node mcp.mjs autostart --apply');
      log('  或手动: Win+R 输入 shell:startup 打开该目录，新建 claudemcp-autostart.cmd，内容:');
      for (const line of script.split('\r\n')) if (line) log(`      ${line}`);
      log('  另一种等价做法: 任务计划程序新建任务，触发器选「登录时」，');
      log('    并保持「只在用户登录时运行」(不要勾「不管用户是否登录都运行」)。');
    }
  } else if (IS_MAC) {
    step('macOS: pm2 startup (launchd)');
    log('  执行 pm2 startup 后按提示复制它输出的那条 sudo 命令执行一次:');
    log('      pm2 startup');
    log('      # 复制输出的 sudo env PATH=... pm2 startup launchd -u <你> --hp <你的家目录>');
    log('      pm2 save');
    if (apply) runSoft(PM2, ['startup']);
    else log('  想直接看到本机那条命令:  node mcp.mjs autostart --apply');
    log('  注: 有头浏览器窗口只在你登录图形会话后才可见，这与 launchd 无关。');
  } else {
    step('Linux: pm2 startup (systemd)');
    log('  桌面环境(有 DISPLAY)可跑有头；纯服务器无显示只能跑无头，或先备 Xvfb。');
    log('      pm2 startup');
    log('      # 复制输出的 sudo env PATH=... pm2 startup systemd -u <你> --hp <你的家目录>');
    log('      pm2 save');
    if (apply) runSoft(PM2, ['startup']);
    else log('  想直接看到本机那条命令:  node mcp.mjs autostart --apply');
    if (!hasDisplay()) log('  ⚠ 当前无 DISPLAY / WAYLAND_DISPLAY: 自启只会拉起无头 + 数据库。');
  }

  log('\n  自启后校验: 重启机器 → node mcp.mjs status → 三个端点应为 online');
}

// ── config ───────────────────────────────────────────────
function cmdConfig() {
  log('============================================================');
  log('  Claude Code MCP 配置');
  log('============================================================');

  if (!existsSync(BROWSER_SERVER) || !existsSync(DB_SERVER)) {
    log('  ⚠  尚未构建，请先运行:  node mcp.mjs install\n');
  }

  log('\n── 方式 A: HTTP 常驻服务 (推荐)');
  log('  一个浏览器给所有窗口共用: 省内存、登录态共用一份、可实时观察并人工接管;');
  log('  每个客户端会话自动分到自己的标签页 / 自己的数据库指针，互不打架。');
  log('  1) 启动服务:  node mcp.mjs start');
  log('  2) 注册端点 (在任意目录执行一次，默认写用户级 user scope):');
  // URL 同样按 ecosystem 里的实际 HOST/PORT 生成:HOST 被改成具体网卡地址时,
  // 印一条 127.0.0.1 的注册命令等于让人照着配一个连不上的端点。
  const EP = { browser: endpoint(SERVICES.headless), headed: endpoint(SERVICES.headed), db: endpoint(SERVICES.db) };
  log(`    claude mcp add --transport http browser        ${EP.browser.url}/mcp`);
  log(`    claude mcp add --transport http browser-headed ${EP.headed.url}/mcp`);
  log(`    claude mcp add --transport http database       ${EP.db.url}/mcp`);
  log('\n  或写入项目根目录 .mcp.json (模板见 claude/.mcp.http.example.json):');
  log(JSON.stringify({
    mcpServers: {
      browser:         { type: 'http', url: `${EP.browser.url}/mcp` },
      'browser-headed': { type: 'http', url: `${EP.headed.url}/mcp` },
      database:        { type: 'http', url: `${EP.db.url}/mcp` },
    },
  }, null, 2));
  log('\n  注: 同名条目会冲突，若之前注册过 stdio 版 browser/database，先 claude mcp remove <名字> -s user');
  log('  注: 服务默认只绑 127.0.0.1。跨机共享要在 ecosystem 里三件事一起做:');
  log('      1) HOST=0.0.0.0   2) MCP_AUTH_TOKEN=<随机串>');
  log(`      3) MCP_ALLOWED_HOSTS=<客户端 URL 里的 host:port，如 192.168.1.10:${EP.browser.port}>`);
  log('      少了第 3 条，SDK 的 DNS rebinding 校验会一律回 403 Invalid Host header。');
  log('      客户端条目再加:  "headers": { "Authorization": "Bearer <token>" }');

  log('\n── 方式 B: stdio 原生模式 (备用: 不想跑常驻服务、或服务不可达时兜底)');
  log('  每个客户端窗口各拉一个进程、各开一个浏览器，行为与旧版完全一致。');
  log(`    claude mcp add browser -- node "${BROWSER_SERVER}" --stdio`);
  log(`    claude mcp add database -e MCP_TRANSPORT=stdio -- node "${DB_SERVER}" --stdio`);
  log('\n  或写入 .mcp.json (见 .mcp.json.example):');
  log(JSON.stringify({
    mcpServers: {
      browser:  { command: 'node', args: [BROWSER_SERVER, '--stdio'] },
      database: { command: 'node', args: [DB_SERVER, '--stdio'], env: { MCP_TRANSPORT: 'stdio' } },
    },
  }, null, 2));
  log('');
}

// ── help ─────────────────────────────────────────────────
function cmdHelp() {
  log(`Claude Code MCP - 跨平台管理工具 (v${VERSION})

用法:  node mcp.mjs <命令> [参数]

命令:
  install                            安装依赖 + Chromium + 构建 (浏览器 + 数据库)
  update                             git pull + 重装依赖 + 重新构建 (+重启 PM2 服务)
  start   [headed|headless|db|all]   PM2 启动常驻 HTTP 服务 (默认 all)
  stop    [headed|headless|db|all]   停止服务 (默认 all)
  restart [headed|headless|db|all]   重启服务 (默认 all)
  status                             查看 PM2 进程状态
  autostart [--apply]                开机自启配置 (三平台指引，--apply 落地本机部分)
  config                             打印客户端注册方式 (HTTP 优先，stdio 备用)
  --help, -h                         显示本帮助

服务与端口 (三平台一致):
  headed    claudemcp-browser   http://127.0.0.1:3213/mcp   有头，窗口可见、可人工接管
  headless  claudemcp-headless  http://127.0.0.1:3215/mcp   无头，服务器 / 后台
  db        claudemcp-database  http://127.0.0.1:3214/mcp   数据库，共享连接池
  (旧写法 browser 仍等价于 headless，start.bat / 老脚本不受影响)

示例:
  node mcp.mjs install         # 首次安装
  node mcp.mjs start           # 启动三个服务 (无显示的 Linux 自动跳过有头)
  node mcp.mjs config          # 获取客户端注册命令 (推荐 HTTP)
  node mcp.mjs autostart       # 开机自启指引
  node mcp.mjs update          # 仓库更新后一键升级并重启在跑的服务

说明:
  HTTP 常驻模式为推荐形态: 一份浏览器 / 一套连接池给所有客户端共用，
  每个会话自动拿到独立标签页与独立数据库指针，互不干扰。
  服务默认只绑 127.0.0.1;跨机共享须同时设 HOST + MCP_AUTH_TOKEN + MCP_ALLOWED_HOSTS。
  有头(3213)与无头(3215)各占一份 profile(user_data_headed / user_data)，
  即两份独立登录态 —— 要共用一份登录态就只跑其中一个。
  stdio 模式保留为备用，行为与旧版完全一致。`);
}

// ── 入口 ─────────────────────────────────────────────────
const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case 'install':           await cmdInstall(); break;
  case 'update':            await cmdUpdate(); break;
  case 'start':             await cmdStart(arg); break;
  case 'stop':              cmdStop(arg); break;
  case 'restart':           cmdRestart(arg); break;
  case 'status':            cmdStatus(); break;
  case 'autostart':         cmdAutostart(arg); break;
  case 'config':            cmdConfig(); break;
  case undefined:
  case '--help':
  case '-h':
  case 'help':              cmdHelp(); break;
  default:
    console.error(`未知命令: ${cmd}\n`);
    cmdHelp();
    process.exit(1);
}
