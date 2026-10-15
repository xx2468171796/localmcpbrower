// 工具纯函数的单测:超时 / 取消 / 导航重试(tools/timing)、参数校验与模式解析(tools/pure)、错误码归类(errors)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { clampMs, isNavigationRace, longTaskBudgetMs, retryOnNavigation, sleep, withTimeout } from '../../dist/tools/timing.js';
import { parseInput, parseSitemapLocs, patternToRegex } from '../../dist/tools/pure.js';
import { ToolError, classifyError, failFrom } from '../../dist/errors.js';

test('withTimeout: resolves, times out with TIMEOUT and runs cleanup, rejects on abort', async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 100, 'x'), 7);
  let cleaned = false;
  await assert.rejects(withTimeout(new Promise(() => {}), 20, '脚本', { onTimeout: () => { cleaned = true; } }),
    (e) => e instanceof ToolError && e.code === 'TIMEOUT' && /脚本超时/.test(e.message));
  assert.equal(cleaned, true);
  const ac = new AbortController();
  const p = withTimeout(new Promise(() => {}), 5000, 'x', { signal: ac.signal });
  ac.abort();
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
  await assert.rejects(withTimeout(Promise.reject(new Error('boom')), 100, 'x'), /boom/);
  // 超时后原 Promise 再失败,不能变成无主 rejection
  await assert.rejects(withTimeout(new Promise((_, rej) => setTimeout(() => rej(new Error('late')), 30)), 5, 'x'), (e) => e.code === 'TIMEOUT');
  await sleep(40);
});

test('sleep: cancellable', async () => {
  const ac = new AbortController();
  const t0 = Date.now();
  const p = sleep(5000, ac.signal);
  setTimeout(() => ac.abort(), 10);
  await assert.rejects(p, (e) => e.code === 'CANCELLED');
  assert.ok(Date.now() - t0 < 1000);
  ac.abort();
  await assert.rejects(sleep(10, ac.signal), (e) => e.code === 'CANCELLED');
});

test('clampMs / longTaskBudgetMs', () => {
  assert.equal(clampMs(undefined, 30000, 100, 300000), 30000);
  assert.equal(clampMs(10, 30000, 100, 300000), 100);
  assert.equal(clampMs(9e9, 30000, 100, 300000), 300000);
  assert.equal(longTaskBudgetMs({}), 105000);
  assert.equal(longTaskBudgetMs({ TOOL_DEADLINE_MS: '60000' }), 45000);
  assert.equal(longTaskBudgetMs({ TOOL_DEADLINE_MS: '1000' }), 10000);
});

test('retryOnNavigation: retries only navigation races', async () => {
  let n = 0;
  let settled = 0;
  const v = await retryOnNavigation(async () => {
    if (++n < 3) throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation.');
    return 'ok';
  }, async () => { settled++; });
  assert.equal(v, 'ok');
  assert.equal(settled, 2);
  let m = 0;
  await assert.rejects(retryOnNavigation(async () => { m++; throw new Error('other'); }, async () => {}), /other/);
  assert.equal(m, 1);
  assert.equal(isNavigationRace(new Error('Cannot find context with specified id')), true);
});

test('parseInput: INVALID_ARGS with the legacy prefix', () => {
  const S = z.object({ a: z.number() });
  assert.deepEqual(parseInput(S, { a: 1 }), { a: 1 });
  assert.throws(() => parseInput(S, { a: 'x' }), (e) => e.code === 'INVALID_ARGS' && e.message.startsWith('参数验证失败'));
});

test('patternToRegex: globs vs regex', () => {
  const g = patternToRegex('*/api/ping*');
  assert.ok(g.test('http://127.0.0.1:5/api/ping?x=1'));
  assert.ok(!g.test('http://127.0.0.1:5/api/pong'));
  // 以前被当正则:"ping*" = "pin" + 任意个 g
  assert.ok(!patternToRegex('api/ping*').test('http://x/api/pin'));
  assert.ok(patternToRegex('*.css').test('http://x/a.css'));
  assert.ok(!patternToRegex('*.css').test('http://x/acss'));
  assert.ok(patternToRegex('^https://x/.*\\.js$').test('https://x/a/b.js'));
  assert.ok(patternToRegex('/ads?\\d+/i').test('http://x/ADS12'));
});

test('parseSitemapLocs: CDATA and entities', () => {
  const xml = '<urlset><url><loc> https://x/a?p=1&amp;q=2 </loc></url><url><loc><![CDATA[https://x/b]]></loc></url></urlset>';
  assert.deepEqual(parseSitemapLocs(xml), ['https://x/a?p=1&q=2', 'https://x/b']);
});

test('error mapping: ToolError keeps its code, text is classified', () => {
  assert.deepEqual(failFrom(new ToolError('PATH_DENIED', 'no')), { success: false, error: 'no', code: 'PATH_DENIED' });
  assert.equal(failFrom(new Error('ref e5 未找到(页面可能已重新渲染),请重新调用 snapshot')).code, 'ELEMENT_NOT_FOUND');
  assert.equal(classifyError('page.goto: net::ERR_CONNECTION_REFUSED'), 'NAVIGATION_FAILED');
  assert.equal(classifyError('locator.click: Timeout 5000ms exceeded.'), 'TIMEOUT');
  assert.equal(classifyError('调用方已取消本次请求'), 'CANCELLED');
});
