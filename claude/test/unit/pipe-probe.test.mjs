// pipe 腿「端点被占时要不要删 socket 文件」的判断(src/pipe.ts),跑 dist
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { probeEndpoint, probeVerdict } from '../../dist/pipe.js';

const endpoint = (tag) => process.platform === 'win32'
  ? `\\\\.\\pipe\\localmcp-unit-${process.pid}-${tag}`
  : path.join(os.tmpdir(), `localmcp-unit-${process.pid}-${tag}.sock`);

test('probeVerdict: only hard evidence counts as stale, timeout never does', () => {
  assert.equal(probeVerdict({ kind: 'connect' }), 'live');
  assert.equal(probeVerdict({ kind: 'timeout' }), 'unknown');
  assert.equal(probeVerdict({ kind: 'error', code: 'ECONNREFUSED' }), 'stale');
  assert.equal(probeVerdict({ kind: 'error', code: 'ENOENT' }), 'stale');
  assert.equal(probeVerdict({ kind: 'error', code: 'EAGAIN' }), 'unknown');
  assert.equal(probeVerdict({ kind: 'error', code: 'EACCES' }), 'unknown');
  assert.equal(probeVerdict({ kind: 'error', code: undefined }), 'unknown');
});

test('probeEndpoint: a listening instance is live', async () => {
  const ep = endpoint('live');
  const srv = net.createServer((s) => s.end());
  await new Promise((r) => srv.listen(ep, r));
  try {
    assert.equal(await probeEndpoint(ep, 1, 1000), 'live');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('probeEndpoint: nothing there is stale', async () => {
  assert.equal(await probeEndpoint(endpoint('gone'), 1, 1000), 'stale');
});
