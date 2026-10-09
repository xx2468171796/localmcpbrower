#!/usr/bin/env node
/**
 * 实测 shim 断线续接(bin/session-relay.mjs):常驻服务重启后,同一个 stdio 客户端不用重连还能接着调工具。
 *
 *   npm run build && node test/shim-reconnect.mjs
 *
 * 起一个独立的被测服务(空闲端口、pipe 名 relay-<pid>、临时数据目录),客户端经 shim 连上,
 * 调一次工具 → 杀掉服务再起一个 → 同一个客户端再调,应该成功(中途在途的调用会收到「请重试」的错误)。
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE = `relay-${process.pid}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const port = await new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'localmcp-relay-'));
const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1', PIPE_SERVICE: SERVICE, HEADLESS: 'true', USER_DATA_DIR: path.join(scratch, 'profile'), LOCALMCP_DATA_DIR: path.join(scratch, 'data'), LOCALMCP_LEGACY_DIR: path.join(scratch, 'legacy'), BROWSER_TELEMETRY: '0' };

function kill(pid) {
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  else { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
}

async function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'dist', 'server.js')], { cwd: ROOT, env, stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 120; i++) {
    try { if ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).browserAlive) return child; } catch { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('被测服务没起来');
}

let server = await startServer();
const client = new Client({ name: 'relay-probe', version: '1' }, { capabilities: {} });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', 'shim.mjs'), SERVICE], stderr: 'inherit' }));
const tools = await client.listTools();
console.log(`连上了,${tools.tools.length} 个工具`);
const before = await client.callTool({ name: 'list_tabs', arguments: {} });
console.log('重启前 list_tabs:', before.isError ? '失败' : '成功');

kill(server.pid);
console.log('服务已杀掉,重新起…');
server = await startServer();
let after = null;
for (let i = 0; i < 3 && !after; i++) {
  try { after = await client.callTool({ name: 'list_tabs', arguments: {} }); } catch (e) { console.log(`第 ${i + 1} 次调用:${e.message}`); await sleep(1000); }
}
const ok = after && !after.isError;
console.log(ok ? '[✓] 重启后同一个客户端照样能调工具' : '[✗] 重启后调不通');
await client.close().catch(() => {});
kill(server.pid);
await sleep(1000);
for (let i = 0; i < 20; i++) { try { fs.rmSync(scratch, { recursive: true, force: true }); break; } catch { await sleep(500); } }
process.exit(ok ? 0 : 1);
