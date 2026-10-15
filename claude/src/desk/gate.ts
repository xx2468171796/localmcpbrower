/**
 * 工位闸门(控制层):人接管时让 AI 停手,以及网站白名单。
 *
 * 状态机只有两态:running ⇄ paused。
 *   - pause:在途调用不打断(打断一半的点击 / 填表比让它做完更糟),之后进来的调用按模式处理:
 *     wait(默认)= 原地等人 resume,最多 maxWaitMs,超时返回 DESK_PAUSED;reject = 立即返回 DESK_PAUSED。
 *   - resume:放行全部等待中的调用。
 *   - 只读工具(看页面、截图、列标签页)和 wait_for_human 永远放行:人接管时 AI 仍能看,只是不能动。
 * 白名单为空 = 不限;非空时只放行列表里的站点(含子域名)。
 */

import { ToolError } from '../errors.js';

export type GateState = 'running' | 'paused';
export type PauseMode = 'wait' | 'reject';

/** 暂停时照常放行的工具:只读,不改页面 */
export const READONLY_TOOLS: ReadonlySet<string> = new Set([
  'snapshot', 'take_screenshot', 'list_tabs', 'space_list', 'get_page_content', 'get_element_text',
  'get_element_attribute', 'get_console_logs', 'get_network', 'get_cookies', 'extract_links', 'extract_data',
  'extract_article', 'generate_page_report', 'wait_for_human',
]);

interface Waiter { resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout; onAbort?: () => void; signal?: AbortSignal }

export interface GateStatus {
  state: GateState;
  mode: PauseMode;
  since: number;
  by?: string;
  reason?: string;
  waiting: number;
  allowlist: string[];
}

export class DeskGate {
  private state: GateState = 'running';
  private since: number;
  private by?: string;
  private reason?: string;
  private waiters = new Set<Waiter>();
  private allow: string[] = [];

  constructor(
    private readonly maxWaitMs = 600_000,
    private mode: PauseMode = 'wait',
    private readonly now: () => number = Date.now,
  ) {
    this.since = now();
  }

  status(): GateStatus {
    return { state: this.state, mode: this.mode, since: this.since, by: this.by, reason: this.reason, waiting: this.waiters.size, allowlist: [...this.allow] };
  }

  pause(opts: { by?: string; reason?: string; mode?: PauseMode } = {}): GateStatus {
    if (opts.mode) this.mode = opts.mode;
    if (this.state !== 'paused') {
      this.state = 'paused';
      this.since = this.now();
    }
    this.by = opts.by;
    this.reason = opts.reason;
    if (this.mode === 'reject') this.rejectAll();
    return this.status();
  }

  resume(): GateStatus {
    if (this.state === 'paused') {
      this.state = 'running';
      this.since = this.now();
      this.by = undefined;
      this.reason = undefined;
      for (const w of this.waiters) this.settle(w).resolve();
    }
    return this.status();
  }

  /** 工具调用前过闸:放行就正常返回,不放行抛 ToolError(DESK_PAUSED) */
  async admit(tool: string, signal?: AbortSignal): Promise<void> {
    if (this.state === 'running' || READONLY_TOOLS.has(tool)) return;
    if (this.mode === 'reject') throw this.pausedError();
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = {
        resolve, reject, signal,
        timer: setTimeout(() => this.settle(w).reject(this.pausedError()), this.maxWaitMs),
      };
      if (signal) {
        if (signal.aborted) { clearTimeout(w.timer); reject(new ToolError('CANCELLED', '调用已取消')); return; }
        w.onAbort = () => this.settle(w).reject(new ToolError('CANCELLED', '调用已取消'));
        signal.addEventListener('abort', w.onAbort, { once: true });
      }
      this.waiters.add(w);
    });
  }

  // ── 白名单 ──

  setAllowlist(domains: string[]): string[] {
    this.allow = [...new Set(domains.map(normalizeDomain).filter((d): d is string => d !== null))];
    return [...this.allow];
  }

  /** 网址是否放行;about:/data:/blob:/chrome: 这类内部页不算外站,放行 */
  allows(url: string): boolean {
    if (this.allow.length === 0) return true;
    let host: string;
    try {
      const u = new URL(url);
      if (!/^(https?|wss?):$/.test(u.protocol)) return true;
      host = u.hostname.toLowerCase();
    } catch {
      return false;
    }
    return this.allow.some((d) => host === d || host.endsWith(`.${d}`));
  }

  /** 不放行就抛 DOMAIN_BLOCKED(给 navigate / new_tab / batch_fetch 等先查一遍) */
  checkUrl(url: string): void {
    if (!this.allows(url)) {
      throw new ToolError('DOMAIN_BLOCKED', `「${url}」不在本工位允许访问的网站里(白名单:${this.allow.join('、')})`);
    }
  }

  private pausedError(): ToolError {
    const who = this.by ? `(${this.by})` : '';
    const why = this.reason ? `:${this.reason}` : '';
    return new ToolError('DESK_PAUSED', `工位正在被人接管${who}${why}。等对方交还后再继续;只读操作(snapshot / 截图)可以照常用`);
  }

  private rejectAll(): void {
    for (const w of this.waiters) this.settle(w).reject(this.pausedError());
  }

  /** 从等待集合里摘掉并清理定时器 / 取消监听,返回它的 resolve / reject */
  private settle(w: Waiter): Waiter {
    this.waiters.delete(w);
    clearTimeout(w.timer);
    if (w.onAbort && w.signal) w.signal.removeEventListener('abort', w.onAbort);
    return w;
  }
}

/** 'https://A.example.com/x' / '*.example.com' / 'example.com' → 'example.com' 形式;无效返回 null */
export function normalizeDomain(raw: string): string | null {
  const s = raw.trim().toLowerCase().replace(/^\*\./, '');
  if (!s) return null;
  try {
    const host = s.includes('://') ? new URL(s).hostname : new URL(`http://${s}`).hostname;
    return host || null;
  } catch {
    return null;
  }
}
