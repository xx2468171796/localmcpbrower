// 工位监测 / 控制层的单测:事件时间线、参数打码、暂停闸门、白名单
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventRing, summarizeArgs } from '../../dist/desk/events.js';
import { DeskGate, normalizeDomain } from '../../dist/desk/gate.js';
import { ToolError } from '../../dist/errors.js';

test('EventRing: ids increase, capacity bounded, since() resumes', () => {
  const ring = new EventRing(3, () => 1000);
  for (let i = 0; i < 5; i++) ring.push({ kind: 'call_start', tool: `t${i}` });
  assert.equal(ring.lastId, 5);
  assert.deepEqual(ring.since(0).map((e) => e.id), [3, 4, 5]);
  assert.deepEqual(ring.since(4).map((e) => e.id), [5]);
  assert.deepEqual(ring.since(0, 1).map((e) => e.id), [5]);
});

test('EventRing: inFlight lists started-but-not-ended calls', () => {
  const ring = new EventRing();
  const a = ring.newCallId();
  const b = ring.newCallId();
  ring.push({ kind: 'call_start', callId: a, tool: 'navigate' });
  ring.push({ kind: 'call_start', callId: b, tool: 'click' });
  ring.push({ kind: 'call_end', callId: a, tool: 'navigate', ok: true });
  assert.deepEqual(ring.inFlight().map((e) => e.tool), ['click']);
});

test('EventRing: a throwing subscriber does not break push', () => {
  const ring = new EventRing();
  const seen = [];
  ring.subscribe(() => { throw new Error('boom'); });
  ring.subscribe((e) => seen.push(e.id));
  ring.push({ kind: 'gate', detail: 'paused' });
  assert.deepEqual(seen, [1]);
});

test('summarizeArgs: redacts typed text, scripts, cookies; keeps url/selector', () => {
  const s = summarizeArgs({
    url: 'https://a.com', selector: '#pw', text: 'hunter2', script: 'return 1',
    fields: [{ selector: '#u', value: 'alice' }], cookies: [{ name: 'sid', value: 'x' }],
  });
  assert.equal(s.url, 'https://a.com');
  assert.equal(s.selector, '#pw');
  assert.equal(s.text, '«7 字符»');
  assert.equal(s.script, '«8 字符»');
  assert.deepEqual(s.fields, [{ selector: '#u', value: '«5 字符»' }]);
  assert.equal(s.cookies, '«1 项»');
  assert.equal(JSON.stringify(s).includes('hunter2'), false);
  assert.equal(JSON.stringify(s).includes('alice'), false);
});

test('summarizeArgs: long strings truncated, non-objects ignored', () => {
  assert.equal(summarizeArgs('x'), undefined);
  const s = summarizeArgs({ url: 'u'.repeat(500) });
  assert.ok(s.url.length < 260);
});

test('DeskGate: running admits everything', async () => {
  const g = new DeskGate();
  await g.admit('click');
  assert.equal(g.status().state, 'running');
});

test('DeskGate: paused(wait) blocks writers until resume, readonly passes', async () => {
  const g = new DeskGate(5000);
  g.pause({ by: 'admin', reason: '人工登录' });
  await g.admit('snapshot'); // 只读放行
  let done = false;
  const p = g.admit('click').then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(done, false);
  assert.equal(g.status().waiting, 1);
  g.resume();
  await p;
  assert.equal(done, true);
  assert.equal(g.status().waiting, 0);
});

test('DeskGate: paused(wait) times out with DESK_PAUSED', async () => {
  const g = new DeskGate(30);
  g.pause();
  await assert.rejects(g.admit('type'), (e) => e instanceof ToolError && e.code === 'DESK_PAUSED');
  assert.equal(g.status().waiting, 0);
});

test('DeskGate: reject mode fails immediately; switching to reject flushes waiters', async () => {
  const g = new DeskGate(5000);
  g.pause();
  const p = g.admit('click');
  g.pause({ mode: 'reject' });
  await assert.rejects(p, (e) => e.code === 'DESK_PAUSED');
  await assert.rejects(g.admit('navigate'), (e) => e.code === 'DESK_PAUSED');
});

test('DeskGate: abort signal cancels a waiting call', async () => {
  const g = new DeskGate(5000);
  g.pause();
  const ac = new AbortController();
  const p = g.admit('click', ac.signal);
  ac.abort();
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
  assert.equal(g.status().waiting, 0);
});

test('DeskGate allowlist: empty = all, subdomains match, internal pages pass', () => {
  const g = new DeskGate();
  assert.equal(g.allows('https://evil.com'), true);
  assert.deepEqual(g.setAllowlist(['https://Example.com/x', '*.zygskins.cn', 'bad url %', '']), ['example.com', 'zygskins.cn']);
  assert.equal(g.allows('https://example.com/a'), true);
  assert.equal(g.allows('https://a.b.zygskins.cn/'), true);
  assert.equal(g.allows('https://notexample.com'), false);
  assert.equal(g.allows('https://example.com.evil.io'), false);
  assert.equal(g.allows('about:blank'), true);
  assert.equal(g.allows('data:text/html,hi'), true);
  assert.throws(() => g.checkUrl('https://evil.com'), (e) => e.code === 'DOMAIN_BLOCKED');
});

test('normalizeDomain', () => {
  assert.equal(normalizeDomain(' A.Com '), 'a.com');
  assert.equal(normalizeDomain('http://x.y:8080/p'), 'x.y');
  assert.equal(normalizeDomain(''), null);
});

// ── 2026-10-15 独立审查后的修复 ──
import { deadlineFor } from '../../dist/desk/instrument.js';
import { checkPageCommand } from '../../dist/control/cdp.js';

test('deadlineFor: human tools unlimited, own timeout + margin wins, 0 = unlimited', () => {
  assert.equal(deadlineFor('wait_for_human', { timeoutSec: 1800 }, 120_000), 0);
  assert.equal(deadlineFor('click', {}, 120_000), 120_000);
  assert.equal(deadlineFor('run_flow', {}, 120_000), 315_000);
  assert.equal(deadlineFor('run_flow', { timeoutMs: 900_000 }, 120_000), 915_000);
  assert.equal(deadlineFor('wait_for_selector', { timeout: 300_000 }, 120_000), 315_000);
  assert.equal(deadlineFor('execute_js', { timeoutMs: 5000 }, 120_000), 120_000);
  assert.equal(deadlineFor('navigate', {}, 0), 0);
});

test('cdp page policy: allow-list domains, deny file/upload/download escapes', () => {
  assert.doesNotThrow(() => checkPageCommand('Runtime.evaluate', { expression: '1' }));
  assert.doesNotThrow(() => checkPageCommand('Emulation.setGeolocationOverride', {}));
  assert.doesNotThrow(() => checkPageCommand('Page.navigate', { url: 'https://example.com' }));
  for (const [m, p] of [
    ['Page.navigate', { url: 'file:///etc/passwd' }],
    ['DOM.setFileInputFiles', { files: ['/x'] }],
    ['Page.setDownloadBehavior', { behavior: 'allow', downloadPath: '/tmp' }],
    ['Network.loadNetworkResource', { url: 'file:///x' }],
    ['Input.dispatchDragEvent', { data: { files: ['/x'] } }],
    ['Browser.close', {}],
    ['Target.closeTarget', {}],
    ['IO.read', {}],
    ['Fetch.enable', {}],
    ['Storage.clearDataForOrigin', {}],
  ]) assert.throws(() => checkPageCommand(m, p), (e) => e.code === 'UNSUPPORTED', m);
});

test('allowlist: non-empty list denies file:/ftp:/view-source:, keeps about:/data:', () => {
  const g = new DeskGate();
  assert.equal(g.allows('file:///etc/passwd'), true); // 空名单 = 不限(本机单用不变)
  g.setAllowlist(['a.com']);
  assert.equal(g.allows('file:///etc/passwd'), false);
  assert.equal(g.allows('ftp://a.com/x'), false);
  assert.equal(g.allows('view-source:https://a.com'), false);
  assert.equal(g.allows('about:blank'), true);
  assert.equal(g.allows('https://a.com./x'), true);
});

test('gate: readonly tool that navigates is held during takeover; reject mode resets on resume', async () => {
  const g = new DeskGate(30);
  g.pause();
  await g.admit('extract_article'); // 不带网址:只读,放行
  await assert.rejects(g.admit('extract_article', undefined, true), (e) => e.code === 'DESK_PAUSED');
  g.pause({ mode: 'reject' });
  g.resume();
  assert.equal(g.status().mode, 'wait');
});
