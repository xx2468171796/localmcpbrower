/**
 * snapshot:无障碍树式大纲,可交互元素打 data-mcp-ref。主框架 + 各 iframe 逐个快照,ref 编号跨 frame 全局连续。
 */

import type { Frame, Page } from 'patchright';
import { getBrowserManager } from '../browser.js';
import { failFrom } from '../errors.js';
import { throwIfCancelled } from '../context.js';
import { SNAPSHOT_WALKER_FN } from '../injected.js';
import { SnapshotSchema } from '../schemas.js';
import type { ToolResult } from '../types.js';
import { parseInput, settle } from './common.js';
import { deepScan } from './snapshot-deep.js';
import { retryOnNavigation, withTimeout } from './timing.js';

type WalkOut = { snapshot: string; refCount: number; truncated: boolean };

/** 单个 frame 的快照:限时 5 秒(加载中 / 卡住的 iframe 不能把整个快照拖住) */
function walkFrame(frame: Frame, interactiveOnly: boolean, cap: number, startRef: number): Promise<WalkOut> {
  return withTimeout(
    frame.evaluate(`(${SNAPSHOT_WALKER_FN})(${interactiveOnly}, ${cap}, ${startRef})`) as Promise<WalkOut>,
    5000, 'frame 快照');
}

async function snapshotFrames(page: Page, interactiveOnly: boolean, cap: number): Promise<WalkOut> {
  const mainFrame = page.mainFrame();
  // 主框架:页面正跳转时等新文档再试(以前直接报 Execution context was destroyed)
  const main = await retryOnNavigation(() => walkFrame(mainFrame, interactiveOnly, cap, 0), () => settle(page));
  let running = main.refCount;
  let truncated = main.truncated;
  let used = main.snapshot.length;
  const sections: string[] = [];
  for (const frame of page.frames()) {
    if (frame === mainFrame || frame.isDetached()) continue;
    if (truncated) break;
    throwIfCancelled();
    const remaining = cap - used;
    if (remaining < 200) { truncated = true; break; }
    try {
      const fr = await walkFrame(frame, interactiveOnly, remaining, running);
      if (fr.snapshot.trim()) {
        const furl = (frame.url() || '(about:blank)').slice(0, 100).replace(/"/g, "'");
        const section = `iframe "${furl}"\n${fr.snapshot.split('\n').map((l) => '  ' + l).join('\n')}`;
        sections.push(section);
        used += section.length + 1;
        running = fr.refCount;
        truncated = truncated || fr.truncated;
      }
    } catch { /* 跨域 / 已分离 / 超时的 frame 跳过 */ }
  }
  return { snapshot: sections.length ? `${main.snapshot}\n${sections.join('\n')}` : main.snapshot, refCount: running, truncated };
}

/** ARIA 快照:返回页面无障碍树式大纲,并为可交互元素打上 data-mcp-ref */
export async function snapshot(input: unknown): Promise<ToolResult<{ snapshot: string; refCount: number; truncated: boolean }>> {
  try {
    const { interactiveOnly, maxChars, deep } = parseInput(SnapshotSchema, input);
    const page = await getBrowserManager().getPage();
    const r = await snapshotFrames(page, interactiveOnly, maxChars ?? 12000);
    let snap = r.truncated ? r.snapshot + '\n\n[... 已截断，可调大 maxChars 或设置 interactiveOnly:true]' : r.snapshot;
    let deepCount = 0;
    if (deep) {
      throwIfCancelled();
      const lines = await deepScan(page);
      deepCount = lines.length;
      snap += lines.length
        ? '\n\n[深度扫描发现 ' + lines.length + ' 个事件监听可点击元素]\n' + lines.join('\n')
        : '\n\n[深度扫描没发现额外的事件监听可点击元素(只扫主框架)]';
    }
    return { success: true, data: { snapshot: snap, refCount: r.refCount + deepCount, truncated: r.truncated } };
  } catch (error) {
    return failFrom(error);
  }
}
