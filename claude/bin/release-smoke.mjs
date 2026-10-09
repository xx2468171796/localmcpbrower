#!/usr/bin/env node
/**
 * 发布包的冒烟测试:本机自动更新器(baolei ai-kit browser-mcp.mjs)把新版本装到旁边以后、切换之前跑它。
 *
 *   node bin/release-smoke.mjs        (cwd 无所谓;退出码 0 = 通过,最后一行是 JSON 结果)
 *
 * 只碰临时目录,不碰本机在用的服务和登录态:
 *   - 空闲端口(不用 3211 / 3213 / 3215)、独立 pipe 名 smoke-<pid>;
 *   - profile、数据目录、截图全在系统临时目录下新建的目录里,跑完删掉;
 *   - 遥测关掉(冒烟不进线上成绩单)。
 * 检查:/health 报 browserAlive 且版本号 = package.json;navigate 打开本机起的测试页,get_element_text 读到页面里的标记。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = `smoke-${process.pid}-${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
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
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } } }
}

async function main() {
  const t0 = Date.now();
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const page = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>release smoke</title><h1 id="marker">${MARKER}</h1>`);
  });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  const pageUrl = `http://127.0.0.1:${page.address().port}/`;

  let port = await freePort();
  while ([3211, 3213, 3215].includes(port)) port = await freePort();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'localmcp-smoke-'));
  const dir = (n) => { const d = path.join(scratch, n); fs.mkdirSync(d, { recursive: true }); return d; };
  const env = {
    ...process.env,
    PORT: String(port), HOST: '127.0.0.1', PIPE_SERVICE: `smoke-${process.pid}`, HEADLESS: 'true',
    USER_DATA_DIR: dir('profile'), LOCALMCP_DATA_DIR: dir('data'), LOCALMCP_LEGACY_DIR: dir('legacy'), SCREENSHOT_DIR: dir('shots'),
    BROWSER_TELEMETRY: '0', MCP_AUTH_TOKEN: '',
  };
  const log = fs.openSync(path.join(scratch, 'server.log'), 'w');
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', log, log], windowsHide: true, detached: process.platform !== 'win32' });
  const result = { ok: false, version, ms: 0, step: 'health', error: null };
  let client = null;
  try {
    let health = null;
    for (const deadline = Date.now() + 120_000; Date.now() < deadline && child.exitCode === null; await sleep(500)) {
      try {
        health = await (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) })).json();
        if (health?.browserAlive) break;
      } catch { /* 还没起来 */ }
    }
    if (!health?.browserAlive) throw new Error(`服务没起来或浏览器没活(退出码 ${child.exitCode})`);
    if (health.version !== undefined && health.version !== version) throw new Error(`/health 报的版本 ${health.version} 和包里的 ${version} 不一致`);
    result.step = 'navigate';
    const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
    client = new Client({ name: 'localmcp-release-smoke', version: '1' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const nav = await client.callTool({ name: 'navigate', arguments: { url: pageUrl } }, undefined, { timeout: 60_000 });
    if (nav.isError) throw new Error(`navigate 失败:${JSON.stringify(nav.content).slice(0, 300)}`);
    result.step = 'read';
    const text = await client.callTool({ name: 'get_element_text', arguments: { selector: '#marker' } }, undefined, { timeout: 30_000 });
    const raw = JSON.stringify(text.structuredContent ?? text._meta ?? text.content);
    if (!raw.includes(MARKER)) throw new Error(`页面里读不到标记:${raw.slice(0, 300)}`);
    result.ok = true;
    result.step = 'done';
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    try { result.log = fs.readFileSync(path.join(scratch, 'server.log'), 'utf8').slice(-1500); } catch { /* 没日志 */ }
  } finally {
    try { await client?.close(); } catch { /* 已断 */ }
    killTree(child.pid);
    page.close();
    try { fs.closeSync(log); } catch { /* noop */ }
    for (let i = 0; i < 20; i++) {
      try { fs.rmSync(scratch, { recursive: true, force: true }); break; } catch { await sleep(500); }
    }
  }
  result.ms = Date.now() - t0;
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, step: 'crash', error: String(e?.stack ?? e) }));
  process.exit(1);
});
