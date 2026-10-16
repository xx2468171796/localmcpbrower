// BrowserManager 的纯判断(src/space-policy.ts)与 UA 计算(src/user-agent.ts)的单测,跑 dist
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RecycledSessions, idleLimitMinutes, maxOpenSpaces, needsSentinel } from '../../dist/space-policy.js';
import { bundledChromiumVersion, greaseBrand, headfulMetadata, majorOf, platformUserAgent, uaVersionToken } from '../../dist/user-agent.js';

test('idleLimitMinutes: unset = default, 0 / negative = never, junk = default', () => {
  assert.equal(idleLimitMinutes(undefined, 30), 30);
  assert.equal(idleLimitMinutes('', 30), 30);
  assert.equal(idleLimitMinutes('0', 30), Infinity);
  assert.equal(idleLimitMinutes('-1', 30), Infinity);
  assert.equal(idleLimitMinutes('abc', 30), 30);
  assert.equal(idleLimitMinutes('2.5', 30), 2.5);
});

test('maxOpenSpaces: default 4, 0 = unlimited, floor and at least 1', () => {
  assert.equal(maxOpenSpaces(undefined), 4);
  assert.equal(maxOpenSpaces('x'), 4);
  assert.equal(maxOpenSpaces('-3'), 4);
  assert.equal(maxOpenSpaces('0'), Infinity);
  assert.equal(maxOpenSpaces('0.5'), 1);
  assert.equal(maxOpenSpaces('7.9'), 7);
});

const pg = (closed = false) => ({ isClosed: () => closed });

test('needsSentinel: only when closing would leave no live page', () => {
  const a = pg(); const b = pg(); const dead = pg(true);
  assert.equal(needsSentinel([a], [a]), true);
  assert.equal(needsSentinel([a, dead], [a]), true);
  assert.equal(needsSentinel([a, b], [a]), false);       // 还有别的会话 / 无主页
  assert.equal(needsSentinel([a, b], [a, b]), true);
  assert.equal(needsSentinel([a], []), false);            // 什么都不关
  assert.equal(needsSentinel([], []), false);
});

test('RecycledSessions: consume once, forget, bounded', () => {
  const r = new RecycledSessions(2);
  r.mark('a');
  assert.equal(r.consume('a'), true);
  assert.equal(r.consume('a'), false);
  r.mark('b'); r.forget('b');
  assert.equal(r.consume('b'), false);
  r.mark('x'); r.mark('y'); r.mark('z');
  assert.equal(r.size, 2);
  assert.equal(r.consume('x'), false);                    // 最旧的被淘汰
  assert.equal(r.consume('z'), true);
});

test('uaVersionToken: explicit override wins, otherwise reduced <major>.0.0.0', () => {
  assert.equal(uaVersionToken('148.0.0.0', '153.0.8010.12'), '148.0.0.0');
  assert.equal(uaVersionToken(undefined, '153.0.8010.12'), '153.0.0.0');
  assert.equal(uaVersionToken(' ', null), null);
  assert.equal(majorOf('153.0.8010.12'), '153');
  assert.equal(majorOf('x'), null);
});

test('platformUserAgent: per-OS shape, never HeadlessChrome', () => {
  assert.match(platformUserAgent('win32', '153.0.0.0'), /\(Windows NT 10\.0; Win64; x64\).*Chrome\/153\.0\.0\.0 Safari/);
  assert.match(platformUserAgent('darwin', '153.0.0.0'), /Macintosh; Intel Mac OS X 10_15_7/);
  assert.match(platformUserAgent('linux', '153.0.0.0'), /X11; Linux x86_64/);
  assert.doesNotMatch(platformUserAgent('linux', '1'), /Headless/);
});

test('headfulMetadata: drops HeadlessChrome, keeps GREASE and real platform values', () => {
  const defaults = {
    brands: [{ brand: 'HeadlessChrome', version: '153' }, { brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '153' }],
    fullVersionList: [{ brand: 'HeadlessChrome', version: '153.0.8010.12' }, { brand: 'Not_A Brand', version: '8.0.0.0' }, { brand: 'Chromium', version: '153.0.8010.12' }],
    platform: 'Windows', platformVersion: '20.0.0', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false,
  };
  const m = headfulMetadata(defaults, '153.0.8010.12');
  assert.deepEqual(m.brands, [{ brand: 'Chromium', version: '153' }, { brand: 'Not_A Brand', version: '8' }]);
  assert.deepEqual(m.fullVersionList, [{ brand: 'Chromium', version: '153.0.8010.12' }, { brand: 'Not_A Brand', version: '8.0.0.0' }]);
  assert.equal(m.fullVersion, '153.0.8010.12');
  assert.equal(m.platformVersion, '20.0.0');
  assert.equal(m.bitness, '64');
  // 显式覆盖版本:品牌和 fullVersion 跟着走
  const o = headfulMetadata(defaults, '153.0.8010.12', '148.0.0.0');
  assert.deepEqual(o.brands[0], { brand: 'Chromium', version: '148' });
  assert.equal(o.fullVersion, '148.0.0.0');
});

test('headfulMetadata: no defaults falls back to computed GREASE', () => {
  const m = headfulMetadata(null, '153.0.8010.12');
  assert.deepEqual(m.brands, [{ brand: 'Chromium', version: '153' }, { brand: 'Not_A Brand', version: '8' }]);
  assert.deepEqual(greaseBrand(153, false), { brand: 'Not_A Brand', version: '8.0.0.0' });
});

test('bundledChromiumVersion: read from the installed patchright', () => {
  const v = bundledChromiumVersion();
  assert.ok(v === null || /^\d+\.\d+/.test(v), String(v));
});
