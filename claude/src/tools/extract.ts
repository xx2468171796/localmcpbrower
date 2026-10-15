/**
 * 提取类工具:extract_links / extract_data / wait_and_extract / extract_article,
 * 以及请求屏蔽 set_block_rules / intercept_requests。
 */

import * as fs from 'fs';
import { createRequire } from 'node:module';
import type { Page, Route } from 'patchright';
import { Readability } from '@mozilla/readability';
import { Defuddle } from 'defuddle/node';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { getBrowserManager } from '../browser.js';
import { fail, failFrom, ToolError } from '../errors.js';
import {
  ExtractLinksSchema, ExtractDataSchema, WaitAndExtractSchema, ExtractArticleSchema,
  SetBlockRulesSchema, InterceptRequestsSchema,
} from '../schemas.js';
import type { ToolResult } from '../types.js';
import { parseInput, settle, sig } from './common.js';
import { patternToRegex } from './pure.js';
import { retryOnNavigation, withTimeout } from './timing.js';

export type FieldSpec = { name: string; selector: string; attribute?: string | undefined; type: 'text' | 'html' | 'attr' };

/**
 * 按字段规则从一组容器里取数据的页面脚本(extract_data 与 crawl_pages 共用一份)。
 *  - 给了 attribute 就取属性(以前 type 不写成 'attr' 时 attribute 被悄悄忽略,返回的是文本);
 *  - 字段 selector 写 ":scope" 或 "&" 表示容器自身(取 tr 上的 data-id 之类)。
 */
export function itemsScript(itemSelector: string, fields: FieldSpec[], limit: number): string {
  return `(function() {
    var fields = ${JSON.stringify(fields)};
    var containers = Array.from(document.querySelectorAll(${JSON.stringify(itemSelector)})).slice(0, ${Math.max(0, Math.floor(limit))});
    return containers.map(function(container) {
      var item = {};
      fields.forEach(function(field) {
        var el = (field.selector === ':scope' || field.selector === '&') ? container : container.querySelector(field.selector);
        if (!el) { item[field.name] = ''; return; }
        if (field.type === 'html') { item[field.name] = el.innerHTML.trim(); }
        else if (field.attribute) { item[field.name] = el.getAttribute(field.attribute) || ''; }
        else { item[field.name] = (el.textContent || '').trim(); }
      });
      return item;
    });
  })()`;
}

/** 在页面上跑一段提取脚本:限时 15 秒,页面正在跳转时等新文档再试 */
export function evalStable<T>(page: Page, script: string, what = '提取'): Promise<T> {
  return retryOnNavigation(() => withTimeout(page.evaluate(script) as Promise<T>, 15_000, what), () => settle(page));
}

/** 提取页面所有链接 */
export async function extractLinks(input: unknown): Promise<ToolResult<{ links: Array<{ text: string; href: string; title?: string }> }>> {
  try {
    const { selector, filter, limit } = parseInput(ExtractLinksSchema, input);
    const page = await getBrowserManager().getPage();
    const links = await evalStable<Array<{ text: string; href: string; title?: string }> | null>(page, `(function() {
      var scope = ${JSON.stringify(selector ?? null)};
      var container = scope ? document.querySelector(scope) : (document.body || document.documentElement);
      if (!container) return null;
      var anchors = Array.from(container.querySelectorAll('a[href]'));
      var result = [];
      var filter = ${JSON.stringify(filter ?? '')};
      for (var i = 0; i < anchors.length && result.length < ${limit}; i++) {
        var a = anchors[i];
        var raw = (a.getAttribute('href') || '').trim();
        var href = a.href;
        // 只有「#」或 javascript: 的不是真链接(a.href 已是绝对地址,以前拿它和 '#' 比永远不相等)
        if (!href || raw === '' || raw === '#' || /^javascript:/i.test(raw)) continue;
        if (filter && href.indexOf(filter) === -1) continue;
        result.push({ text: (a.textContent || '').replace(/\\s+/g, ' ').trim(), href: href, title: a.title || undefined });
      }
      return result;
    })()`);
    // 以前 selector 写错时悄悄退回整页,返回一堆无关链接
    if (!links) return fail('ELEMENT_NOT_FOUND', `范围选择器没匹配到元素:${selector ?? ''}`);
    return { success: true, data: { links } };
  } catch (error) {
    return failFrom(error);
  }
}

/** 提取结构化数据(列表/表格) */
export async function extractData(input: unknown): Promise<ToolResult<{ items: Array<Record<string, string>>; total: number }>> {
  try {
    const { itemSelector, fields, limit } = parseInput(ExtractDataSchema, input);
    const page = await getBrowserManager().getPage();
    const items = await evalStable<Array<Record<string, string>>>(page, itemsScript(itemSelector, fields, limit));
    return { success: true, data: { items, total: items.length } };
  } catch (error) {
    return failFrom(error);
  }
}

/** 等待动态内容加载后提取 */
export async function waitAndExtract(input: unknown): Promise<ToolResult<{ items: string[]; total: number }>> {
  try {
    const { waitSelector, extractSelector, attribute, timeout } = parseInput(WaitAndExtractSchema, input);
    const page = await getBrowserManager().getPage();
    await page.waitForSelector(waitSelector, { timeout: Math.min(timeout, 300_000), state: 'visible', ...sig() });
    const items = await evalStable<string[]>(page, `(function() {
      var attr = ${JSON.stringify(attribute ?? '')};
      return Array.from(document.querySelectorAll(${JSON.stringify(extractSelector)})).map(function(el) {
        return attr ? (el.getAttribute(attr) || '') : (el.textContent || '').trim();
      }).filter(Boolean);
    })()`);
    return { success: true, data: { items, total: items.length } };
  } catch (error) {
    return failFrom(error);
  }
}

// ── 正文提取:在页面里直接跑 defuddle 浏览器版 ──
// 页面在浏览器里已经解析好了。老路径要把整页 HTML 序列化回 Node、再用 jsdom 解析一遍、再在 jsdom 里算样式,
// 实测 Wikipedia 条目 1.2–1.4 秒;页内跑同一个 defuddle 只要 64–107 毫秒,产出逐字一致(2026-09-25)。
// 也顺带避开 jsdom 30.1 起的选择器长度限制(长页面上 defuddle 会生成超长选择器)。
type DefuddleOut = { title?: string; author?: string; description?: string; wordCount: number; content: string };
let defuddleBundle: string | null = null;
async function defuddleInPage(page: Page): Promise<DefuddleOut | null> {
  // 注入一次、同一页面内复用(patchright 的隔离世界跨 evaluate 保留,导航后重新注入):先问一句在不在,省得每次都传 700KB
  const loaded = await page.evaluate('typeof self.Defuddle !== "undefined"');
  if (!loaded) {
    defuddleBundle ??= fs.readFileSync(createRequire(import.meta.url).resolve('defuddle/full'), 'utf8');
    await page.evaluate(defuddleBundle);
  }
  // 在副本上跑:defuddle 会删节点清洗,不能改动用户正在看的页面
  return page.evaluate(`(() => {
    const D = self.Defuddle.default || self.Defuddle;
    const r = new D(document.cloneNode(true), { url: location.href, markdown: true }).parse();
    return { title: r.title, author: r.author, description: r.description, wordCount: r.wordCount, content: r.content };
  })()`) as Promise<DefuddleOut | null>;
}

type Article = { title: string; byline: string | null; excerpt: string | null; length: number; markdown: string; textPreview: string };

function articleOf(r: DefuddleOut): Article {
  const text = r.content.replace(/\s+/g, ' ').trim();
  return {
    title: r.title ?? '', byline: r.author || null, excerpt: r.description || null,
    length: r.wordCount, markdown: r.content, textPreview: text.slice(0, 300),
  };
}

/** 页内失败(脚本被拦、页面奇特)才走的老路径:整页 HTML → jsdom → defuddle,再不行 Readability + Turndown */
async function articleFromHtml(html: string, pageUrl: string): Promise<Article | null> {
  try {
    const result = await Defuddle(new JSDOM(html, { url: pageUrl }), pageUrl, { markdown: true });
    if (result.content && result.wordCount > 0) return articleOf(result);
  } catch { /* defuddle 失败则回退 Readability */ }
  const article = new Readability(new JSDOM(html, { url: pageUrl }).window.document).parse();
  if (!article || !article.content) return null;
  const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(article.content);
  const text = (article.textContent ?? '').replace(/\s+/g, ' ').trim();
  return {
    title: article.title ?? '', byline: article.byline ?? null, excerpt: article.excerpt ?? null,
    length: article.length ?? markdown.length, markdown, textPreview: text.slice(0, 300),
  };
}

/** 提取页面主正文为干净的 Markdown(剥离导航/广告/样板) */
export async function extractArticle(input: unknown): Promise<ToolResult<Article>> {
  try {
    const { url } = parseInput(ExtractArticleSchema, input);
    const page = await getBrowserManager().getPage();
    if (url) {
      await page.goto(url, { ...sig(), waitUntil: 'commit', timeout: 30000 })
        .catch((e: unknown) => { throw new ToolError('NAVIGATION_FAILED', e instanceof Error ? e.message : String(e)); });
      // commit 阶段 DOM 还没解析完,直接 content() 会拿到半成品页面
      await settle(page, 15000);
    }
    const inPage = await retryOnNavigation(() => withTimeout(defuddleInPage(page), 20_000, '页内正文提取'), () => settle(page))
      .catch(() => null);
    if (inPage?.content && inPage.wordCount > 0) return { success: true, data: articleOf(inPage) };
    const html = await withTimeout(page.content(), 15_000, '读取页面 HTML');
    const article = await articleFromHtml(html, page.url());
    if (!article) return fail('ELEMENT_NOT_FOUND', '该页面不是文章,或无法提取主正文(defuddle 与 Readability 均返回空)');
    return { success: true, data: article };
  } catch (error) {
    return failFrom(error);
  }
}

/** 广告域名黑名单 */
const AD_DOMAINS = ['doubleclick.net', 'googlesyndication.com', 'adservice.google', 'amazon-adsystem.com', 'facebook.com/tr', 'analytics.google', 'googletagmanager.com', 'hotjar.com', 'clarity.ms'];

/** route 动作的 Promise 不能悬空:页面关了它们会失败,成了无主的 rejection */
const quiet = (p: Promise<void>): void => { p.catch(() => { /* 页面 / 请求已结束 */ }); };

/**
 * 设置请求拦截规则(屏蔽图片/广告,加速爬取)。
 *
 * 作用范围 = **本会话自己的所有标签页**(含之后新开的),由 BrowserManager.setBlockRoute 落地。
 * 重复调用时 setBlockRoute 内部会先 unroute 旧 handler,避免规则叠加;全部关掉时直接摘掉 handler。
 */
export async function setBlockRules(input: unknown): Promise<ToolResult<{ active: boolean; rules: object }>> {
  try {
    const { blockImages, blockMedia, blockFonts, blockAds, customPatterns } = parseInput(SetBlockRulesSchema, input);
    const rules = { blockImages, blockMedia, blockFonts, blockAds, customPatterns };
    const any = blockImages || blockMedia || blockFonts || blockAds || customPatterns.length > 0;
    // 先确保本会话至少有一张标签页,否则规则挂不上任何页面
    await getBrowserManager().getPage();
    if (!any) {
      // 全关:摘掉 handler(以前挂一个什么都不拦的 handler,每个请求白走一遍路由)
      await getBrowserManager().setBlockRoute(null);
      return { success: true, data: { active: false, rules } };
    }
    const handler = (route: Route): void => {
      const req = route.request();
      const url = req.url();
      const t = req.resourceType();
      const block = (blockImages && (t === 'image' || t === 'imageset'))
        || (blockMedia && (t === 'media' || t === 'websocket'))
        || (blockFonts && t === 'font')
        || (blockAds && AD_DOMAINS.some((d) => url.includes(d)))
        || customPatterns.some((p) => url.includes(p));
      // fallback 而非 continue:让请求继续流到 context 级的 HTML 注入 handler。
      // 用 continue() 会直接放行到网络,注入 handler 永远收不到文档请求(指纹伪装/console 劫持全失效)。
      quiet(block ? route.abort() : route.fallback());
    };
    await getBrowserManager().setBlockRoute(handler);
    return { success: true, data: { active: true, rules } };
  } catch (error) {
    return failFrom(error);
  }
}

// 拦截规则记录挂在**页面**上(WeakMap<Page, ...>):页面就是会话 / 标签隔离边界;unroute 一定打在当初 route 的那张页上;
// 条目随页面关闭被 GC 回收。
const interceptHandlers = new WeakMap<Page, Map<string, { regex: RegExp; handler: (route: Route) => void }>>();

export async function interceptRequests(input: unknown): Promise<ToolResult<{ intercepting: boolean; urlPattern: string; action: string }>> {
  try {
    const { urlPattern, action } = parseInput(InterceptRequestsSchema, input);
    const page = await getBrowserManager().getPage();
    let perPage = interceptHandlers.get(page);
    const prev = perPage?.get(urlPattern);
    if (prev) {
      await page.unroute(prev.regex, prev.handler).catch(() => { /* 页面已关 */ });
      perPage?.delete(urlPattern);
    }
    if (action === 'off') return { success: true, data: { intercepting: false, urlPattern, action } };
    const regex = patternToRegex(urlPattern);
    // log / modify:放行。用 fallback 而不是 continue —— continue 会绕过 HTML 注入,页面 console 收集随之失效。
    // (以前 log 是 console.log 到服务进程的标准输出,AI 永远看不到;请求记录请用 get_network。)
    const handler = action === 'block'
      ? (route: Route): void => quiet(route.abort())
      : (route: Route): void => quiet(route.fallback());
    await page.route(regex, handler);
    if (!perPage) { perPage = new Map(); interceptHandlers.set(page, perPage); }
    perPage.set(urlPattern, { regex, handler });
    return { success: true, data: { intercepting: true, urlPattern, action } };
  } catch (error) {
    return failFrom(error);
  }
}
