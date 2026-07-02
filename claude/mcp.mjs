#!/usr/bin/env node
/**
 * Claude Code MCP - 跨平台命令行管理工具 (v2.1.0)
 * ============================================================
 * 单一入口，在 macOS / Linux / Windows 上行为一致。
 * 纯 Node 实现，无第三方依赖 (ESM)。
 *
 * 子命令:
 *   install                      安装依赖 + Chromium + 构建 (浏览器 + 数据库)
 *   update                       git pull + 重装依赖 + 重新构建 (+重启 PM2 服务)
 *   start  [browser|db|all]      通过 PM2 启动服务 (默认 all)
 *   stop   [browser|db|all]      停止服务
 *   restart[browser|db|all]      重启服务
 *   status                       查看 PM2 进程状态
 *   config                       打印 claude mcp add 配置命令 (stdio + HTTP)
 *   --help                       显示帮助
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

const IS_WIN = process.platform === 'win32';
const ROOT = dirname(fileURLToPath(import.meta.url));      // claude/
const DB_DIR = join(ROOT, 'mcp-database');
const NPM = IS_WIN ? 'npm.cmd' : 'npm';
const NPX = IS_WIN ? 'npx.cmd' : 'npx';
const PM2 = IS_WIN ? 'pm2.cmd' : 'pm2';

const BROWSER_SERVER = join(ROOT, 'dist', 'server.js');
const DB_SERVER = join(DB_DIR, 'dist', 'server.js');

// ── 服务定义 ──────────────────────────────────────────────
const SERVICES = {
  browser:  { name: 'claudemcp-headless', eco: join(ROOT, 'ecosystem.headless.cjs'), label: '无头浏览器 MCP (3215)' },
  db:       { name: 'claudemcp-database', eco: join(DB_DIR, 'ecosystem.config.cjs'), label: '数据库 MCP (3214)' },
};

// ── 工具函数 ──────────────────────────────────────────────
function log(msg)  { console.log(msg); }
function step(msg) { console.log(`\n── ${msg}`); }
function fail(msg) { console.error(`[✗] ${msg}`); process.exit(1); }

function run(cmd, args, cwd, env) {
  log(`  $ ${cmd} ${args.join(' ')}${cwd ? `   (cwd: ${cwd})` : ''}`);
  // Windows + shell:true 时，cmd.exe 会按空格拆分命令；为含空格的路径加引号
  // (修复 Node.js 安装在 "C:\Program Files\nodejs" 时 install 失败的问题)
  const q = (s) => (IS_WIN && typeof s === 'string' && /\s/.test(s) && !s.startsWith('"')) ? `"${s}"` : s;
  const res = spawnSync(IS_WIN ? q(cmd) : cmd, IS_WIN ? args.map(q) : args, { cwd: cwd || ROOT, stdio: 'inherit', shell: IS_WIN, env: env ? { ...process.env, ...env } : process.env });
  if (res.status !== 0) {
    fail(`命令失败: ${cmd} ${args.join(' ')} (退出码 ${res.status})`);
  }
}

// 非致命版 run:失败只返回 false,不中止整个流程(用于"可降级/可后补"的步骤)
function runSoft(cmd, args, cwd, env) {
  log(`  $ ${cmd} ${args.join(' ')}${cwd ? `   (cwd: ${cwd})` : ''}`);
  const q = (s) => (IS_WIN && typeof s === 'string' && /\s/.test(s) && !s.startsWith('"')) ? `"${s}"` : s;
  const res = spawnSync(IS_WIN ? q(cmd) : cmd, IS_WIN ? args.map(q) : args, { cwd: cwd || ROOT, stdio: 'inherit', shell: IS_WIN, env: env ? { ...process.env, ...env } : process.env });
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
  log('  推荐 (stdio 原生模式): 运行  node mcp.mjs config  获取配置命令');
  log('  HTTP / PM2 模式:        运行  node mcp.mjs start');
}

// ── update ───────────────────────────────────────────────
function runCapture(cmd, args, cwd) {
  const res = spawnSync(cmd, args, { cwd: cwd || ROOT, encoding: 'utf-8', shell: IS_WIN });
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
        run(PM2, ['restart', svc.name]);
      }
    } catch { /* pm2 输出异常则跳过，不影响更新结果 */ }
  }

  log('\n============================================================');
  log('  更新完成！');
  log('============================================================');
  log('  stdio 模式: 新代码在下次 Claude Code 会话自动生效');
  log('  (当前会话要立即生效，可在 Claude Code 里执行 /mcp 重连)');
}

// ── PM2 控制 ──────────────────────────────────────────────
function resolveTargets(arg) {
  const t = (arg || 'all').toLowerCase();
  if (t === 'all') return ['browser', 'db'];
  if (SERVICES[t]) return [t];
  fail(`未知服务: ${arg} (可选: browser | db | all)`);
}

function cmdStart(arg) {
  for (const key of resolveTargets(arg)) {
    const svc = SERVICES[key];
    step(`启动 ${svc.label}`);
    if (!existsSync(svc.eco)) fail(`找不到 PM2 配置: ${svc.eco}`);
    spawnSync(PM2, ['delete', svc.name], { stdio: 'ignore', shell: IS_WIN });
    run(PM2, ['start', svc.eco]);
  }
  cmdStatus();
}

function cmdStop(arg) {
  for (const key of resolveTargets(arg)) {
    const svc = SERVICES[key];
    step(`停止 ${svc.label}`);
    spawnSync(PM2, ['stop', svc.name], { stdio: 'inherit', shell: IS_WIN });
    spawnSync(PM2, ['delete', svc.name], { stdio: 'inherit', shell: IS_WIN });
  }
}

function cmdRestart(arg) {
  for (const key of resolveTargets(arg)) {
    const svc = SERVICES[key];
    step(`重启 ${svc.label}`);
    const res = spawnSync(PM2, ['restart', svc.name], { stdio: 'inherit', shell: IS_WIN });
    if (res.status !== 0) run(PM2, ['start', svc.eco]);
  }
  cmdStatus();
}

function cmdStatus() {
  step('PM2 服务状态');
  spawnSync(PM2, ['list'], { stdio: 'inherit', shell: IS_WIN });
}

// ── config ───────────────────────────────────────────────
function cmdConfig() {
  log('============================================================');
  log('  Claude Code MCP 配置');
  log('============================================================');

  if (!existsSync(BROWSER_SERVER) || !existsSync(DB_SERVER)) {
    log('  ⚠  尚未构建，请先运行:  node mcp.mjs install\n');
  }

  log('\n── 方式 A: stdio 原生模式 (推荐，无需 PM2 / 端口)');
  log('  在项目目录执行以下命令:');
  log(`    claude mcp add browser -- node "${BROWSER_SERVER}" --stdio`);
  log(`    claude mcp add database -e MCP_TRANSPORT=stdio -- node "${DB_SERVER}" --stdio`);
  log('\n  或将下面内容写入项目根目录的 .mcp.json (见 .mcp.json.example):');
  log(JSON.stringify({
    mcpServers: {
      browser:  { command: 'node', args: [BROWSER_SERVER, '--stdio'] },
      database: { command: 'node', args: [DB_SERVER, '--stdio'], env: { MCP_TRANSPORT: 'stdio' } },
    },
  }, null, 2));

  log('\n── 方式 B: HTTP / PM2 模式 (服务器或多客户端共享)');
  log('  先启动服务:  node mcp.mjs start');
  log('  再注册端点:');
  log('    claude mcp add --transport http browser-headless http://localhost:3215/mcp');
  log('    claude mcp add --transport http browser-headed   http://localhost:3213/mcp');
  log('    claude mcp add --transport http database          http://localhost:3214/mcp');
  log('');
}

// ── help ─────────────────────────────────────────────────
function cmdHelp() {
  log(`Claude Code MCP - 跨平台管理工具 (v2.1.0)

用法:  node mcp.mjs <命令> [参数]

命令:
  install                      安装依赖 + Chromium + 构建 (浏览器 + 数据库)
  update                       git pull + 重装依赖 + 重新构建 (+重启 PM2 服务)
  start   [browser|db|all]     通过 PM2 启动服务 (默认 all)
  stop    [browser|db|all]     停止服务 (默认 all)
  restart [browser|db|all]     重启服务 (默认 all)
  status                       查看 PM2 进程状态
  config                       打印 Claude Code 配置命令 (stdio + HTTP)
  --help, -h                   显示本帮助

示例:
  node mcp.mjs install         # 首次安装
  node mcp.mjs update          # 仓库更新后一键升级本地服务
  node mcp.mjs config          # 获取 stdio 配置 (推荐路径)
  node mcp.mjs start           # HTTP 模式启动全部服务
  node mcp.mjs status

说明:
  stdio 模式由 Claude Code 直接拉起进程，无需 PM2、无需端口，推荐使用。
  HTTP / PM2 模式适合服务器环境或多个客户端共享同一服务。`);
}

// ── 入口 ─────────────────────────────────────────────────
const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case 'install':           await cmdInstall(); break;
  case 'update':            await cmdUpdate(); break;
  case 'start':             cmdStart(arg); break;
  case 'stop':              cmdStop(arg); break;
  case 'restart':           cmdRestart(arg); break;
  case 'status':            cmdStatus(); break;
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
