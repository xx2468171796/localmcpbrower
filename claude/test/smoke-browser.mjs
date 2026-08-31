/**
 * 浏览器 MCP 冒烟测试 —— 46 个工具全覆盖,走真实调用路径(shim → named pipe → 常驻服务)。
 *
 *   node test/smoke-browser.mjs [headless|headed] [临时目录]
 *
 * 设计要点(改这个文件前先看):
 * - **只看「返回 success」不算通过**。点击/拖拽/勾选这类操作,工具返回成功但页面毫无变化是
 *   真实发生过的;所以交互类步骤后面统一再用 execute_js 回读 DOM,验证「真的生效」。
 * - fixture 自己造,不依赖外站 DOM 结构 —— 外站改版会让测试变成随机失败。
 * - 拖拽 fixture 必须给放置目标绑 dragover + preventDefault,否则浏览器默认禁止放置,
 *   drop 永远不触发,会被误读成 drag_and_drop 坏了。
 * - 不写任何凭据:本文件会随仓库镜像出去,且 Git 历史永久留存。
 */
import os from 'node:os';
import path from 'node:path';
const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

const SCRATCH = process.argv[3] || os.tmpdir();
import fs from 'node:fs';
fs.writeFileSync(path.join(SCRATCH, 'upload.txt'), 'smoke upload probe');

const c = new Client({ name: 'sweep', version: '1' }, { capabilities: {} });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), 'bin', 'shim.mjs'), process.argv[2] || 'headless'] }));

const called = new Set();
const results = [];
async function step(name, args = {}, opts = {}) {
  called.add(name);
  const t0 = Date.now();
  try {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: opts.timeout ?? 60000 });
    const txt = r.content?.[0]?.text ?? '';
    let parsed; try { parsed = JSON.parse(txt); } catch { parsed = { raw: txt.slice(0, 200) }; }
    const ok = parsed?.success !== false;
    results.push({ name, ok, ms: Date.now() - t0, note: (opts.note ? opts.note(parsed) : '') || (ok ? '' : parsed.error) });
    return parsed;
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, note: '抛异常: ' + (e.message || e) });
    return null;
  }
}
const brief = (o, n = 90) => JSON.stringify(o?.data ?? o).slice(0, n);

const FIXTURE = [
  "const d = document.createElement('div'); d.id='fx';",
  "d.innerHTML = '<input id=\"fx-input\">'",
  "  + '<select id=\"fx-select\"><option value=\"a\">A</option><option value=\"b\">B</option><option value=\"c\">C</option></select>'",
  "  + '<input type=\"checkbox\" id=\"fx-check\">'",
  "  + '<input type=\"file\" id=\"fx-file\">'",
  "  + '<a id=\"fx-a\" href=\"https://fixture.example/x\">链接</a>'",
  "  + '<button id=\"fx-btn\">按钮</button><span id=\"fx-out\">未点击</span>'",
  "  + '<div id=\"fx-drag\" draggable=\"true\">拖我</div><div id=\"fx-drop\">放这</div>'",
  "  + '<ul><li class=\"fx-item\"><span class=\"fx-t\">条目1</span><a href=\"/i1\">l1</a></li>'",
  "  + '<li class=\"fx-item\"><span class=\"fx-t\">条目2</span><a href=\"/i2\">l2</a></li></ul>';",
  "document.body.appendChild(d);",
  "document.getElementById('fx-btn').addEventListener('click', function(){ document.getElementById('fx-out').textContent = '已点击'; });",
  "document.getElementById('fx-drop').addEventListener('drop', function(){ document.getElementById('fx-drop').textContent = '已放置'; });",
  "return 'fixture ready';",
].join('\n');

// ───── A. 页面内交互(自建 fixture,不依赖外站结构)
await step('set_viewport', { width: 1280, height: 800 });
await step('navigate', { url: 'https://example.com' });
await step('execute_js', { script: FIXTURE }, { note: p => brief(p, 40) });
await step('wait_for_selector', { selector: '#fx-input' });
await step('type', { selector: '#fx-input', text: 'hello' });
await step('get_element_text', { selector: 'h1' }, { note: p => brief(p, 40) });
await step('get_element_attribute', { selector: '#fx-a', attribute: 'href' }, { note: p => brief(p, 50) });
await step('get_page_content', { type: 'text', selector: 'h1' }, { note: p => brief(p, 40) });
await step('fill_form', {
  fields: [
    { selector: '#fx-input', value: 'formval' },
    { selector: '#fx-select', value: 'b', type: 'select' },
    { selector: '#fx-check', value: 'true', type: 'checkbox' },
  ],
});
await step('select_option', { selector: '#fx-select', value: 'c' });
await step('keyboard_press', { key: 'End' });
await step('hover', { selector: '#fx-btn' });
await step('click', { selector: '#fx-btn' });
await step('snapshot', { interactiveOnly: true }, { note: p => 'refCount=' + p?.data?.refCount });
await step('scroll', { y: 200 });
await step('drag_and_drop', { source: '#fx-drag', target: '#fx-drop' });
await step('file_upload', { selector: '#fx-file', filePath: path.join(SCRATCH, 'upload.txt') });

// 关键:验证交互「真的生效」,而不只是「调用没报错」
await step('execute_js', {
  script: [
    "return { click: document.getElementById('fx-out').textContent,",
    "  drop: document.getElementById('fx-drop').textContent,",
    "  select: document.getElementById('fx-select').value,",
    "  check: document.getElementById('fx-check').checked,",
    "  input: document.getElementById('fx-input').value,",
    "  file: (document.getElementById('fx-file').files[0] || {}).name || null,",
    "  scrollY: window.scrollY };",
  ].join('\n'),
}, { note: p => '实际效果 ' + brief(p, 170) });

await step('extract_data', {
  itemSelector: '.fx-item',
  fields: [{ name: 't', selector: '.fx-t' }, { name: 'u', selector: 'a', attribute: 'href', type: 'attr' }],
}, { note: p => brief(p, 90) });
await step('wait_and_extract', { waitSelector: '.fx-item', extractSelector: '.fx-t' }, { note: p => brief(p, 60) });
await step('extract_links', { filter: 'fixture.example' }, { note: p => (p?.data?.links?.length ?? '?') + ' 条' });
// run_script:__ego 助手把「等待→填值→回读」压成一次往返,这里顺带验证它确实注入了
await step('run_script', {
  script: [
    "await __ego.waitFor('#fx-input', 3000);",
    "await __ego.fill('#fx-input', 'via-ego');",
    "return { value: __ego.$('#fx-input').value, exists: __ego.exists('#fx-btn'), text: __ego.text('h1') };",
  ].join('\n'),
}, { note: p => brief(p, 90) });
await step('take_screenshot', { name: 'sweep', format: 'jpeg' }, { note: p => brief(p, 70) });
await step('pdf_export', { path: path.join(SCRATCH, 'sweep.pdf') }, { note: p => brief(p, 70) });
await step('generate_page_report', {}, { note: p => brief(p, 70) });
await step('set_cookies', { cookies: [{ name: 'sweep_probe', value: '42', domain: 'example.com', path: '/' }] });
await step('get_cookies', { name: 'sweep_probe' }, { note: p => brief(p, 90) });

// ───── B. 标签页与历史
await step('new_tab', { url: 'https://example.com' });
await step('list_tabs', {}, { note: p => (p?.data?.tabs?.length ?? '?') + ' 个' });
await step('switch_tab', { index: 0 });
await step('close_tab', { index: 1 });
await step('navigate', { url: 'https://www.wikipedia.org/' });
await step('go_back', {}, { note: p => brief(p, 50) });
await step('go_forward', {}, { note: p => brief(p, 50) });

// ───── C. 网络与批量
await step('intercept_requests', { urlPattern: '*.png', action: 'block' });
await step('set_block_rules', { blockImages: true });
await step('get_network', {}, { note: p => (p?.data?.length ?? '?') + ' 条' });
await step('get_console_logs', {}, { note: p => (p?.data?.length ?? '?') + ' 条' });
await step('discover_urls', { url: 'https://example.com', maxUrls: 5 }, { timeout: 90000, note: p => brief(p, 70) });
await step('batch_fetch', { urls: ['https://example.com', 'https://www.iana.org/help/example-domains'], extractSelector: 'h1' },
  { timeout: 120000, note: p => brief(p, 90) });
await step('crawl_pages', {
  startUrl: 'https://quotes.toscrape.com/', nextPageSelector: 'li.next a',
  itemSelector: '.quote', fields: [{ name: 'text', selector: '.text' }], maxPages: 2,
}, { timeout: 150000, note: p => '抓到 ' + (p?.data?.items?.length ?? p?.data?.length ?? '?') + ' 条' });
await step('extract_article', { url: 'https://en.wikipedia.org/wiki/Model_Context_Protocol' },
  { timeout: 120000, note: p => brief(p, 80) });

// ───── D. 工作区
await step('space_list', {}, { note: p => (p?.data?.spaces?.length ?? '?') + ' 个' });
await step('space_new', { name: 'sweep-tmp' });
await step('space_switch', { name: 'default' });
await step('space_close', { name: 'sweep-tmp' });

// ───── E. 人工接管
await step('wait_for_human', { appears: 'body', timeoutSec: 5 }, { timeout: 30000, note: p => brief(p, 80) });
await step('request_human', { message: '自动化探测:预期被「无 elicitation 能力」的客户端直接拒绝,不应挂起' },
  { timeout: 20000, note: p => brief(p, 110) });

// ───── 汇总
const all = (await c.listTools()).tools.map(t => t.name);
const missed = all.filter(n => !called.has(n));
console.log('\n──────── 逐项结果 ────────');
for (const r of results) console.log((r.ok ? '[OK]  ' : '[FAIL]') + ' ' + r.name.padEnd(22) + String(r.ms).padStart(7) + 'ms  ' + (r.note ?? ''));
const fails = results.filter(r => !r.ok);
console.log('\n覆盖 ' + called.size + '/' + all.length + ' 个工具;未调用: ' + (missed.length ? missed.join(', ') : '无'));
console.log('通过 ' + (results.length - fails.length) + '/' + results.length + (fails.length ? ',失败: ' + fails.map(f => f.name).join(', ') : ''));
await c.close();
process.exit(fails.length ? 1 : 0);
