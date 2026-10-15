// run_flow 执行器与「录制 → 流程」转换的单测
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFlow, substitute } from '../../dist/control/flow.js';
import { toFlowSteps, extensionLaunchPatch, extensionMode } from '../../dist/control/extension.js';
import { ToolError } from '../../dist/errors.js';

const ok = (data) => async () => ({ success: true, data });

test('runFlow: runs steps in order, saves vars, substitutes refs', async () => {
  const seen = [];
  const tools = new Map([
    ['extract_links', ok({ links: [{ href: 'https://a.com/1' }], count: 1 })],
    ['navigate', async (a) => { seen.push(a); return { success: true, data: { url: a.url } }; }],
  ]);
  const r = await runFlow({ steps: [
    { tool: 'extract_links', as: 'L' },
    { tool: 'navigate', args: { url: '{{L.links.0.href}}', note: '共 {{L.count}} 个' } },
  ] }, { tools });
  assert.equal(r.success, true);
  assert.equal(r.data.completed, 2);
  assert.deepEqual(seen, [{ url: 'https://a.com/1', note: '共 1 个' }]);
});

test('runFlow: stops on failure with code, returns completed steps', async () => {
  const tools = new Map([
    ['a', ok(1)],
    ['b', async () => ({ success: false, error: 'nope', code: 'ELEMENT_NOT_FOUND' })],
    ['c', ok(3)],
  ]);
  const r = await runFlow({ steps: [{ tool: 'a' }, { tool: 'b' }, { tool: 'c' }] }, { tools });
  assert.equal(r.success, false);
  assert.equal(r.code, 'ELEMENT_NOT_FOUND');
  assert.equal(r.data.completed, 1);
  assert.equal(r.data.steps.length, 2);
});

test('runFlow: retry retries transient errors but not DESK_PAUSED; continueOnError goes on', async () => {
  let n = 0;
  const tools = new Map([
    ['flaky', async () => (++n < 3 ? { success: false, error: 't', code: 'TIMEOUT' } : { success: true, data: n })],
    ['paused', async () => ({ success: false, error: 'p', code: 'DESK_PAUSED' })],
    ['last', ok('end')],
  ]);
  const r = await runFlow({ steps: [
    { tool: 'flaky', retry: 2 },
    { tool: 'paused', retry: 3, continueOnError: true },
    { tool: 'last' },
  ] }, { tools });
  assert.equal(r.success, true);
  assert.equal(r.data.steps[0].attempts, 3);
  assert.equal(r.data.steps[1].attempts, 1);
  assert.equal(r.data.steps[1].ok, false);
  assert.equal(r.data.completed, 2);
});

test('runFlow: unknown tool, nested run_flow, and beforeStep veto', async () => {
  const tools = new Map([['a', ok(1)], ['run_flow', ok(0)]]);
  assert.equal((await runFlow({ steps: [{ tool: 'zzz' }] }, { tools })).code, 'INVALID_ARGS');
  assert.equal((await runFlow({ steps: [{ tool: 'run_flow' }] }, { tools })).code, 'INVALID_ARGS');
  const r = await runFlow({ steps: [{ tool: 'a' }, { tool: 'a' }] }, {
    tools,
    beforeStep: async (_s, i) => { if (i === 1) throw new ToolError('DESK_PAUSED', '接管中'); },
  });
  assert.equal(r.code, 'DESK_PAUSED');
  assert.equal(r.data.completed, 1);
});

test('substitute keeps types for whole refs', () => {
  const vars = { r: { list: [1, 2], n: 5 } };
  assert.deepEqual(substitute('{{r.list}}', vars), [1, 2]);
  assert.equal(substitute('{{ r.n }}', vars), 5);
  assert.equal(substitute('n={{r.n}}, x={{r.missing}}', vars), 'n=5, x=');
  assert.deepEqual(substitute({ a: ['{{r.n}}'] }, vars), { a: [5] });
});

test('toFlowSteps: converts and dedupes; passwords become fill_secret without values', () => {
  const { steps, secretsToFill } = toFlowSteps([
    { type: 'navigate', url: 'https://x.com/login' },
    { type: 'navigate', url: 'https://x.com/login' },
    { type: 'fill', selector: '#u', value: 'al' },
    { type: 'fill', selector: '#u', value: 'alice' },
    { type: 'fill', selector: '#p', password: true, length: 8 },
    { type: 'press', key: 'Enter', selector: '#p' },
    { type: 'fill', selector: '#p', password: true, length: 8 },
    { type: 'select', selector: 'select[name="city"]', value: 'wh' },
    { type: 'click', selector: 'button:has-text("查询")' },
  ]);
  assert.deepEqual(steps.map((s) => s.tool), ['navigate', 'type', 'fill_secret', 'keyboard_press', 'fill_secret', 'select_option', 'click']);
  assert.equal(steps[1].args.text, 'alice');
  assert.equal(JSON.stringify(steps).includes('length'), false);
  assert.equal(secretsToFill, 2);
});

test('extension launch patch: auto skips headless, off disables, on forces', () => {
  assert.equal(extensionMode({}), 'auto');
  assert.equal(extensionLaunchPatch(true, {}), null);
  assert.ok(extensionLaunchPatch(false, {}).args.some((a) => a.startsWith('--load-extension=')));
  assert.equal(extensionLaunchPatch(false, { BROWSER_EXTENSION: 'off' }), null);
  assert.equal(extensionLaunchPatch(true, { BROWSER_EXTENSION: 'on' }).needsFullChromium, true);
});
