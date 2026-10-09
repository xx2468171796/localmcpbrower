/**
 * 考卷运行器的底座:起一个**隔离的**被测服务、连上它、记每次工具调用的指标。
 *
 * 隔离(绝不碰本机在用的浏览器 MCP):
 *   - 空闲端口(不是 3213 / 3215),独立 pipe 名 eval-<pid>(不抢 headless / headed 的管道);
 *   - profile、数据目录、截图、临时文件全在系统临时目录下新建的 eval 目录里,跑完删掉;
 *   - 遥测关掉(BROWSER_TELEMETRY=0),考试数据不进线上成绩单;
 *   - 被测服务只拿白名单环境变量,HOME / USERPROFILE / APPDATA 指向临时目录:被测代码是 AI 可改的,
 *     不能让它读到本机的 baolei 密钥(BAOLEI_MCP_TOKEN、~/.claude.json、~/.codex/config.toml)或别的秘密;
 *   - 结束时按进程树强杀(连同 chromium),再确认临时 profile 能删掉(删不掉 = 有浏览器漏了)。
 * 这个文件属于裁判层(.ankotti/evolve.json protected),AI 改进流程不得修改。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const RAW_META_KEY = 'localmcp/result';

export class AssertionFailed extends Error {}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
  }
}

/** 浏览器内核装在哪(patchright 默认位置;HOME 换掉以后要显式告诉它) */
function browsersPath() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

/** 被测服务的环境:只放跑起来必需的系统变量,家目录全部换成临时目录,不带任何密钥 */
export function isolatedEnv(scratch, source = process.env) {
  const KEEP = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'SystemDrive', 'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE', 'OS', 'LANG', 'LC_ALL', 'TZ', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR'];
  const env = {};
  for (const k of KEEP) if (source[k] !== undefined) env[k] = source[k];
  const home = path.join(scratch, 'home');
  const tmp = path.join(scratch, 'tmp');
  for (const d of [home, tmp, path.join(home, 'AppData', 'Roaming'), path.join(home, 'AppData', 'Local')]) fs.mkdirSync(d, { recursive: true });
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'),
    TEMP: tmp, TMP: tmp, TMPDIR: tmp, USERNAME: 'eval', PLAYWRIGHT_BROWSERS_PATH: browsersPath(),
  });
  return env;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起被测服务(dist/server.js,HTTP 模式),等到 /health 报 browserAlive */
export async function startServer({ root, log }) {
  const PROTECTED = new Set([3211, 3213, 3215]);
  let port = await freePort();
  while (PROTECTED.has(port)) port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'localmcp-eval-'));
  const dirs = { profile: path.join(scratch, 'profile'), data: path.join(scratch, 'data'), legacy: path.join(scratch, 'legacy'), shots: path.join(scratch, 'shots'), files: path.join(scratch, 'files') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const env = {
    ...isolatedEnv(scratch),
    PORT: String(port),
    HOST: '127.0.0.1',
    PIPE_SERVICE: `eval-${process.pid}`,
    HEADLESS: 'true',
    USER_DATA_DIR: dirs.profile,
    LOCALMCP_DATA_DIR: dirs.data,
    LOCALMCP_LEGACY_DIR: dirs.legacy,
    SCREENSHOT_DIR: dirs.shots,
    BROWSER_TELEMETRY: '0',
    MCP_AUTH_TOKEN: '',
  };
  const logFile = fs.openSync(path.join(scratch, 'server.log'), 'w');
  const child = spawn(process.execPath, [path.join(root, 'dist', 'server.js')], {
    cwd: root, env, stdio: ['ignore', logFile, logFile], windowsHide: true, detached: process.platform !== 'win32',
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  let health = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) });
      health = await res.json();
      if (health?.browserAlive) break;
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  const stop = async () => {
    killTree(child.pid);
    try { fs.closeSync(logFile); } catch { /* noop */ }
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(scratch, { recursive: true, force: true }); return true; } catch { await sleep(500); }
    }
    log?.(`[eval] 临时目录删不掉(可能有浏览器进程漏了):${scratch}`);
    return false;
  };
  if (!health?.browserAlive) {
    const tail = (() => { try { return fs.readFileSync(path.join(scratch, 'server.log'), 'utf8').slice(-2000); } catch { return ''; } })();
    await stop();
    throw new Error(`被测服务没起来(端口 ${port}):\n${tail}`);
  }
  return { port, base, dirs, health, stop };
}

export async function connect(base) {
  const client = new Client({ name: 'localmcp-eval', version: '1' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}

/**
 * 一道题的执行上下文:call() 调工具并记指标,expect() 断言。
 * 指标:ms(调用耗时)、bytes(回给 AI 的全部文本字节,token 的代理)、toolErrors(非预期的工具失败)。
 */
export function taskContext(client, env, signal) {
  const calls = [];
  const ctx = {
    ...env,
    calls,
    signal,
    async call(name, args = {}, opts = {}) {
      if (signal?.aborted) throw new AssertionFailed('题目已超时,后续调用取消');
      const t0 = performance.now();
      let raw;
      let bytes = 0;
      let threw = null;
      try {
        const r = await client.callTool({ name, arguments: args }, undefined, { timeout: opts.timeout ?? 60_000, signal });
        for (const c of r.content ?? []) if (typeof c.text === 'string') bytes += Buffer.byteLength(c.text);
        raw = r._meta?.[RAW_META_KEY];
        if (!raw) { try { raw = JSON.parse(r.content?.[0]?.text ?? ''); } catch { raw = { success: !r.isError, data: r.content?.[0]?.text } }; }
      } catch (e) {
        threw = e instanceof Error ? e.message : String(e);
        raw = { success: false, error: threw };
      }
      const ok = raw?.success !== false;
      calls.push({ tool: name, ok, expectedError: !!opts.expectError, ms: Math.round(performance.now() - t0), bytes });
      if (!ok && !opts.expectError) throw new AssertionFailed(`${name} 失败:${String(raw?.error ?? threw).slice(0, 300)}`);
      if (ok && opts.expectError) throw new AssertionFailed(`${name} 本应报错却成功了`);
      return raw;
    },
    /** execute_js 的返回值 */
    async js(script) {
      const r = await ctx.call('execute_js', { script });
      return r?.data?.result;
    },
    expect(cond, message) {
      if (!cond) throw new AssertionFailed(message);
    },
    eq(actual, expected, what) {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) throw new AssertionFailed(`${what}:期望 ${e},实际 ${a}`);
    },
  };
  return ctx;
}

/** 跑一道题,收集结果(题目自己的超时兜底,免得一道题卡死整场) */
export async function runTask(client, task, env) {
  const abort = new AbortController();
  const ctx = taskContext(client, env, abort.signal);
  const t0 = performance.now();
  const limit = task.timeoutMs ?? 90_000;
  let error = null;
  let timer;
  const running = Promise.resolve().then(() => task.run(ctx));
  try {
    await Promise.race([
      running,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new AssertionFailed(`超时 ${limit}ms`)), limit); }),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  } finally {
    clearTimeout(timer);
  }
  if (error && !abort.signal.aborted && /^超时 /.test(error)) {
    // 超时:取消在途调用、拦下后续调用,并等这道题真正停下来,免得它和下一道题抢同一个浏览器
    abort.abort();
    await Promise.race([running.catch(() => {}), sleep(10_000)]);
  }
  const unexpected = ctx.calls.filter((c) => !c.ok && !c.expectedError).length;
  return {
    id: task.id,
    area: task.area,
    pass: error === null,
    ms: Math.round(performance.now() - t0),
    bytes: ctx.calls.reduce((s, c) => s + c.bytes, 0),
    calls: ctx.calls.length,
    toolErrors: unexpected,
    tools: [...new Set(ctx.calls.map((c) => c.tool))],
    ...(error ? { error: error.slice(0, 500) } : {}),
  };
}
