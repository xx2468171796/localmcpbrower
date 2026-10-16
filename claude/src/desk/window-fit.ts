/**
 * 切完分辨率后让有头 Chromium 的窗口撑满新屏幕。
 *
 * 托管工位的浏览器以 --start-maximized 启动(viewport: null,页面跟着窗口走),openbox 会把**最大化**的窗口
 * 跟着屏幕大小重排(2026-10-16 实测 1280x720 ↔ 3840x2160 来回切都跟上);这里补的是人或页面把窗口还原 / 最小化 /
 * 全屏过的情况:经 CDP Browser.setWindowBounds 设回最大化。一个窗口里可能有多个标签页,按 windowId 去重。
 */
import type { BrowserContext, Page } from 'patchright';

const CDP_TIMEOUT_MS = 3_000;

function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP 超时')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e: unknown) => { clearTimeout(t); reject(e instanceof Error ? e : new Error(String(e))); });
  });
}

/** 一个页面所在窗口设成最大化;返回 windowId(已处理过的窗口跳过,返回 null) */
async function maximizeWindowOf(page: Page, seen: Set<number>): Promise<number | null> {
  const s = await within(page.context().newCDPSession(page), CDP_TIMEOUT_MS);
  try {
    const { windowId, bounds } = await within(s.send('Browser.getWindowForTarget'), CDP_TIMEOUT_MS);
    if (seen.has(windowId)) return null;
    seen.add(windowId);
    if (bounds.windowState === 'maximized') return windowId;
    // 最小化 / 全屏不能直接切到最大化,先还原
    if (bounds.windowState === 'minimized' || bounds.windowState === 'fullscreen') {
      await within(s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }), CDP_TIMEOUT_MS);
    }
    await within(s.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } }), CDP_TIMEOUT_MS);
    return windowId;
  } finally {
    await s.detach().catch(() => { /* 页面可能刚关 */ });
  }
}

/** 把这些浏览器的所有窗口设成最大化;返回处理到的窗口数。单个页面失败不影响别的 */
export async function maximizeAllWindows(contexts: readonly BrowserContext[]): Promise<number> {
  let windows = 0;
  for (const ctx of contexts) {
    const seen = new Set<number>();
    for (const page of ctx.pages()) {
      if (page.isClosed()) continue;
      try {
        if ((await maximizeWindowOf(page, seen)) !== null) windows++;
      } catch (e) {
        console.error(`[Desk] 调整窗口失败(${page.url()}):${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return windows;
}
