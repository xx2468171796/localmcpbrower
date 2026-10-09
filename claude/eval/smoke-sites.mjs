/**
 * 真实站点冒烟(只当参考,不计入放行):`npm run eval:smoke`。
 * 要能上外网(国外站点在公司网络下可能连不上,那几项失败属于环境问题)。
 * 外站会改版、会限流、网络会抖,所以这里的失败只打印、写 eval/smoke-results.json,退出码恒为 0
 * (加 --strict 才按失败退出,给人手动排查用)。和考卷一样起隔离的被测服务,不碰本机在用的浏览器 MCP。
 * 这个文件属于裁判层(.ankotti/evolve.json protected),AI 改进流程不得修改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, runTask, startServer } from './harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const strict = process.argv.includes('--strict');

const SITES = [
  {
    id: 'site.example-com', area: 'smoke',
    async run(t) {
      const r = await t.call('navigate', { url: 'https://example.com/' });
      t.expect(/Example Domain/.test(r.data.title), `标题:${r.data.title}`);
    },
  },
  {
    id: 'site.quotes-crawl', area: 'smoke', timeoutMs: 150_000,
    async run(t) {
      const r = await t.call('crawl_pages', {
        startUrl: 'https://quotes.toscrape.com/', nextPageSelector: 'li.next a', itemSelector: '.quote',
        fields: [{ name: 'text', selector: '.text' }], maxPages: 2,
      }, { timeout: 150_000 });
      t.expect(r.data.total >= 10, `只抓到 ${r.data.total} 条`);
    },
  },
  {
    id: 'site.books-extract', area: 'smoke',
    async run(t) {
      await t.call('navigate', { url: 'https://books.toscrape.com/' });
      const r = await t.call('extract_data', { itemSelector: 'article.product_pod', fields: [{ name: 'title', selector: 'h3 a', attribute: 'title', type: 'attr' }] });
      t.expect(r.data.items.length >= 10, `只抓到 ${r.data.items.length} 本`);
    },
  },
  {
    id: 'site.wikipedia-article', area: 'smoke', timeoutMs: 120_000,
    async run(t) {
      const r = await t.call('extract_article', { url: 'https://en.wikipedia.org/wiki/Model_Context_Protocol' }, { timeout: 120_000 });
      t.expect(String(r.data.markdown).length > 1000, '正文太短');
    },
  },
  {
    id: 'site.httpbin-form', area: 'smoke',
    async run(t) {
      await t.call('navigate', { url: 'https://httpbin.org/forms/post' });
      await t.call('fill_form', { fields: [{ selector: 'input[name=custname]', value: 'eval' }, { selector: 'input[name=custtel]', value: '123' }] });
      t.eq(await t.js(`document.querySelector('input[name=custname]').value`), 'eval', '填表');
    },
  },
  {
    id: 'site.bing-cn-search', area: 'smoke',
    async run(t) {
      await t.call('navigate', { url: 'https://cn.bing.com/search?q=model+context+protocol' });
      const l = await t.call('extract_links', { limit: 50 });
      t.expect(l.data.links.length >= 10, `只有 ${l.data.links.length} 个链接`);
    },
  },
  {
    id: 'site.batch-mixed', area: 'smoke', timeoutMs: 120_000,
    async run(t) {
      const r = await t.call('batch_fetch', { urls: ['https://example.com/', 'https://www.iana.org/help/example-domains'], extractSelector: 'h1', concurrency: 2 }, { timeout: 120_000 });
      t.expect(r.data.results.every((x) => x.success), JSON.stringify(r.data.results).slice(0, 200));
    },
  },
  {
    id: 'site.baidu-snapshot', area: 'smoke',
    async run(t) {
      await t.call('navigate', { url: 'https://www.baidu.com/' });
      const s = await t.call('snapshot', { interactiveOnly: true });
      t.expect(s.data.refCount >= 2, `refCount=${s.data.refCount}`);
    },
  },
];

let server = null;
let client = null;
const out = [];
try {
  server = await startServer({ root: ROOT, log: console.log });
  client = await connect(server.base);
  for (const site of SITES) {
    const r = await runTask(client, site, { base: server.base, dirs: server.dirs });
    out.push(r);
    console.log(`${r.pass ? '[OK]  ' : '[FAIL]'} ${r.id.padEnd(26)} ${String(r.ms).padStart(6)}ms${r.error ? '  ' + r.error : ''}`);
  }
} catch (e) {
  console.error('[smoke] 运行失败:', e instanceof Error ? e.message : e);
} finally {
  try { await client?.close(); } catch { /* noop */ }
  if (server) await server.stop();
}
fs.writeFileSync(path.join(HERE, 'smoke-results.json'), JSON.stringify({ generatedAt: new Date().toISOString(), sites: out }, null, 2) + '\n');
const failed = out.filter((r) => !r.pass).length;
console.log(`\n真实站点冒烟:${out.length - failed}/${SITES.length} 通过(只当参考,不计入放行)`);
process.exit(strict && (failed || out.length < SITES.length) ? 1 : 0);
