/**
 * 考卷 · 页面内操作:导航、snapshot ref、点击 / 输入 / 填表、等待、run_script。
 * 每道题都回读页面核对「真的生效」,只看工具返回 success 不算数。
 * 这个文件属于裁判层(.ankotti/evolve.json protected),AI 改进流程不得修改。
 */

/** 在页面里轮询某元素文本,直到包含 needle(最多约 5 秒);返回最后读到的文本 */
export async function waitText(t, selector, needle) {
  return t.js(`
    for (let i = 0; i < 50; i++) {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (el && el.textContent.includes(${JSON.stringify(needle)})) return el.textContent;
      await new Promise((r) => setTimeout(r, 100));
    }
    const el = document.querySelector(${JSON.stringify(selector)});
    return el ? el.textContent : null;`);
}

/** snapshot 里按可见文字找 ref(形如 `"第二个按钮" [ref=e3]`) */
export function refOf(snapshot, label) {
  const line = String(snapshot).split('\n').find((l) => l.includes(label) && /\[ref=/.test(l));
  return line ? /\[ref=([a-z]?\d+)\]/.exec(line)?.[1] ?? null : null;
}

export const pageTasks = [
  {
    id: 'nav.basic', area: 'navigate',
    async run(t) {
      const r = await t.call('navigate', { url: `${t.main}/a` });
      t.eq(r.data.title, 'Page A', 'navigate 返回的标题');
      const h = await t.call('get_element_text', { selector: 'h1' });
      t.eq(h.data.text, 'Alpha', 'h1 文本');
    },
  },
  {
    id: 'nav.rejects-file-url', area: 'navigate',
    async run(t) {
      await t.call('navigate', { url: 'file:///C:/Windows/win.ini' }, { expectError: true });
    },
  },
  {
    id: 'nav.history', area: 'navigate',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/history/1` });
      await t.call('click', { selector: '#next' });
      await t.call('wait_for_selector', { selector: 'p', timeout: 5000 });
      t.eq(await t.js('document.title'), 'History Two', '点链接后的标题');
      await t.call('go_back');
      t.eq(await t.js('location.pathname'), '/history/1', '后退后的路径');
      await t.call('go_forward');
      t.eq(await t.js('location.pathname'), '/history/2', '前进后的路径');
    },
  },
  {
    id: 'snapshot.click-by-ref', area: 'snapshot',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/refs` });
      const s = await t.call('snapshot', { interactiveOnly: true });
      t.expect(s.data.refCount >= 3, `refCount 应 ≥3,实际 ${s.data.refCount}`);
      const ref = refOf(s.data.snapshot, '第二个按钮');
      t.expect(ref, 'snapshot 里找不到「第二个按钮」的 ref');
      await t.call('click', { ref });
      t.eq(await t.js(`document.getElementById('ref-out').textContent`), 'REF-CLICKED-2', '按 ref 点击后的结果');
    },
  },
  {
    id: 'snapshot.type-by-ref', area: 'snapshot',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/refs` });
      const s = await t.call('snapshot', { interactiveOnly: true });
      const ref = refOf(s.data.snapshot, 'ref 输入框');
      t.expect(ref, 'snapshot 里找不到输入框的 ref');
      await t.call('type', { ref, text: 'typed-by-ref' });
      t.eq(await t.js(`document.getElementById('r-in').value`), 'typed-by-ref', '按 ref 输入后的值');
    },
  },
  {
    id: 'snapshot.truncates-large-page', area: 'snapshot',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/big` });
      const s = await t.call('snapshot', { maxChars: 2000 });
      t.eq(s.data.truncated, true, '大页面 truncated');
      t.expect(s.data.snapshot.length < 2600, `截断后仍有 ${s.data.snapshot.length} 字符`);
    },
  },
  {
    id: 'interact.type-click', area: 'interaction',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/form` });
      await t.call('type', { selector: '#name', text: '张三' });
      await t.call('click', { selector: '#submit' });
      const out = await t.js(`document.getElementById('out').textContent`);
      t.expect(String(out).startsWith('SUBMITTED:') && String(out).includes('"name":"张三"'), `提交结果不对:${out}`);
    },
  },
  {
    id: 'interact.fill-form', area: 'interaction',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/form` });
      const r = await t.call('fill_form', {
        fields: [
          { selector: '#name', value: '李四' },
          { selector: '#email', value: 'li@example.com' },
          { selector: '#city', value: 'sh', type: 'select' },
          { selector: '#agree', value: 'true', type: 'checkbox' },
          { selector: '#note', value: '多行\n备注' },
        ],
      });
      t.eq(r.data.filled, 5, '填好的字段数');
      await t.call('click', { selector: '#submit' });
      const out = await t.js(`document.getElementById('out').textContent`);
      t.eq(out, 'SUBMITTED:' + JSON.stringify({ name: '李四', email: 'li@example.com', city: 'sh', agree: true, note: '多行\n备注' }), '表单提交结果');
    },
  },
  {
    id: 'interact.select-by-label', area: 'interaction',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/form` });
      await t.call('select_option', { selector: '#city', label: '深圳' });
      t.eq(await t.js(`document.getElementById('city').value`), 'sz', '按文字选中的值');
    },
  },
  {
    id: 'interact.hover', area: 'interaction',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/hover` });
      await t.call('hover', { selector: '#menu' });
      t.eq(await waitText(t, '#hover-out', 'HOVER-YES'), 'HOVER-YES', '悬停效果');
    },
  },
  {
    id: 'interact.keyboard', area: 'interaction',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/keys` });
      await t.call('click', { selector: '#k' });
      await t.call('keyboard_press', { key: 'Enter' });
      t.eq(await waitText(t, '#key-out', 'KEY:Enter'), 'KEY:Enter', '按键效果');
    },
  },
  {
    id: 'interact.scroll-to-element', area: 'interaction',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/scroll` });
      await t.call('scroll', { selector: '#bottom' });
      const y = await t.js('window.scrollY');
      t.expect(y > 3000, `滚到底部元素后 scrollY=${y}`);
    },
  },
  {
    id: 'interact.drag-and-drop', area: 'interaction',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/drag` });
      await t.call('drag_and_drop', { source: '#src', target: '#dst' });
      t.eq(await waitText(t, '#dst', 'DROPPED'), 'DROPPED', '放置效果');
    },
  },
  {
    id: 'interact.viewport', area: 'interaction',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/a` });
      await t.call('set_viewport', { width: 800, height: 600 });
      t.eq(await t.js('window.innerWidth'), 800, '视口宽度');
      await t.call('set_viewport', { width: 1280, height: 800 });
    },
  },
  {
    id: 'wait.selector-appears', area: 'wait',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/dynamic` });
      await t.call('wait_for_selector', { selector: '.dyn', timeout: 5000 });
      const c = await t.call('get_page_content', { type: 'text', selector: '#root' });
      t.eq(String(c.data.content).replace(/\s+/g, ''), '甲乙丙', '动态内容');
    },
  },
  {
    id: 'wait.selector-detached', area: 'wait',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/dynamic` });
      await t.call('wait_for_selector', { selector: '#spinner', state: 'detached', timeout: 5000 });
      t.eq(await t.js(`!!document.getElementById('spinner')`), false, 'spinner 已移除');
    },
  },
  {
    id: 'wait.selector-timeout-reports-error', area: 'wait',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/a` });
      const t0 = Date.now();
      await t.call('wait_for_selector', { selector: '#never-there', timeout: 1000 }, { expectError: true });
      t.expect(Date.now() - t0 < 8000, `1 秒超时却等了 ${Date.now() - t0}ms`);
    },
  },
  {
    id: 'wait.wait-and-extract', area: 'wait',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/dynamic` });
      const r = await t.call('wait_and_extract', { waitSelector: '.dyn', extractSelector: '.dyn', timeout: 5000 });
      t.eq(r.data.items, ['甲', '乙', '丙'], '等待后提取');
    },
  },
  {
    id: 'read.attribute-and-html', area: 'read',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/table` });
      const a = await t.call('get_element_attribute', { selector: '#t tbody tr:first-child', attribute: 'data-id' });
      t.eq(a.data.value, 'p1', '第一行 data-id');
      const h = await t.call('get_page_content', { type: 'html', selector: '#t tbody' });
      t.expect(String(h.data.content).includes('data-id="p4"'), 'tbody HTML 里没有第 4 行');
    },
  },
  {
    id: 'script.execute-js', area: 'script',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/table` });
      const n = await t.js(`return document.querySelectorAll('tr.row').length;`);
      t.eq(n, 4, '行数');
      const obj = await t.js(`({ a: 1, b: [2, 3] })`);
      t.eq(obj, { a: 1, b: [2, 3] }, '对象字面量表达式');
    },
  },
  {
    id: 'script.run-script-ego', area: 'script',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/form` });
      const r = await t.call('run_script', {
        script: [
          "await __ego.waitFor('#name', 3000);",
          "await __ego.fill('#name', '王五');",
          "await __ego.click('#submit');",
          "await __ego.sleep(50);",
          "return { out: __ego.text('#out'), exists: __ego.exists('#agree'), missing: __ego.exists('#nope') };",
        ].join('\n'),
      });
      const res = r.data.result;
      t.expect(String(res?.out).includes('"name":"王五"'), `__ego 提交结果不对:${JSON.stringify(res)}`);
      t.eq([res.exists, res.missing], [true, false], '__ego.exists');
    },
  },
  {
    id: 'script.run-script-snapshot', area: 'script',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/refs` });
      const r = await t.call('run_script', { script: 'const s = await __ego.snapshot(); return typeof s === "string" ? s : JSON.stringify(s);' });
      t.expect(String(r.data.result).includes('第二个按钮'), '__ego.snapshot() 里没有按钮文字');
    },
  },
  {
    id: 'script.run-script-error', area: 'script',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/a` });
      const r = await t.call('run_script', { script: "throw new Error('EVAL-BOOM');" }, { expectError: true });
      t.expect(String(r.error).includes('EVAL-BOOM'), `报错里没带原始信息:${r.error}`);
    },
  },
];
