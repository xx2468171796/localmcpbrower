#!/usr/bin/env node
/**
 * Claude Code MCP - 跨平台命令行管理工具 (v2.0.0)
 * ============================================================
 * 单一入口，在 macOS / Linux / Windows 上行为一致。
 * 纯 Node 实现，无第三方依赖 (ESM)。
 *
 * 子命令:
 *   install                      安装依赖 + Chromium + 构建 (浏览器 + 数据库)
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
import { createRequire } from 'node:module';

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

function run(cmd, args, cwd) {
  log(`  $ ${cmd} ${args.join(' ')}${cwd ? `   (cwd: ${cwd})` : ''}`);
  const res = spawnSync(cmd, args, { cwd: cwd || ROOT, stdio: 'inherit', shell: IS_WIN });
  if (res.status !== 0) {
    fail(`命令失败: ${cmd} ${args.join(' ')} (退出码 ${res.status})`);
  }
}

// ── install ──────────────────────────────────────────────
function cmdInstall() {
  log('============================================================');
  log('  Claude Code MCP - 安装 (浏览器 + 数据库)');
  log('============================================================');

  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) fail(`Node.js 版本过低 (v${process.versions.node})，需要 >= 20`);
  log(`[✓] Node.js v${process.versions.node}  平台: ${process.platform}`);

  step('[1/5] 安装浏览器 MCP 依赖');
  run(NPM, ['install'], ROOT);

  step('[2/5] 安装 Playwright Chromium');
  // rebrowser-playwright 自带 CLI 有 bug，调用其内置 playwright-core CLI 安装
  const require = createRequire(join(ROOT, 'package.json'));
  const pwCli = join(dirname(require.resolve('rebrowser-playwright/package.json')), 'node_modules', 'playwright-core', 'cli.js');
  // Linux 需 --with-deps 自动安装 Chromium 运行所需系统库 (libnss3 等)，否则浏览器无法启动
  const pwArgs = process.platform === 'linux'
    ? ['install', '--with-deps', 'chromium']
    : ['install', 'chromium'];
  run(process.execPath, [pwCli, ...pwArgs], ROOT);

  step('[3/5] 构建浏览器 MCP');
  run(NPM, ['run', 'build'], ROOT);

  step('[4/5] 安装数据库 MCP 依赖');
  run(NPM, ['install'], DB_DIR);

  step('[5/5] 构建数据库 MCP');
  run(NPM, ['run', 'build'], DB_DIR);

  log('\n============================================================');
  log('  安装完成！');
  log('============================================================');
  log('  推荐 (stdio 原生模式): 运行  node mcp.mjs config  获取配置命令');
  log('  HTTP / PM2 模式:        运行  node mcp.mjs start');
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
  log(`Claude Code MCP - 跨平台管理工具 (v2.0.0)

用法:  node mcp.mjs <命令> [参数]

命令:
  install                      安装依赖 + Chromium + 构建 (浏览器 + 数据库)
  start   [browser|db|all]     通过 PM2 启动服务 (默认 all)
  stop    [browser|db|all]     停止服务 (默认 all)
  restart [browser|db|all]     重启服务 (默认 all)
  status                       查看 PM2 进程状态
  config                       打印 Claude Code 配置命令 (stdio + HTTP)
  --help, -h                   显示本帮助

示例:
  node mcp.mjs install         # 首次安装
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
  case 'install':           cmdInstall(); break;
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
