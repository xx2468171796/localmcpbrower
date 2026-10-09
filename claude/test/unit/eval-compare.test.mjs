// 考卷放行规则的单测(eval/compare.mjs)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, summarize, toBaseline } from '../../eval/compare.mjs';

const task = (id, pass, extra = {}) => ({ id, area: 'x', pass, ms: 100, bytes: 200, calls: 2, toolErrors: pass ? 0 : 1, tools: [], ...extra });
const resultsOf = (tasks) => ({ version: 't', patchright: 'p', generatedAt: '2026-10-09T00:00:00.000Z', summary: summarize(tasks), tasks });

test('summarize: pass rate, tool error rate, p50', () => {
  const s = summarize([task('a', true), task('b', false), task('c', true, { ms: 300 })]);
  assert.equal(s.passed, 2);
  assert.equal(s.passRate, 66.67);
  assert.equal(s.calls, 6);
  assert.equal(s.toolErrorRate, 16.67);
  assert.equal(s.p50Ms, 100);
});

test('no baseline: always ok', () => {
  assert.equal(compare(resultsOf([task('a', false)]), null).ok, true);
});

test('identical run passes, known failures stay allowed', () => {
  const tasks = Array.from({ length: 20 }, (_, i) => task('t' + i, i !== 3));
  const c = compare(resultsOf(tasks), toBaseline(resultsOf(tasks)));
  assert.equal(c.ok, true, c.failures.join('; '));
});

test('a task that passed in the baseline and now fails blocks', () => {
  const tasks = Array.from({ length: 50 }, (_, i) => task('t' + i, true));
  const base = toBaseline(resultsOf(tasks));
  const now = tasks.map((t) => (t.id === 't7' ? task('t7', false, { error: 'boom' }) : t));
  const c = compare(resultsOf(now), base);
  assert.equal(c.ok, false);
  assert.match(c.failures[0], /t7: 回归/);
});

test('a baseline task missing from the run blocks (deleted or skipped tasks)', () => {
  const tasks = [task('a', true), task('b', true)];
  const c = compare(resultsOf([tasks[0]]), toBaseline(resultsOf(tasks)));
  assert.equal(c.ok, false);
  assert.match(c.failures.join(), /b: 基线里有这道题/);
});

test('tool error rate worse by more than 3pp blocks even when tasks pass', () => {
  const base = toBaseline(resultsOf([task('a', true, { calls: 100 })]));
  const c = compare(resultsOf([task('a', true, { calls: 100, toolErrors: 4 })]), base);
  assert.equal(c.ok, false);
  assert.match(c.failures.join(), /工具报错率/);
});

test('bytes and time regressions only warn', () => {
  const base = toBaseline(resultsOf([task('a', true)]));
  const c = compare(resultsOf([task('a', true, { bytes: 1000, ms: 5000 })]), base);
  assert.equal(c.ok, true);
  assert.equal(c.warnings.length, 3);
});

test('newly passing and new tasks are notes', () => {
  const base = toBaseline(resultsOf([task('a', false)]));
  const c = compare(resultsOf([task('a', true), task('n', true)]), base);
  assert.equal(c.ok, true);
  assert.equal(c.notes.length, 2);
});
