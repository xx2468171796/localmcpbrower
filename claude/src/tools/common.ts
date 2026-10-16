/**
 * 工具共用的小件:参数校验、selector / ref 解析到 frame、等页面稳定、动作引发的新标签页 / 下载 / 跳转。
 */

import * as path from 'path';
import type { Download, Frame, Page, Request } from 'patchright';
import { ToolError } from '../errors.js';
import { DATA_ROOT } from '../paths.js';
import { getBrowserManager } from '../browser.js';
import { currentSignal } from '../context.js';
import { retryOnNavigation, sleep, withTimeout } from './timing.js';

/** 下载下来的文件放这里(数据目录 downloads/) */
export const DOWNLOAD_DIR = path.join(DATA_ROOT, 'downloads');
/** file_upload 默认允许的上传源目录(数据目录 uploads/) */
export const UPLOAD_DIR = path.join(DATA_ROOT, 'uploads');

export { parseInput } from './pure.js';

/** 把 ref 编号解析为 CSS 选择器;selector / ref 二选一 */
export function resolveTarget(selector?: string, ref?: string): { selector: string; fromRef: boolean } {
  if (ref) return { selector: `[data-mcp-ref="${ref.replace(/["\\]/g, '')}"]`, fromRef: true };
  if (selector) return { selector, fromRef: false };
  throw new ToolError('INVALID_ARGS', 'selector 与 ref 必须提供其一');
}

/**
 * 定位 selector 所在的 frame(主框架或任意 iframe),首个命中的返回;都没有返回 null。
 * 每个 frame 的探测限 2 秒:正在加载 / 卡住的 iframe 不能把整个工具拖住。
 */
export async function findFrame(page: Page, selector: string): Promise<Frame | null> {
  for (const frame of page.frames()) {
    if (frame.isDetached()) continue;
    try {
      const n = await withTimeout(frame.locator(selector).count(), 2000, 'frame 探测');
      if (n > 0) return frame;
    } catch { /* 跨域 / 正在导航 / 已分离的 frame:跳过 */ }
  }
  return null;
}

/**
 * 解析目标 frame:优先 selector 所在 frame;ref 全页找不到 → ELEMENT_NOT_FOUND(让 AI 重新 snapshot);
 * 裸 CSS 选择器找不到 → 回退主框架,交给后续的等待 / 报错(元素可能马上就出现)。
 */
export async function targetFrame(page: Page, selector: string, fromRef: boolean, ref?: string): Promise<Frame> {
  const frame = await retryOnNavigation(() => findFrame(page, selector), () => settle(page));
  if (frame) return frame;
  if (fromRef) {
    throw new ToolError('ELEMENT_NOT_FOUND', `ref ${ref ?? ''} 未找到(页面可能已重新渲染),请重新调用 snapshot 获取最新 ref`);
  }
  return page.mainFrame();
}

/** 等当前文档至少解析完(导航中途调用时用);有上限、可取消 */
export async function settle(page: Page, ms = 10_000): Promise<void> {
  // 已经解析完就不等:后退 / 前进从往返缓存(bfcache)恢复的页面不会再发生命周期事件,
  // waitForLoadState 会一直等到超时(完整版 Chromium 默认开 bfcache;2026-10-17 实测后退一次白等 5 秒)
  const state = await withTimeout(page.evaluate(() => document.readyState), 1000, '读页面状态').catch(() => 'loading');
  if (state !== 'loading') return;
  await page.waitForLoadState('domcontentloaded', { timeout: ms, ...sig() }).catch(() => { /* 慢页面:到点就继续 */ });
}

/** 展开进 Playwright 选项的 signal */
export function sig(): { signal?: AbortSignal } {
  const s = currentSignal();
  return s ? { signal: s } : {};
}

/** 元素是不是密码框(结果里不回显它的值,只给长度) */
export async function isPasswordField(frame: Frame, selector: string): Promise<boolean> {
  return frame.locator(selector).first()
    .evaluate((el) => el instanceof HTMLInputElement && el.type.toLowerCase() === 'password', undefined, { timeout: 2000 })
    .catch(() => false);
}

export interface ActionEffects {
  /** 动作打开了新标签页(window.open / target=_blank) */
  newTab?: { index: number; url: string };
  /** 动作触发了下载:文件存到下载目录 */
  download?: { path: string | null; suggestedFilename: string; error?: string };
  /** 动作引发了整页跳转,已等到新页面 DOM 就绪 */
  navigated?: boolean;
}

/**
 * 包住一个会改变页面的动作(点击 / 回车):
 *  - 动作发起了主框架跳转 → 等到新文档 DOM 就绪(以前 click 立即返回,紧接着的读取会撞上
 *    「Execution context was destroyed」);
 *  - 打开了新标签页 → 结果里告诉调用方序号(browser.ts 已把它纳入本会话),不自动切过去;
 *  - 触发了下载 → 存进下载目录,结果里给路径(以前下载文件随临时目录一起消失,AI 拿不到)。
 */
/** 动作期间主框架跳转的状态:事件从动作**之前**就开始记,本地快站点的整个跳转可能在几十毫秒内走完 */
class NavTracker {
  req?: Request;
  committed = false;
  ended = false;
  popup?: Page;
  download?: Download;
  private wake: (() => void) | null = null;
  private readonly handlers: Array<[string, (x: never) => void]>;

  constructor(private readonly page: Page) {
    const main = page.mainFrame();
    this.handlers = [
      ['request', (r: Request) => { if (!this.req && r.isNavigationRequest() && r.frame() === main) this.req = r; }],
      ['framenavigated', (f: Frame) => { if (this.req && f === main) { this.committed = true; this.poke(); } }],
      ['requestfailed', (r: Request) => { if (r === this.req) { this.ended = true; this.poke(); } }],
      // 204 / 被拦下等「请求完成却不提交」:完成后再给半秒,还没提交就算没跳
      ['requestfinished', (r: Request) => { if (r === this.req) setTimeout(() => { this.ended = true; this.poke(); }, 500); }],
      ['popup', (p: Page) => { this.popup ??= p; }],
      ['download', (d: Download) => { this.download ??= d; this.poke(); }],
    ];
    for (const [ev, fn] of this.handlers) page.on(ev as 'request', fn as (r: Request) => void);
  }

  private poke(): void { this.wake?.(); }

  /** 等跳转有结果:提交了 → true;失败 / 变下载 / 超时 → false */
  async waitCommit(ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (!this.committed && !this.ended && !this.download && Date.now() < end) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        setTimeout(resolve, Math.min(250, Math.max(0, end - Date.now())));
      });
      this.wake = null;
      if (currentSignal()?.aborted) break;
    }
    return this.committed;
  }

  dispose(): void {
    for (const [ev, fn] of this.handlers) this.page.off(ev as 'request', fn as (r: Request) => void);
  }
}

/**
 * 包住一个会改变页面的动作(点击 / 回车):
 *  - 动作发起了主框架跳转 → 等到新文档 DOM 就绪(以前 click 立即返回,紧接着的读取会撞上
 *    「Execution context was destroyed」);
 *  - 打开了新标签页 → 结果里告诉调用方序号(browser.ts 已把它纳入本会话),不自动切过去;
 *  - 触发了下载 → 存进下载目录,结果里给路径(以前下载文件随临时目录一起消失,AI 拿不到)。
 */
export async function withActionEffects(page: Page, action: () => Promise<void>): Promise<ActionEffects> {
  const t = new NavTracker(page);
  const out: ActionEffects = {};
  try {
    await action();
    // 跳转 / 弹窗 / 下载都是异步发起的:给一小段窗口让事件到达
    await sleep(120, currentSignal());
    if (t.req && !t.download) {
      out.navigated = await t.waitCommit(10_000);
      if (out.navigated) await settle(page);
    }
  } finally {
    t.dispose();
  }
  if (t.popup) out.newTab = await describePopup(t.popup);
  if (t.download) out.download = await saveDownload(t.download);
  return out;
}


async function describePopup(popup: Page): Promise<{ index: number; url: string }> {
  await popup.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { /* 慢就先报 about:blank */ });
  const pages = await getBrowserManager().getSessionPages().catch(() => [] as Page[]);
  return { index: pages.indexOf(popup), url: popup.url() };
}

async function saveDownload(d: Download): Promise<ActionEffects['download']> {
  const name = d.suggestedFilename().replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'download';
  const target = path.join(DOWNLOAD_DIR, `${Date.now()}-${name}`);
  try {
    // 大文件不等它下完拖住工具:30 秒没存好就报「下载中」,saveAs 在后台继续
    await withTimeout(d.saveAs(target), 30_000, '保存下载文件');
    return { path: target, suggestedFilename: d.suggestedFilename() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { path: null, suggestedFilename: d.suggestedFilename(), error: msg };
  }
}
