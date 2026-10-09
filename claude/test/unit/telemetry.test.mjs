// 工具调用遥测的单测(src/telemetry.ts,跑构建产物 dist/telemetry.js)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolTelemetry, resolveTarget, sampleOf } from '../../dist/telemetry.js';

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
  assert.deepEqual(resolveTarget({ BROWSER_TELEMETRY_URL: 'http://x/t' }, '/h', files({ '.claude.json': claudeJson })), { url: 'http://x/t', token: 'bl_test' });
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
