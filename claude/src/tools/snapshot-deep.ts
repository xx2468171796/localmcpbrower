/**
 * snapshot deep:用 CDP 找出只靠 addEventListener 绑了 click 的元素(没有语义标签、没有 cursor:pointer)。
 *
 * 旧实现恒定失效:候选挂在隔离世界的 window 上,CDP Runtime.evaluate 看的是主世界,取不到 objectId。
 * 现在只走 DOM 这条跨世界通道:
 *   1. 隔离世界里给候选元素打临时属性 data-mcp-cand=<序号>(DOM 两个世界共享);
 *   2. CDP DOM.querySelectorAll 按属性取 nodeId → DOM.resolveNode 拿 objectId → DOMDebugger.getEventListeners;
 *   3. 命中的序号回到隔离世界打 data-mcp-ref=d<n>、取标签文字,清掉临时属性。
 * 只看主框架;整体 4 秒上限,任何一步失败都降级为空结果,不影响普通快照。
 */

import type { CDPSession, Page } from 'patchright';
import { withTimeout } from './timing.js';

const CAND_QUERY = 'div,span,li,td,th,section,article,header,footer,nav,p,img,svg';
const MAX_CANDIDATES = 400;
const BUDGET_MS = 4000;

const MARK_SRC = `(function() {
  var old = document.querySelectorAll('[data-mcp-cand]');
  for (var k = 0; k < old.length; k++) old[k].removeAttribute('data-mcp-cand');
  var els = document.querySelectorAll(${JSON.stringify(CAND_QUERY)});
  var n = 0;
  for (var i = 0; i < els.length && n < ${MAX_CANDIDATES}; i++) {
    var el = els[i];
    if (el.hasAttribute('data-mcp-ref')) continue;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) continue;
    var rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8 || rect.width > 1600 || rect.height > 900) continue;
    el.setAttribute('data-mcp-cand', String(n++));
  }
  return n;
})()`;

const finishSrc = (hits: number[]): string => `(function() {
  var hits = ${JSON.stringify(hits)};
  var out = [];
  var n = 0;
  for (var i = 0; i < hits.length; i++) {
    var el = document.querySelector('[data-mcp-cand="' + hits[i] + '"]');
    if (!el || el.hasAttribute('data-mcp-ref')) continue;
    var ref = 'd' + (++n);
    el.setAttribute('data-mcp-ref', ref);
    var label = el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').replace(/\\s+/g, ' ').trim();
    out.push('clickable "' + label.slice(0, 80).replace(/"/g, "'") + '" [ref=' + ref + ']');
  }
  var old = document.querySelectorAll('[data-mcp-cand]');
  for (var k = 0; k < old.length; k++) old[k].removeAttribute('data-mcp-cand');
  return out;
})()`;

type NodeIds = { nodeIds: number[] };

async function clickableIndices(session: CDPSession, deadline: number): Promise<number[]> {
  const doc = await session.send('DOM.getDocument', { depth: 0 });
  const { nodeIds } = await session.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: '[data-mcp-cand]' }) as NodeIds;
  const hits: number[] = [];
  for (const nodeId of nodeIds) {
    if (Date.now() > deadline) break;
    try {
      const { object } = await session.send('DOM.resolveNode', { nodeId });
      if (!object.objectId) continue;
      const { listeners } = await session.send('DOMDebugger.getEventListeners', { objectId: object.objectId });
      await session.send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => { /* noop */ });
      if (!listeners.some((l) => l.type === 'click' || l.type === 'mousedown' || l.type === 'pointerdown')) continue;
      const { attributes } = await session.send('DOM.getAttributes', { nodeId });
      const at = attributes.indexOf('data-mcp-cand');
      const idx = at >= 0 ? Number(attributes[at + 1]) : NaN;
      if (Number.isFinite(idx)) hits.push(idx);
    } catch { /* 单个节点失败跳过 */ }
  }
  return hits;
}

/** 深扫主框架,返回快照附加行(已打好 d<n> ref);失败返回空数组 */
export async function deepScan(page: Page): Promise<string[]> {
  const deadline = Date.now() + BUDGET_MS;
  let session: CDPSession | null = null;
  try {
    const count = await withTimeout(page.evaluate(MARK_SRC) as Promise<number>, 2000, '深扫候选');
    if (!count) return [];
    session = await page.context().newCDPSession(page);
    const hits = await withTimeout(clickableIndices(session, deadline), BUDGET_MS + 1000, '深扫');
    return await withTimeout(page.evaluate(finishSrc(hits)) as Promise<string[]>, 2000, '深扫标记');
  } catch {
    await page.evaluate(finishSrc([])).catch(() => { /* 清理临时属性失败无妨 */ });
    return [];
  } finally {
    await session?.detach().catch(() => { /* noop */ });
  }
}
