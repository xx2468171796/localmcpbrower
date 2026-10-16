/**
 * 批量 / 翻页抓取:batch_fetch / crawl_pages / discover_urls。
 * 共同约定:每轮先查取消;等待有上限;按时间预算(longTaskBudgetMs)提前收工并带回已抓到的部分;报进度。
 */

import type { Page } from 'patchright';
import { getBrowserManager } from '../browser.js';
import { failFrom, ToolError } from '../errors.js';
import { currentSignal, reportProgress, throwIfCancelled } from '../context.js';
import { BatchFetchSchema, CrawlPagesSchema, DiscoverUrlsSchema } from '../schemas.js';
import type { ToolResult } from '../types.js';
import { parseInput, settle, sig } from './common.js';
import { evalStable, itemsScript } from './extract.js';
import { parseSitemapLocs } from './pure.js';
import { longTaskBudgetMs, sleep, withTimeout } from './timing.js';
import { deskGate } from '../desk/runtime.js';

type FetchResult = { url: string; title?: string; content?: string; status?: number; success: boolean; error?: string };

async function fetchOne(page: Page, url: string, waitFor?: string, extractSelector?: string): Promise<FetchResult> {
  try {
    const resp = await page.goto(url, { ...sig(), waitUntil: 'domcontentloaded', timeout: 15000 });
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 8000, state: 'visible', ...sig() }).catch(() => { /* 等不到也照样取 */ });
    const title = await withTimeout(page.title(), 5000, '读标题').catch(() => '');
    let content: string | undefined;
    if (extractSelector) {
      content = await evalStable<string>(page, `(function() {
        var el = document.querySelector(${JSON.stringify(extractSelector)});
        return el ? (el.textContent || '').trim() : '';
      })()`).catch(() => undefined);
    }
    return { url, title, content, success: true, ...(resp ? { status: resp.status() } : {}) };
  } catch (err) {
    if (err instanceof ToolError && err.code === 'CANCELLED') throw err;
    return { url, success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 批量抓取多个 URL */
export async function batchFetch(input: unknown): Promise<ToolResult<{ results: FetchResult[]; incomplete?: boolean; skipped?: number }>> {
  try {
    const { urls, waitFor, extractSelector, delay, concurrency } = parseInput(BatchFetchSchema, input);
    const bm = getBrowserManager();
    const main = await bm.getPage();
    const deadline = Date.now() + longTaskBudgetMs();
    // 工作池:每个标签页轮流领下一个 URL;结果按原顺序放回。concurrency=1 时就是逐个抓
    const results: Array<FetchResult | undefined> = new Array(urls.length);
    let next = 0;
    let done = 0;
    let outOfTime = false;
    const work = async (page: Page): Promise<void> => {
      for (;;) {
        throwIfCancelled();
        if (Date.now() > deadline) { outOfTime = true; return; }
        const i = next++;
        const url = urls[i];
        if (url === undefined) return;
        results[i] = await fetchOne(page, url, waitFor, extractSelector);
        reportProgress(++done, urls.length, `已抓 ${done}/${urls.length}: ${url}`);
        if (delay > 0 && next < urls.length) await sleep(delay, currentSignal());
      }
    };
    const extra: Page[] = [];
    try {
      for (let w = 1; w < Math.min(concurrency, urls.length); w++) extra.push(await bm.openWorkerTab());
      await Promise.all([main, ...extra].map(work));
    } finally {
      await Promise.all(extra.map((p) => p.close().catch(() => { /* 可能已被关 */ })));
    }
    const skipped = results.filter((r) => r === undefined).length;
    const filled = results.map((r, i) => r ?? { url: urls[i] ?? '', success: false, error: '时间预算用完,未抓取' });
    return { success: true, data: { results: filled, ...(outOfTime && skipped ? { incomplete: true, skipped } : {}) } };
  } catch (error) {
    return failFrom(error);
  }
}

/** 下一页按钮的状态:真链接直接 goto(最稳);否则点击 */
async function nextPageInfo(page: Page, selector: string): Promise<{ exists: boolean; href: string | null; disabled: boolean }> {
  return evalStable(page, `(function() {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { exists: false, href: null, disabled: false };
    var a = el.closest('a[href]') || (el.querySelector && el.querySelector('a[href]'));
    var raw = a ? (a.getAttribute('href') || '').trim() : '';
    var href = a && raw && raw !== '#' && !/^javascript:/i.test(raw) && /^https?:/i.test(a.href) ? a.href : null;
    var disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || /(^|\\s)disabled(\\s|$)/.test(el.className || '');
    return { exists: true, href: href, disabled: disabled };
  })()`, '找下一页');
}

/** 当前页条目的指纹:翻页后没变化(下一页按钮失效 / 指向本页)就停,不重复抓同一页 */
const fingerprint = (items: Array<Record<string, string>>): string => JSON.stringify(items.slice(0, 5)) + items.length;

/**
 * 翻到下一页。以前点击后立刻 waitForLoadState —— 跳转还没开始,当前文档本来就是 loaded,
 * 于是马上返回,接着提取撞上「Execution context was destroyed」(考卷 crawl.pagination / crawl.max-pages 挂在这)。
 * 现在:有真链接就 goto 并等 DOM 就绪;只能点击的(SPA / 表单翻页)点完等到条目变化或跳转完成。
 */
async function gotoNext(page: Page, selector: string, before: string, itemsJs: string): Promise<boolean> {
  const info = await nextPageInfo(page, selector);
  if (!info.exists || info.disabled) return false;
  if (info.href && info.href !== page.url()) {
    await page.goto(info.href, { ...sig(), waitUntil: 'domcontentloaded', timeout: 15000 });
    return true;
  }
  await page.click(selector, { timeout: 5000, noWaitAfter: true, ...sig() })
    .catch(() => page.click(selector, { force: true, timeout: 5000, noWaitAfter: true, ...sig() }));
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    await sleep(200, currentSignal());
    await settle(page, 5000);
    const now = await evalStable<Array<Record<string, string>>>(page, itemsJs).catch(() => null);
    if (now && fingerprint(now) !== before) return true;
  }
  return false;
}

type CrawlData = { items: Array<Record<string, string>>; pages: number; total: number; incomplete?: boolean; stoppedReason?: string };

/** 分页爬取 */
export async function crawlPages(input: unknown): Promise<ToolResult<CrawlData>> {
  try {
    const { startUrl, nextPageSelector, itemSelector, fields, maxPages, delay } = parseInput(CrawlPagesSchema, input);
    const page = await getBrowserManager().getPage();
    const deadline = Date.now() + longTaskBudgetMs();
    const itemsJs = itemsScript(itemSelector, fields, 100_000);
    const allItems: Array<Record<string, string>> = [];
    const seen = new Set<string>();
    let pageCount = 0;
    let stoppedReason = '';
    await page.goto(startUrl, { ...sig(), waitUntil: 'domcontentloaded', timeout: 15000 })
      .catch((e: unknown) => { throw new ToolError('NAVIGATION_FAILED', e instanceof Error ? e.message : String(e)); });
    for (;;) {
      throwIfCancelled();
      const items = await evalStable<Array<Record<string, string>>>(page, itemsJs);
      const fp = fingerprint(items);
      if (seen.has(fp) && items.length) { stoppedReason = '下一页内容与已抓页面相同,已停止'; break; }
      seen.add(fp);
      pageCount++;
      allItems.push(...items);
      reportProgress(pageCount, maxPages, `已爬 ${pageCount}/${maxPages} 页,累计 ${allItems.length} 条`);
      if (pageCount >= maxPages) break;
      if (Date.now() > deadline) { stoppedReason = '时间预算用完,返回已爬到的部分'; break; }
      if (delay > 0) await sleep(delay, currentSignal());
      const moved = await gotoNext(page, nextPageSelector, fp, itemsJs).catch((e: unknown) => {
        if (e instanceof ToolError && e.code === 'CANCELLED') throw e;
        stoppedReason = `翻页失败:${e instanceof Error ? e.message.split('\n')[0] : String(e)}`;
        return false;
      });
      if (!moved) break;
    }
    const incomplete = stoppedReason.startsWith('时间预算') || stoppedReason.startsWith('翻页失败');
    return { success: true, data: { items: allItems, pages: pageCount, total: allItems.length,
      ...(incomplete ? { incomplete: true } : {}), ...(stoppedReason ? { stoppedReason } : {}) } };
  } catch (error) {
    return failFrom(error);
  }
}

/** 走 robots.txt + sitemap(含 sitemap-index 下钻),最多抓 maxFetches 个 sitemap */
async function sitemapUrls(fetchText: (u: string) => Promise<string>, origin: string, maxFetches: number): Promise<Set<string>> {
  const found = new Set<string>();
  const queue: string[] = [];
  const robots = await fetchText(`${origin}/robots.txt`);
  for (const line of robots.split(/\r?\n/)) {
    const m = /^\s*sitemap:\s*(\S+)/i.exec(line);
    if (m?.[1]) queue.push(m[1].trim());
  }
  if (!queue.includes(`${origin}/sitemap.xml`)) queue.push(`${origin}/sitemap.xml`);
  const fetched = new Set<string>();
  while (queue.length > 0 && fetched.size < maxFetches) {
    throwIfCancelled();
    const sm = queue.shift();
    if (!sm || fetched.has(sm)) continue;
    fetched.add(sm);
    reportProgress(fetched.size, maxFetches + 1, `读取 sitemap ${fetched.size}: ${sm}`);
    const xml = await fetchText(sm);
    if (!xml) continue;
    const locs = parseSitemapLocs(xml);
    const children = locs.filter((l) => /\.xml(\?|$)/i.test(l));
    const isIndex = /<sitemapindex/i.test(xml) || (children.length > 0 && children.length === locs.length);
    if (isIndex) queue.push(...children);
    else for (const l of locs) found.add(l);
  }
  return found;
}

/** 站点 URL 发现:走 sitemap.xml + robots.txt + 页面链接,快速探明站点页面地址 */
export async function discoverUrls(input: unknown): Promise<ToolResult<{
  urls: string[]; total: number; fromSitemap: number; fromLinks: number; truncated: boolean;
}>> {
  try {
    const { url, maxUrls, sameDomainOnly, includeSitemap } = parseInput(DiscoverUrlsSchema, input);
    const page = await getBrowserManager().getPage();
    const request = page.context().request;
    const root = new URL(url);
    /**
     * 抓取文本,8 秒超时,失败返回空。
     * 这是服务端直接发的请求,不经过浏览器的 route(工位白名单就挡不到它):每一跳(含 robots 里写的任意 sitemap 地址、
     * 重定向目标)都自己过一遍白名单,不许的当没抓到。
     */
    const fetchText = async (target: string): Promise<string> => {
      try {
        let at = target;
        for (let hop = 0; hop <= 5; hop++) {
          if (!deskGate.allows(at)) return '';
          const resp = await withTimeout(request.get(at, { timeout: 8000, failOnStatusCode: false, maxRedirects: 0 }), 9000, '抓取', { signal: currentSignal() });
          const loc = resp.headers()['location'];
          if (resp.status() >= 300 && resp.status() < 400 && loc) { at = new URL(loc, at).href; continue; }
          return resp.ok() ? await withTimeout(resp.text(), 8000, '读取响应') : '';
        }
        return '';
      } catch (e) {
        if (e instanceof ToolError && e.code === 'CANCELLED') throw e;
        return '';
      }
    };
    const fromSm = includeSitemap ? await sitemapUrls(fetchText, root.origin, 10) : new Set<string>();
    const linkUrls = new Set<string>();
    throwIfCancelled();
    reportProgress(1, 1, `读取页面链接: ${url}`);
    try {
      await page.goto(url, { ...sig(), waitUntil: 'domcontentloaded', timeout: 15000 });
      const hrefs = await evalStable<string[]>(page, `Array.from(document.querySelectorAll('a[href]')).map(function(a){ return a.href; })`);
      for (const h of hrefs) linkUrls.add(h.split('#')[0] ?? h);
    } catch (e) {
      if (e instanceof ToolError && e.code === 'CANCELLED') throw e;
      /* 页面抓取失败不影响 sitemap 结果 */
    }
    const seen = new Set<string>();
    const merged: string[] = [];
    let fromSitemap = 0;
    let fromLinks = 0;
    for (const [src, set] of [['sitemap', fromSm], ['links', linkUrls]] as const) {
      for (const raw of set) {
        if (!/^https?:\/\//i.test(raw)) continue;
        let host: string;
        try { host = new URL(raw).hostname; } catch { continue; }
        if ((sameDomainOnly && host !== root.hostname) || seen.has(raw)) continue;
        seen.add(raw);
        merged.push(raw);
        if (src === 'sitemap') fromSitemap++; else fromLinks++;
      }
    }
    const urls = merged.slice(0, maxUrls);
    return { success: true, data: { urls, total: urls.length, fromSitemap, fromLinks, truncated: merged.length > maxUrls } };
  } catch (error) {
    return failFrom(error);
  }
}
