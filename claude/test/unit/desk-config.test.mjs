// 托管模式环境变量解析(src/desk/config.ts)与遥测工位标签(src/telemetry.ts)的单测,跑 dist
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDeskConfig } from '../../dist/desk/config.js';
import { telemetryLabel } from '../../dist/telemetry.js';

test('parseDeskConfig: nothing set = local defaults (same behaviour as 2.4.0)', () => {
  const c = parseDeskConfig({});
  assert.equal(c.deskId, null);
  assert.equal(c.managed, false);
  assert.equal(c.killPortOnStart, true);
  assert.equal(c.pipeDisable, false);
  assert.equal(c.devtoolsPort, null);
  assert.equal(c.toolDeadlineMs, 120_000);
  assert.equal(c.pauseWaitMaxMs, 600_000);
  assert.equal(c.allowBrowserCdp, false);
  assert.equal(c.adminToken, null);
});

test('parseDeskConfig: flags and numbers', () => {
  const c = parseDeskConfig({
    KILL_PORT_ON_START: '0', PIPE_DISABLE: 'true', ALLOW_BROWSER_CDP: 'on',
    DEVTOOLS_PORT: '9333', TOOL_DEADLINE_MS: '0', PAUSE_WAIT_MAX_MS: '5000', ADMIN_TOKEN: '  t0k  ',
  });
  assert.equal(c.killPortOnStart, false);
  assert.equal(c.pipeDisable, true);
  assert.equal(c.allowBrowserCdp, true);
  assert.equal(c.devtoolsPort, 9333);
  assert.equal(c.toolDeadlineMs, 0);
  assert.equal(c.pauseWaitMaxMs, 5000);
  assert.equal(c.adminToken, 't0k');
  // 空串 = 没设
  assert.equal(parseDeskConfig({ KILL_PORT_ON_START: '', DEVTOOLS_PORT: ' ' }).killPortOnStart, true);
});

test('parseDeskConfig: bad values fail fast with every problem listed', () => {
  assert.throws(() => parseDeskConfig({ KILL_PORT_ON_START: 'maybe', DEVTOOLS_PORT: '70000' }), (e) => {
    assert.match(e.message, /KILL_PORT_ON_START=maybe/);
    assert.match(e.message, /DEVTOOLS_PORT=70000/);
    return true;
  });
  assert.throws(() => parseDeskConfig({ TOOL_DEADLINE_MS: '1.5' }), /TOOL_DEADLINE_MS/);
  assert.throws(() => parseDeskConfig({ DESK_ID: 'a/b' }), /DESK_ID/);
});

test('parseDeskConfig: managed mode requires its own dirs', () => {
  assert.throws(() => parseDeskConfig({ DESK_ID: 'd1' }), (e) => {
    assert.match(e.message, /USER_DATA_DIR/);
    assert.match(e.message, /LOCALMCP_DATA_DIR/);
    assert.match(e.message, /SCREENSHOT_DIR/);
    return true;
  });
  assert.throws(() => parseDeskConfig({ DESK_ID: 'd1', USER_DATA_DIR: '/a', LOCALMCP_DATA_DIR: '/b' }), /SCREENSHOT_DIR/);
  // 托管模式管理令牌也必填(反向代理后面所有请求都像本机回环,「没令牌只许本机」挡不住人)
  assert.throws(() => parseDeskConfig({ DESK_ID: 'd1', USER_DATA_DIR: '/a', LOCALMCP_DATA_DIR: '/b', SCREENSHOT_DIR: '/c' }), /ADMIN_TOKEN/);
  const c = parseDeskConfig({ DESK_ID: 'd1', USER_DATA_DIR: '/a', LOCALMCP_DATA_DIR: '/b', SCREENSHOT_DIR: '/c', ADMIN_TOKEN: 't' });
  assert.equal(c.managed, true);
  assert.equal(c.deskId, 'd1');
  assert.deepEqual([c.userDataDir, c.dataDir, c.screenshotDir], ['/a', '/b', '/c']);
});

test('telemetryLabel: desk id is appended only when set', () => {
  assert.equal(telemetryLabel('headless', {}), 'headless');
  assert.equal(telemetryLabel('headless', { DESK_ID: ' ' }), 'headless');
  assert.equal(telemetryLabel('headless', { DESK_ID: 'd7' }), 'headless@desk-d7');
});
