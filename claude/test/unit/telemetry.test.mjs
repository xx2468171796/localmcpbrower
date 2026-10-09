// 工具调用遥测的单测(src/telemetry.ts,跑构建产物 dist/telemetry.js)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RetryTracker, ToolTelemetry, resolveTarget, sampleOf } from '../../dist/telemetry.js';

const files = (map) => (file) => {
  const norm = file.split('\\').join('/');
  const key = Object.keys(map).find((k) => norm.endsWith(k));
  return key ? map[key] : null;
};
const claudeJson = JSON.stringify({ mcpServers: { baolei: { url: 'http://bastion:8770/mcp', headers: { Authorization: 'Bearer bl_test' } } } });

test('resolveTarget: off switch wins', () => {
  assert.equal(resolveTarget({ BROWSER_TELEMETRY: '0' }, '/h', files({ '.claude.json': claudeJson })), null);
  assert.equal(resolveTarget({ BROWSER_TELEMETRY: 'off' }, '/h', files({ '.claude.json': claudeJson })), null);
});

test('resolveTarget: default on when a baolei key is in ~/.claude.json', () => {
  assert.deepEqual(resolveTarget({}, '/h', files({ '.claude.json': claudeJson })), { url: 'http://bastion:8770/ai-kit/telemetry', token: 'bl_test' });
});

test('resolveTarget: project-level baolei server and codex toml are found', () => {
  const proj = JSON.stringify({ projects: { 'D:/x': { mcpServers: { baolei: { url: 'https://b.example/mcp/', headers: { authorization: 'Bearer bl_p' } } } } } });
  assert.deepEqual(resolveTarget({}, '/h', files({ '.claude.json': proj })), { url: 'https://b.example/ai-kit/telemetry', token: 'bl_p' });
  const toml = '[mcp_servers.baolei]\nurl = "http://c:8770/mcp"\nbearer_token_env_var = "BL"\n[other]\n';
  assert.deepEqual(resolveTarget({ BL: 'bl_env' }, '/h', files({ '.codex/config.toml': toml })), { url: 'http://c:8770/ai-kit/telemetry', token: 'bl_env' });
});

test('resolveTarget: no key anywhere means off; explicit url / token override', () => {
  assert.equal(resolveTarget({}, '/h', files({})), null);
  assert.deepEqual(resolveTarget({ BROWSER_TELEMETRY_URL: 'http://x/t', BROWSER_TELEMETRY_TOKEN: 'k' }, '/h', files({})), { url: 'http://x/t', token: 'k' });
});

test('resolveTarget: the baolei key is never sent to a foreign origin', () => {
  // 自定义地址不同源、又没给专用 token → 不上报(不能把高权限的 baolei 密钥发出去)
  assert.equal(resolveTarget({ BROWSER_TELEMETRY_URL: 'http://x/t' }, '/h', files({ '.claude.json': claudeJson })), null);
  assert.equal(resolveTarget({ BROWSER_TELEMETRY_URL: 'http://bastion:9999/ai-kit/telemetry' }, '/h', files({ '.claude.json': claudeJson })), null);
  // 同源(只换路径)可以用 baolei 密钥
  assert.deepEqual(resolveTarget({ BROWSER_TELEMETRY_URL: 'http://bastion:8770/other' }, '/h', files({ '.claude.json': claudeJson })), { url: 'http://bastion:8770/other', token: 'bl_test' });
  // 给了专用 token 就用专用的
  assert.deepEqual(resolveTarget({ BROWSER_TELEMETRY_URL: 'http://x/t', BROWSER_TELEMETRY_TOKEN: 'own' }, '/h', files({ '.claude.json': claudeJson })), { url: 'http://x/t', token: 'own' });
});

test('RetryTracker: a call after a failure of the same tool is a retry', () => {
  const r = new RetryTracker();
  const s = (tool, ok) => ({ tool, ok, ms: 1, bytes: 1, truncated: false });
  assert.equal(r.mark(s('click', false)).retry, false);
  assert.equal(r.mark(s('navigate', true)).retry, false);
  assert.equal(r.mark(s('click', true)).retry, true);
  assert.equal(r.mark(s('click', true)).retry, false);
});

test('sampleOf: ok from raw success, bytes over all text, truncated flag', () => {
  const out = { content: [{ type: 'text', text: '中文ab' }, { type: 'image', data: 'zzz' }] };
  assert.deepEqual(sampleOf('snapshot', out, 12.6, { success: true, data: { truncated: true } }), { tool: 'snapshot', ok: true, ms: 13, bytes: 8, truncated: true });
  assert.equal(sampleOf('x', { content: [], isError: true }, 1).ok, false);
  assert.equal(sampleOf('x', out, 1, { success: false }).ok, false);
});

const sample = (tool = 'navigate') => ({ tool, ok: true, ms: 5, bytes: 10, truncated: false });

test('ToolTelemetry: batches and sends the documented payload', async () => {
  const sent = [];
  const tel = new ToolTelemetry({ target: { url: 'u', token: 't' }, version: '9.9.9', service: 'eval', maxBatch: 2, send: async (_t, p) => { sent.push(p); return 204; } });
  tel.record(sample('a')); tel.record(sample('b')); tel.record(sample('c'));
  await tel.flush();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].calls.map((c) => c.tool), ['a', 'b']);
  assert.deepEqual([sent[0].event, sent[0].project, sent[0].version, sent[0].service], ['tool_calls', 'localmcpbrower', '9.9.9', 'eval']);
  assert.equal(tel.pending, 1);
  await tel.flush();
  assert.equal(tel.pending, 0);
});

test('ToolTelemetry: network failure keeps the batch, never throws', async () => {
  const tel = new ToolTelemetry({ target: { url: 'u', token: 't' }, version: 'v', service: 's', send: async () => { throw new Error('offline'); } });
  tel.record(sample());
  await tel.flush();
  assert.equal(tel.pending, 1);
});

test('ToolTelemetry: 4xx pauses sending, buffer is bounded', async () => {
  let now = 1000;
  let calls = 0;
  const tel = new ToolTelemetry({ target: { url: 'u', token: 't' }, version: 'v', service: 's', maxBuffer: 3, pauseMs: 500, now: () => now, send: async () => { calls++; return 400; } });
  for (let i = 0; i < 5; i++) tel.record(sample('t' + i));
  assert.equal(tel.pending, 3);
  assert.equal(tel.dropped, 2);
  await tel.flush();
  assert.equal(calls, 1);
  tel.record(sample());
  await tel.flush();
  assert.equal(calls, 1, 'paused after 4xx');
  now += 600;
  await tel.flush();
  assert.equal(calls, 2);
});

test('ToolTelemetry: first batch goes out soon, then the normal interval', async () => {
  const sent = [];
  const tel = new ToolTelemetry({ target: { url: 'u', token: 't' }, version: 'v', service: 's', flushMs: 60_000, firstFlushMs: 20, send: async (_t, p) => { sent.push(p); return 204; } });
  tel.record(sample());
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sent.length, 1);
});

test('ToolTelemetry: drain sends everything before exit, bounded by the timeout', async () => {
  const sent = [];
  const tel = new ToolTelemetry({ target: { url: 'u', token: 't' }, version: 'v', service: 's', maxBatch: 2, send: async (_t, p) => { sent.push(p); return 204; } });
  for (let i = 0; i < 5; i++) tel.record(sample('t' + i));
  await tel.drain(500);
  assert.equal(tel.pending, 0);
  assert.equal(sent.length, 3);
  const hang = new ToolTelemetry({ target: { url: 'u', token: 't' }, version: 'v', service: 's', send: () => new Promise(() => {}) });
  hang.record(sample());
  const t0 = Date.now();
  await hang.drain(100);
  assert.ok(Date.now() - t0 < 1000, 'drain never blocks exit for long');
});
