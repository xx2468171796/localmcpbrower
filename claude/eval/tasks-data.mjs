/**
 * 考卷 · 抓取与提取:extract_data / extract_links / batch_fetch / crawl_pages / extract_article / discover_urls。
 * 这个文件属于裁判层(.ankotti/evolve.json protected),AI 改进流程不得修改。
 */

export const dataTasks = [
  {
    id: 'extract.data-table', area: 'extract',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/table` });
      const r = await t.call('extract_data', {
        itemSelector: 'tr.row',
        fields: [
          { name: 'name', selector: '.n' },
          { name: 'price', selector: '.p' },
          { name: 'href', selector: 'a', attribute: 'href', type: 'attr' },
        ],
      });
      t.eq(r.data.items, [
        { name: '苹果', price: '3.5', href: '/item/p1' },
        { name: '香蕉', price: '2.0', href: '/item/p2' },
        { name: '樱桃', price: '18.8', href: '/item/p3' },
        { name: '榴莲', price: '66.6', href: '/item/p4' },
      ], '表格数据');
      const lim = await t.call('extract_data', { itemSelector: 'tr.row', fields: [{ name: 'name', selector: '.n' }], limit: 2 });
      t.eq(lim.data.items.map((i) => i.name), ['苹果', '香蕉'], 'limit=2 的结果');
    },
  },
  {
    id: 'extract.links-filter-and-scope', area: 'extract',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/links` });
      const f = await t.call('extract_links', { filter: '/docs/' });
      t.eq(f.data.links.map((l) => new URL(l.href).pathname).sort(), ['/docs/api', '/docs/guide'], 'filter 结果');
      const s = await t.call('extract_links', { selector: '#nav' });
      t.eq(s.data.links.map((l) => l.text), ['A 页', 'B 页'], 'selector 限定范围');
    },
  },
  {
    id: 'batch.fetch-in-order', area: 'batch',
    async run(t) {
      const urls = ['a', 'b', 'c'].map((p) => `${t.main}/${p}`);
      const r = await t.call('batch_fetch', { urls, extractSelector: '.v', delay: 0 });
      t.eq(r.data.results.map((x) => x.content), ['VALUE-A', 'VALUE-B', 'VALUE-C'], '按顺序的内容');
      t.eq(r.data.results.map((x) => x.title), ['Page A', 'Page B', 'Page C'], '标题');
    },
  },
  {
    id: 'batch.fetch-concurrent', area: 'batch',
    async run(t) {
      const urls = ['c', 'a', 'b', 'a'].map((p) => `${t.main}/${p}`);
      const r = await t.call('batch_fetch', { urls, extractSelector: 'h1', delay: 0, concurrency: 3 });
      t.eq(r.data.results.map((x) => x.content), ['Charlie', 'Alpha', 'Bravo', 'Alpha'], '并发时结果仍按原顺序');
      const tabs = await t.call('list_tabs');
      t.eq(tabs.data.tabs.length, 1, '并发抓完后多开的标签页应关掉');
    },
  },
  {
    id: 'batch.fetch-missing-page', area: 'batch',
    async run(t) {
      const r = await t.call('batch_fetch', { urls: [`${t.main}/a`, `${t.main}/does-not-exist`], extractSelector: '.v', delay: 0 });
      t.eq(r.data.results.length, 2, '结果条数');
      t.eq(r.data.results[0].content, 'VALUE-A', '正常页内容');
      t.expect(!r.data.results[1].content, `404 页不该抽到内容:${r.data.results[1].content}`);
    },
  },
  {
    id: 'crawl.pagination', area: 'crawl',
    async run(t) {
      const r = await t.call('crawl_pages', {
        startUrl: `${t.main}/list/1`, nextPageSelector: 'a.next', itemSelector: 'li.item',
        fields: [{ name: 't', selector: '.t' }], maxPages: 5, delay: 0,
      });
      t.eq(r.data.pages, 3, '翻页数');
      const want = [1, 2, 3].flatMap((p) => [1, 2, 3].map((i) => `第${p}页-条目${i}`));
      t.eq(r.data.items.map((i) => i.t), want, '翻页抓到的条目');
    },
  },
  {
    id: 'crawl.max-pages', area: 'crawl',
    async run(t) {
      const r = await t.call('crawl_pages', {
        startUrl: `${t.main}/list/1`, nextPageSelector: 'a.next', itemSelector: 'li.item',
        fields: [{ name: 't', selector: '.t' }, { name: 'u', selector: 'a', attribute: 'href', type: 'attr' }], maxPages: 2, delay: 0,
      });
      t.eq(r.data.pages, 2, 'maxPages=2 的页数');
      t.eq(r.data.total, 6, '条目数');
      t.eq(r.data.items[5], { t: '第2页-条目3', u: '/detail/2-3' }, '最后一条');
    },
  },
  {
    id: 'article.extract-clean', area: 'article',
    async run(t) {
      const r = await t.call('extract_article', { url: `${t.main}/article` });
      t.eq(r.data.title, 'Eval Article Title', '文章标题');
      const md = String(r.data.markdown);
      t.expect(md.includes('ARTICLE-END-MARKER'), '正文不完整(缺结尾标记)');
      t.expect(md.includes('考卷文章第一段'), '正文缺第一段');
      for (const noise of ['NAV-NOISE', 'FOOTER-NOISE', 'SIDEBAR-AD']) t.expect(!md.includes(noise), `正文混进了 ${noise}`);
      // 不传 url:提取当前页
      const cur = await t.call('extract_article', {});
      t.expect(String(cur.data.markdown).includes('ARTICLE-END-MARKER'), '不传 url 时应提取当前页');
    },
  },
  {
    id: 'discover.sitemap-and-links', area: 'discover',
    async run(t) {
      const r = await t.call('discover_urls', { url: `${t.main}/`, maxUrls: 50 }, { timeout: 90_000 });
      const paths = new Set(r.data.urls.map((u) => new URL(u).pathname));
      for (const p of ['/a', '/b', '/c', '/article', '/form']) t.expect(paths.has(p), `没发现 ${p}`);
      t.expect(r.data.fromSitemap >= 4, `sitemap 只贡献了 ${r.data.fromSitemap} 条`);
      t.expect(![...paths].some((p) => p === '/x'), '不该带进外站链接');
    },
  },
  {
    id: 'report.page-report', area: 'read',
    async run(t) {
      await t.call('navigate', { url: `${t.main}/form` });
      const r = await t.call('generate_page_report', {});
      const s = JSON.stringify(r.data);
      t.expect(s.includes('表单页'), '报告里没有页面标题');
    },
  },
];
