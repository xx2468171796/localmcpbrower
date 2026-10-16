/**
 * BrowserManager 里不碰浏览器的那部分判断,抽出来单测:
 * 空闲回收的时限、同时开着的工作区上限、哨兵页要不要开、「被回收过」标记。
 */

/**
 * 空闲回收时限(分钟)的环境变量解析。
 * 没设 / 空串 → 默认;0 或负数 → 不回收(Infinity);看不懂的值 → 默认(而不是悄悄变成「永不回收」)。
 */
export function idleLimitMinutes(raw: string | undefined, def: number): number {
  const s = (raw ?? '').trim();
  if (!s) return def;
  const n = Number(s);
  if (!Number.isFinite(n)) return def;
  return n > 0 ? n : Infinity;
}

/** MAX_OPEN_SPACES:没设 / 看不懂 → 4;0 → 不限;其它取整且至少 1 */
export function maxOpenSpaces(raw: string | undefined): number {
  const s = (raw ?? '').trim();
  if (!s) return 4;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return 4;
  if (n === 0) return Infinity;
  return Math.max(1, Math.floor(n));
}

/** 只要求 isClosed(),方便单测用假对象 */
export interface ClosablePage { isClosed(): boolean }

/**
 * 要关掉 closing 这些页时,是否得先开一张哨兵页(无主的 about:blank)。
 * 有头 Chromium 关掉最后一个标签页 = 整个浏览器退出(连带这个工作区所有会话);
 * 所以「关完之后 context 里一张活页都不剩」时先补一张。还有别的页(包括别的会话的、无主的)就不用。
 */
export function needsSentinel(allPages: readonly ClosablePage[], closing: readonly ClosablePage[]): boolean {
  if (closing.length === 0) return false;
  const gone = new Set(closing);
  return !allPages.some((p) => !p.isClosed() && !gone.has(p));
}

/**
 * 「这个会话的标签页被系统清掉过」标记(空闲回收、浏览器崩溃、管理员重启)。
 * 下一次工具结果带上 recycled: true,让 AI / 编排知道页面已经不是原来那张,别把空白页当成数据。
 * 取一次就清(consume);会话结束时 forget。有上限,防止会话 id 越攒越多。
 */
export class RecycledSessions {
  private ids = new Set<string>();
  constructor(private readonly max = 1000) {}

  mark(sessionId: string): void {
    this.ids.delete(sessionId);
    this.ids.add(sessionId);
    while (this.ids.size > this.max) {
      const oldest = this.ids.values().next().value;
      if (oldest === undefined) break;
      this.ids.delete(oldest);
    }
  }

  consume(sessionId: string): boolean {
    return this.ids.delete(sessionId);
  }

  forget(sessionId: string): void {
    this.ids.delete(sessionId);
  }

  get size(): number {
    return this.ids.size;
  }
}
