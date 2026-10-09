/**
 * 考卷 · 浏览器层:iframe(含跨站)、上传 / 下载 / 截图 / PDF、标签页、工作区隔离、cookie、网络与日志、屏蔽规则。
 * 这个文件属于裁判层(.ankotti/evolve.json protected),AI 改进流程不得修改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { refOf, waitText } from './tasks-page.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHit(t, pathname, before, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if ((t.hits.get(pathname) ?? 0) > before) return true;
    await sleep(100);
  }
  return false;
}

export const browserTasks = [
  {
    id: 'iframe.snapshot-sees-both-frames', area: 'iframe',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/frames` });
      await sleep(500);
      const s = await t.call('snapshot', { interactiveOnly: true });
      t.expect(refOf(s.data.snapshot, '同源按钮'), 'snapshot 里没有同源 iframe 的按钮');
      t.expect(refOf(s.data.snapshot, '跨站按钮'), 'snapshot 里没有跨站 iframe 的按钮');
    },
  },
  {
    id: 'iframe.same-origin-click', area: 'iframe',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/frames` });
      await sleep(500);
      const s = await t.call('snapshot', { interactiveOnly: true });
      await t.call('click', { ref: refOf(s.data.snapshot, '同源按钮') });
      const v = await t.js(`document.getElementById('same').contentDocument.getElementById('inner-out').textContent`);
      t.eq(v, 'INNER-CLICKED', '同源 iframe 点击效果');
    },
  },
  {
    id: 'iframe.cross-origin-click', area: 'iframe',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/frames` });
      await sleep(500);
      const s = await t.call('snapshot', { interactiveOnly: true });
      await t.call('click', { ref: refOf(s.data.snapshot, '跨站按钮') });
      await sleep(200);
      const after = await t.call('snapshot', {});
      t.expect(String(after.data.snapshot).includes('CROSS-CLICKED'), '跨站 iframe 点击后页面没变化');
    },
  },
  {
    id: 'iframe.cross-origin-type', area: 'iframe',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/frames` });
      await sleep(500);
      const s = await t.call('snapshot', { interactiveOnly: true });
      const ref = refOf(s.data.snapshot, '跨站输入');
      t.expect(ref, 'snapshot 里没有跨站 iframe 的输入框');
      await t.call('type', { ref, text: 'cross-typed' });
      const r = await t.call('get_element_attribute', { selector: 'iframe#cross', attribute: 'src' });
      t.expect(String(r.data.value).startsWith(t.other), '跨站 iframe 地址不对');
    },
  },
  {
    id: 'file.upload', area: 'file',
    async run(t) {
      const file = path.join(t.dirs.files, 'upload.txt');
      fs.writeFileSync(file, 'EVAL-UPLOAD-CONTENT');
      await t.call('navigate', { url: `${t.main}/upload` });
      await t.call('file_upload', { selector: '#file', filePath: file });
      t.eq(await waitText(t, '#file-out', 'FILE:'), 'FILE:upload.txt:EVAL-UPLOAD-CONTENT', '页面读到的上传文件');
    },
  },
  {
    id: 'file.download-link', area: 'file',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/download` });
      const before = t.hits.get('/files/report.csv') ?? 0;
      await t.call('click', { selector: '#dl' });
      t.expect(await waitHit(t, '/files/report.csv', before), '点下载链接后服务端没收到下载请求');
      t.eq(await t.js(`document.getElementById('dl-out').textContent`), 'DL-PAGE', '下载后页面仍可用');
    },
  },
  {
    id: 'file.screenshot', area: 'file',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/a` });
      const r = await t.call('take_screenshot', { name: 'eval-shot', format: 'jpeg' });
      const p = r.data.path;
      t.expect(p && fs.existsSync(p), `截图文件不存在:${p}`);
      const head = fs.readFileSync(p).subarray(0, 2);
      t.eq([head[0], head[1]], [0xff, 0xd8], 'JPEG 文件头');
      t.expect(path.resolve(p).startsWith(path.resolve(t.dirs.shots)), `截图没放进配置的目录:${p}`);
    },
  },
  {
    id: 'file.pdf-export', area: 'file',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/article` });
      const out = path.join(t.dirs.files, 'out.pdf');
      await t.call('pdf_export', { path: out });
      t.expect(fs.existsSync(out), 'PDF 没生成');
      t.eq(fs.readFileSync(out).subarray(0, 4).toString(), '%PDF', 'PDF 文件头');
    },
  },
  {
    id: 'tabs.open-switch-close', area: 'tabs',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/a` });
      const n = await t.call('new_tab', { url: `${t.main}/b` });
      t.eq(n.data.index, 1, '新标签页序号');
      const l = await t.call('list_tabs');
      t.eq(l.data.tabs.map((x) => [new URL(x.url).pathname, x.active]), [['/a', false], ['/b', true]], '标签页列表');
      t.eq(await t.js('document.title'), 'Page B', '新标签页成为当前页');
      const s = await t.call('switch_tab', { index: 0 });
      t.eq(s.data.title, 'Page A', '切回第一个标签页');
      const c = await t.call('close_tab', { index: 1 });
      t.eq(c.data.remaining, 1, '关掉后剩余');
      t.eq(await t.js('document.title'), 'Page A', '关掉别的标签页后当前页不变');
    },
  },
  {
    id: 'tabs.close-invalid-index', area: 'tabs',
    async run(t) {
      await t.call('close_tab', { index: 9 }, { expectError: true });
      const l = await t.call('list_tabs');
      t.eq(l.data.tabs.length, 1, '误关不存在的标签页后标签页数');
    },
  },
  {
    id: 'space.cookie-isolation', area: 'space',
    timeoutMs: 120_000,
    async run(t) {
      await t.call('navigate', { url: `${t.main}/set-cookie` });
      await t.call('space_new', { name: 'evaliso' });
      try {
        await t.call('navigate', { url: `${t.main}/echo-cookie` });
        const iso = await t.js(`document.getElementById('cookie').textContent`);
        t.expect(!String(iso).includes('SRV-COOKIE'), `新工作区看到了默认工作区的 cookie:${iso}`);
        const list = await t.call('space_list');
        t.eq(list.data.active, 'evaliso', '当前工作区');
      } finally {
        await t.call('space_switch', { name: 'default' });
      }
      await t.call('navigate', { url: `${t.main}/echo-cookie` });
      const dflt = await t.js(`document.getElementById('cookie').textContent`);
      t.expect(String(dflt).includes('eval_srv=SRV-COOKIE'), `默认工作区的 cookie 丢了:${dflt}`);
      await t.call('space_close', { name: 'evaliso' });
      const after = await t.call('space_list');
      t.expect(!after.data.spaces.some((s) => s.name === 'evaliso' && s.alive), '关掉的工作区还活着');
      // default 工作区不许关
      await t.call('space_close', { name: 'default' }, { expectError: true });
      t.eq((await t.call('space_list')).data.active, 'default', '当前工作区');
    },
  },
  {
    id: 'cookie.set-get-send', area: 'cookie',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/a` });
      await t.call('set_cookies', { cookies: [{ name: 'eval_c', value: '42', domain: '127.0.0.1', path: '/' }] });
      const g = await t.call('get_cookies', { name: 'eval_c' });
      t.eq(g.data.cookies.map((c) => c.value), ['42'], 'get_cookies');
      await t.call('navigate', { url: `${t.main}/echo-cookie` });
      const sent = await t.js(`document.getElementById('cookie').textContent`);
      t.expect(String(sent).includes('eval_c=42'), `请求没带上 cookie:${sent}`);
    },
  },
  {
    id: 'log.network', area: 'log',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/network` });
      t.eq(await waitText(t, '#net', 'NET:'), 'NET:PONG-42', '页面 fetch 结果');
      const n = await t.call('get_network');
      const hit = n.data.find((e) => String(e.url).includes('/api/ping'));
      t.expect(hit, 'get_network 里没有 /api/ping');
    },
  },
  {
    id: 'log.console', area: 'log',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/console` });
      await sleep(300);
      const r = await t.call('get_console_logs');
      const texts = r.data.map((e) => e.text);
      t.expect(texts.some((x) => x.includes('EVAL-CONSOLE-LOG')), `没收到 console.log:${JSON.stringify(texts).slice(0, 200)}`);
      t.expect(r.data.some((e) => e.type === 'error' && e.text.includes('EVAL-CONSOLE-ERROR')), '没收到 console.error');
    },
  },
  {
    id: 'block.images', area: 'block',
    async run(t) {
      await t.call('set_block_rules', { blockImages: true, blockMedia: true, blockAds: true });
      try {
        const before = t.hits.get('/img/pixel.png') ?? 0;
        await t.call('navigate', { url: `${t.main}/images` });
        t.eq(await waitText(t, '#img-out', 'IMG-'), 'IMG-BLOCKED', '图片应被屏蔽');
        t.eq(t.hits.get('/img/pixel.png') ?? 0, before, '被屏蔽的图片不该打到服务端');
      } finally {
        await t.call('set_block_rules', { blockImages: false, blockMedia: false, blockAds: false });
      }
      await t.call('navigate', { url: `${t.main}/images` });
      t.eq(await waitText(t, '#img-out', 'IMG-'), 'IMG-LOADED', '解除屏蔽后图片应能加载');
    },
  },
  {
    id: 'block.intercept-pattern', area: 'block',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/a` });
      await t.call('intercept_requests', { urlPattern: '*/api/ping*', action: 'block' });
      await t.call('navigate', { url: `${t.main}/network` });
      await sleep(800);
      const v = await t.js(`document.getElementById('net').textContent`);
      t.eq(v, 'WAIT', '被拦截的请求不该返回结果');
    },
  },
  {
    id: 'health.browser-alive', area: 'health',
    async run(t) {
      const res = await fetch(`${t.base}/health`);
      const h = await res.json();
      t.eq([res.status, h.status, h.browserAlive], [200, 'ok', true], '/health');
    },
  },
];
