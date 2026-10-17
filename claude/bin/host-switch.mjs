#!/usr/bin/env node
/**
 * 换版本:本机服务 ankotti-local 把新版本解开、装好 Chromium、冒烟过了以后调它,把 PM2 里的浏览器服务换成新版本跑。
 *
 *   node bin/host-switch.mjs --to <新版本安装目录> --version <版本> [--from <现在的安装目录>]
 *                            [--idle-min 10] [--wait-min 15] [--manager ankotti-local]
 *   退出码 0 = 换好了(或本来就是它);1 = 新版本不健康,已退回 --from;3 = 浏览器一直在用,这次没换(什么都没动)。
 *   最后一行是 JSON 结果。安装目录 = 含 claude/ 的那一层。
 *
 * 和 ai-kit 的 browser-mcp.mjs 共用 ~/.ankotti/browser-mcp/state.json(启动器 shim.mjs 按它的 current 找版本):
 * 换好后写 current / previous,managedBy = --manager —— ai-kit 看到不是自己管的就不再插手。
 * - 登录态跟着走:新目录没有 storage/data-root.txt 时,沿用 --from 的数据目录;全新安装放 ~/.ankotti/browser-mcp/data
 *   (Windows 上按 dist/paths.js 挑非系统盘)。数据目录绝不放在版本目录里——换版本会删老目录。
 * - 空闲:每个在跑的服务 /health 的 inFlight = 0、lastCallAt 超过 --idle-min 分钟(或没人调过)。等 --wait-min 分钟还不空闲就退出码 3。
 * - 没有在跑的服务(全新安装):只起无头 claudemcp-headless(有头 3213 只是兼容旧配置,按需弹窗已经替代它)。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WIN = process.platform === 'win32';
const HOME = os.homedir();
const BASE = path.join(HOME, '.ankotti', 'browser-mcp');
const STATE = path.join(BASE, 'state.json');
const LAUNCHER = path.join(BASE, 'shim.mjs');
const HEALTH_WAIT_MS = 150_000;
/** PM2 里的两个常驻服务(名字、配置文件、端口和 mcp.mjs 一致) */
export const SERVICES = [
  { name: 'claudemcp-headless', eco: 'ecosystem.headless.config.cjs', port: 3215 },
  { name: 'claudemcp-browser', eco: 'ecosystem.config.cjs', port: 3213 },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
  const get = (k, d) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : d);
  const num = (k, d) => {
    const n = Number(get(k, d));
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return { to: get('to'), version: get('version'), from: get('from') ?? null, idleMin: num('idle-min', 10), waitMin: num('wait-min', 15), manager: get('manager', 'ankotti-local') };
}

/** 空闲判断(纯函数):每个在跑的服务都没有正在执行的调用、最近 idleMs 没调用过;连不上(null)算空闲 */
export function isIdle(healths, now, idleMs) {
  return healths.every((h) => !h || (h.inFlight === 0 && (h.lastCallAt == null || now - h.lastCallAt >= idleMs)));
}

/** 健康(纯函数):浏览器活着、版本号对;strict = 这个版本会报版本号(2.4.0 起) */
export function healthy(h, version, strict) {
  return Boolean(h && h.status === 'ok' && h.browserAlive === true && (h.version === version || (!strict && h.version === undefined)));
}

/** 新版本要用的数据目录(纯函数):沿用老版本选定的;没有就放启动器旁边的 data/(fresh = 全新安装时的候选,不能在版本目录里) */
export function pickDataRoot(fromMarker, fresh, toRoot, base) {
  if (fromMarker) return fromMarker;
  if (fresh && !isUnder(fresh, toRoot)) return fresh;
  return path.join(base, 'data');
}

function isUnder(p, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

const saveState = (patch) => writeJson(STATE, { ...readJson(STATE, {}), ...patch });

/** Windows 上 pm2 是 .cmd,要经 cmd.exe;参数自己加引号(路径可能有空格) */
function pm2(args, { cwd, timeout = 120_000 } = {}) {
  const quoted = args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replaceAll('"', '""')}"` : a));
  const r = WIN
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `pm2.cmd ${quoted.join(' ')}`], { cwd, encoding: 'utf8', timeout, windowsHide: true, windowsVerbatimArguments: true })
    : spawnSync('pm2', args, { cwd, encoding: 'utf8', timeout });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** PM2 里在跑的浏览器服务;PM2 调不通返回 null(这时绝不能当「没有服务」) */
function onlineServices() {
  const r = pm2(['jlist'], { timeout: 60_000 });
  if (!r.ok) return null;
  try {
    const list = JSON.parse(r.out.split('\n').reverse().find((l) => l.trim().startsWith('[')) ?? '');
    return SERVICES.filter((s) => list.some((p) => p.name === s.name && p.pm2_env?.status === 'online'));
  } catch {
    return null;
  }
}

async function health(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) });
    return await res.json();
  } catch {
    return null;
  }
}

const reportsVersion = (root) => fs.existsSync(path.join(root, 'claude', 'bin', 'session-relay.mjs'));

/** 新目录的 storage/data-root.txt:没有就按上面的规则写一个 */
async function carryDataRoot(from, to) {
  const marker = path.join(to, 'claude', 'storage', 'data-root.txt');
  if (fs.existsSync(marker)) return fs.readFileSync(marker, 'utf8').trim();
  let fromMarker = null;
  if (from) {
    const legacy = path.join(from, 'claude', 'storage');
    try {
      fromMarker = fs.readFileSync(path.join(legacy, 'data-root.txt'), 'utf8').trim() || legacy;
    } catch {
      fromMarker = fs.existsSync(legacy) ? legacy : null;
    }
  }
  let fresh = null;
  if (!fromMarker && WIN) {
    // 全新安装:让新版本自己按规则挑盘(paths.ts:不放系统盘),挑出来的在版本目录里就不要
    try {
      fresh = (await import(pathToFileURL(path.join(to, 'claude', 'dist', 'paths.js')).href)).DATA_ROOT;
      fs.rmSync(marker, { force: true });
    } catch {
      fresh = null;
    }
  }
  const root = pickDataRoot(fromMarker, fresh, to, BASE);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, root);
  return root;
}

/** 把这些服务换成 root 这个版本跑,等健康;返回每个服务的 /health */
async function startFrom(root, services, version) {
  const strict = reportsVersion(root);
  for (const s of services) {
    pm2(['delete', s.name], { timeout: 60_000 });
    const r = pm2(['start', path.join(root, 'claude', s.eco)], { cwd: path.join(root, 'claude') });
    if (!r.ok) console.error(`pm2 start ${s.name} 失败:${r.out.slice(-500)}`);
  }
  const out = [];
  for (const s of services) {
    let h = null;
    for (const deadline = Date.now() + HEALTH_WAIT_MS; Date.now() < deadline; await sleep(2000)) {
      h = await health(s.port);
      if (healthy(h, version, strict)) break;
    }
    out.push(h);
  }
  return out;
}

/** 启动器(和 ai-kit browser-mcp.mjs launcherSource 同一份逻辑):没有才写,MCP 配置指着它,换版本不用改配置 */
function ensureLauncher(fallbackRoot) {
  if (fs.existsSync(LAUNCHER)) return;
  fs.mkdirSync(BASE, { recursive: true });
  fs.writeFileSync(LAUNCHER, `// 加载当前版本的浏览器 MCP shim(版本切换不用改 MCP 配置;ai-kit / 本机服务 ankotti-local 都按 state.json 换版本)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
let root = ${JSON.stringify(fallbackRoot)};
try { root = JSON.parse(fs.readFileSync(path.join(here, "state.json"), "utf8")).current?.root || root; } catch {}
process.env.LOCALMCP_STATE_FILE = path.join(here, "state.json");
await import(pathToFileURL(path.join(root, "claude", "bin", "shim.mjs")).href);
`);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const done = (code, result) => {
    console.log(JSON.stringify(result));
    return code;
  };
  if (!a.to || !a.version || !fs.existsSync(path.join(a.to, 'claude', 'package.json'))) return done(1, { ok: false, error: '缺 --to / --version,或 --to 不是安装目录' });
  const to = path.resolve(a.to);
  const from = a.from && fs.existsSync(path.join(a.from, 'claude', 'package.json')) ? path.resolve(a.from) : null;
  const fromVersion = from ? readJson(path.join(from, 'claude', 'package.json'), {}).version ?? null : null;
  const dataRoot = await carryDataRoot(from, to);

  let services = onlineServices();
  if (!services) return done(1, { ok: false, error: 'PM2 调不通(没装 pm2 或守护进程起不来)' });
  const fresh = services.length === 0;
  if (fresh) services = [SERVICES[0]];
  else {
    const deadline = Date.now() + a.waitMin * 60_000;
    for (;;) {
      const hs = await Promise.all(services.map((s) => health(s.port)));
      if (isIdle(hs, Date.now(), a.idleMin * 60_000)) break;
      if (Date.now() >= deadline) return done(3, { ok: false, busy: true, error: `浏览器 ${a.waitMin} 分钟内一直在用,这次不换` });
      await sleep(30_000);
    }
  }

  saveState({ switching: { since: new Date().toISOString(), pid: process.pid, to: a.version } });
  try {
    const t0 = Date.now();
    const hs = await startFrom(to, services, a.version);
    if (hs.every((h) => healthy(h, a.version, true))) {
      pm2(['save'], { timeout: 60_000 });
      saveState({ current: { version: a.version, root: to }, previous: from ? { version: fromVersion, root: from } : null, pending: null, managedBy: a.manager, switchedAt: new Date().toISOString() });
      ensureLauncher(to);
      return done(0, { ok: true, version: a.version, from: fromVersion, services: services.map((s) => s.name), fresh, dataRoot, ms: Date.now() - t0 });
    }
    const reason = `切换后健康检查不过:${JSON.stringify(hs).slice(0, 300)}`;
    let backOk = null;
    if (from && !fresh) {
      const back = await startFrom(from, services, fromVersion);
      backOk = back.every((h) => healthy(h, fromVersion, reportsVersion(from)));
    } else {
      for (const s of services) pm2(['delete', s.name], { timeout: 60_000 });
    }
    pm2(['save'], { timeout: 60_000 });
    return done(1, { ok: false, error: reason, rolledBackTo: from && !fresh ? fromVersion : null, backOk });
  } finally {
    saveState({ switching: null });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e).slice(0, 300) }));
      process.exitCode = 1;
    },
  );
}
