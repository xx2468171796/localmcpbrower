// 工位分辨率:校验、xrandr 解析、切换流程(假的 xrandr)、DisplayControl、/admin/display 路由
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import {
  ALLOWED_RESOLUTIONS, DeskDisplay, newModeArgs, parseResolution, parseXrandrCurrent, parseXrandrOutputs, pickStartupResolution,
} from '../../dist/desk/display.js';
import { DisplayControl } from '../../dist/desk/display-control.js';
import { createAdminRouter } from '../../dist/desk/admin-routes.js';
import { EventRing } from '../../dist/desk/events.js';
import { DeskGate } from '../../dist/desk/gate.js';

const XRANDR = `Screen 0: minimum 1 x 1, current 1920 x 1080, maximum 3840 x 2160
screen connected primary 1920x1080+0+0 0mm x 0mm
   3840x2160      0.00 +
   desk-1920x1080  60.00*
`;

test('parseResolution: only allowed sizes, strict format', () => {
  assert.deepEqual(parseResolution('1920x1080'), { width: 1920, height: 1080 });
  assert.deepEqual(parseResolution(' 2560x1440\n'), { width: 2560, height: 1440 });
  for (const bad of ['1920x1081', '1920X1080', '1920*1080', '800x600', '', null, undefined, '19200x1080', '1920x1080;rm -rf /']) {
    assert.equal(parseResolution(bad), null, String(bad));
  }
  assert.equal(ALLOWED_RESOLUTIONS.length, 5);
});

test('pickStartupResolution: saved > env > 1920x1080', () => {
  assert.deepEqual(pickStartupResolution({ width: 1280, height: 720 }, '2560x1440'), { width: 1280, height: 720 });
  assert.deepEqual(pickStartupResolution(null, '2560x1440'), { width: 2560, height: 1440 });
  assert.deepEqual(pickStartupResolution(null, 'junk'), { width: 1920, height: 1080 });
  assert.deepEqual(pickStartupResolution(null, undefined), { width: 1920, height: 1080 });
});

test('xrandr parsing: current size, first connected output and its modes', () => {
  assert.deepEqual(parseXrandrCurrent(XRANDR), { width: 1920, height: 1080 });
  assert.equal(parseXrandrCurrent('nothing'), null);
  const o = parseXrandrOutputs(XRANDR);
  assert.equal(o.output, 'screen');
  assert.deepEqual([...o.modes], ['3840x2160', 'desk-1920x1080']);
  assert.equal(parseXrandrOutputs('Screen 0: current 1 x 1\nscreen disconnected\n').output, null);
});

test('newModeArgs: 60 Hz pixel clock (Chromium paces frames by refresh rate)', () => {
  const a = newModeArgs({ width: 1920, height: 1080 });
  assert.deepEqual(a, ['--newmode', 'desk-1920x1080', '124.416', '1920', '1920', '1920', '1920', '1080', '1080', '1080', '1080']);
});

/** 假 xrandr:记录调用,按 --output --mode / --fb 改「当前大小」 */
function fakeX({ failMode = false, size = { width: 1920, height: 1080 } } = {}) {
  const calls = [];
  const modes = new Set(['3840x2160', 'desk-1920x1080']);
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (file !== 'xrandr') return { stdout: '', stderr: '' };
    if (args[0] === '--current' || args.length === 0) {
      return { stdout: `Screen 0: minimum 1 x 1, current ${size.width} x ${size.height}, maximum 3840 x 2160\nscreen connected\n${[...modes].map((m) => `   ${m}  60.00`).join('\n')}\n`, stderr: '' };
    }
    if (args[0] === '--newmode') { modes.add(args[1]); return { stdout: '', stderr: '' }; }
    if (args[0] === '--addmode') return { stdout: '', stderr: '' };
    if (args[0] === '--output') {
      if (failMode) throw new Error('BadMatch');
      const [w, h] = args[3].replace('desk-', '').split('x').map(Number);
      Object.assign(size, { width: w, height: h });
      return { stdout: '', stderr: '' };
    }
    if (args[0] === '--fb') {
      const [w, h] = args[1].split('x').map(Number);
      Object.assign(size, { width: w, height: h });
      throw new Error('X Error of failed request: BadValue (not large enough for output)');
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { exec, calls, size };
}

test('DeskDisplay.apply: adds a missing mode, switches the output, verifies', async () => {
  const x = fakeX();
  const d = new DeskDisplay({ exec: x.exec, stateFile: null, wallpaper: null });
  assert.deepEqual(await d.apply({ width: 2560, height: 1440 }), { width: 2560, height: 1440 });
  const verbs = x.calls.map((c) => c[1]);
  assert.deepEqual(verbs, [undefined, '--newmode', '--addmode', '--output', '--current']);
  // 已有的模式不再加
  await d.apply({ width: 1920, height: 1080 });
  assert.equal(x.calls.filter((c) => c[1] === '--newmode').length, 1);
});

test('DeskDisplay.apply: mode switch fails → falls back to --fb (BadValue ignored, result verified)', async () => {
  const x = fakeX({ failMode: true });
  const d = new DeskDisplay({ exec: x.exec, stateFile: null, wallpaper: null });
  assert.deepEqual(await d.apply({ width: 1280, height: 720 }), { width: 1280, height: 720 });
  assert.ok(x.calls.some((c) => c[1] === '--fb' && c[2] === '1280x720'));
});

test('DeskDisplay.apply: refuses sizes outside the list; save/readSaved round-trip', async () => {
  const x = fakeX();
  const dir = await mkdtemp(path.join(tmpdir(), 'desk-display-'));
  try {
    const file = path.join(dir, 'display-resolution');
    const d = new DeskDisplay({ exec: x.exec, stateFile: file, wallpaper: null });
    await assert.rejects(d.apply({ width: 1000, height: 1000 }), /不在允许列表/);
    assert.equal(await d.readSaved(), null);
    await d.save({ width: 2560, height: 1440 });
    assert.equal(await readFile(file, 'utf8'), '2560x1440\n');
    assert.deepEqual(await d.readSaved(), { width: 2560, height: 1440 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function control({ restartFails = false } = {}) {
  const x = fakeX();
  const d = new DeskDisplay({ exec: x.exec, stateFile: null, wallpaper: null });
  const events = [];
  let fitted = 0;
  let restarts = 0;
  const c = new DisplayControl({
    driver: d,
    fitWindows: async () => { fitted++; return 2; },
    restartStream: async () => { restarts++; if (restartFails) throw new Error('polkit: not authorized'); },
    push: (e) => events.push(e),
  });
  return { c, x, events, counts: () => ({ fitted, restarts }) };
}

test('DisplayControl.set: switch → fit windows → restart stream → display event', async () => {
  const { c, events, counts } = control();
  const r = await c.set({ width: 2560, height: 1440 });
  assert.equal(r.changed, true);
  assert.deepEqual(r.previous, { width: 1920, height: 1080 });
  assert.equal(r.width, 2560);
  assert.equal(r.windows, 2);
  assert.equal(r.stream, 'restarting');
  assert.equal(r.allowed.length, 5);
  assert.deepEqual(counts(), { fitted: 1, restarts: 1 });
  assert.deepEqual(events, [{ kind: 'display', detail: '1920x1080 → 2560x1440' }]);
  // 同样大小再设:不切、不重启画面、不记事件
  const again = await c.set({ width: 2560, height: 1440 });
  assert.equal(again.changed, false);
  assert.equal(again.stream, 'unchanged');
  assert.equal(events.length, 1);
});

test('DisplayControl.set: stream restart failure is reported, not thrown; concurrent sets run in order', async () => {
  const { c, x } = control({ restartFails: true });
  const [a, b] = await Promise.all([c.set({ width: 1280, height: 720 }), c.set({ width: 1600, height: 900 })]);
  assert.equal(a.stream, 'restart_failed');
  assert.deepEqual(b.previous, { width: 1280, height: 720 });
  assert.deepEqual(x.size, { width: 1600, height: 900 });
  assert.deepEqual((await c.info()).width, 1600);
});

async function withAdmin(display, fn) {
  const hosts = [];
  const app = express();
  app.use('/admin', createAdminRouter({
    ring: new EventRing(), gate: new DeskGate(), adminToken: 'tok', allowedHosts: hosts, allowedOrigins: [],
    version: 't', state: async () => ({}), screenshot: async () => null, restart: async () => ({}), metrics: async () => ({}), display,
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  hosts.push(`127.0.0.1:${server.address().port}`);
  const base = `http://${hosts[0]}`;
  const call = (method, p, body, headers = {}) => fetch(base + p, {
    method, headers: { authorization: 'Bearer tok', 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  });
  try { await fn(call); } finally { server.close(); }
}

test('/admin/display: GET/POST contract, validation, auth, 404 when unsupported', async () => {
  const { c } = control();
  await withAdmin(c, async (call) => {
    const g = await (await call('GET', '/admin/display')).json();
    assert.deepEqual({ w: g.width, h: g.height, n: g.allowed.length }, { w: 1920, h: 1080, n: 5 });
    const bad = await call('POST', '/admin/display', { width: 1920, height: 1081 });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'INVALID_ARGS');
    assert.equal((await call('POST', '/admin/display', { width: 1920, height: 1080, extra: 1 })).status, 400);
    assert.equal((await call('POST', '/admin/display', { width: 2560, height: 1440 }, { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await call('POST', '/admin/display', { width: 2560, height: 1440 }, { origin: 'https://evil.example' })).status, 403);
    const ok = await call('POST', '/admin/display', { width: 2560, height: 1440 });
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.changed, true);
    assert.equal(body.stream, 'restarting');
    const st = await (await call('GET', '/admin/state')).json();
    assert.deepEqual({ w: st.display.width, h: st.display.height }, { w: 2560, h: 1440 });
  });
  await withAdmin(undefined, async (call) => {
    const r = await call('GET', '/admin/display');
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.code, 'NOT_SUPPORTED');
    assert.equal((await (await call('GET', '/admin/state')).json()).display, null);
  });
});
