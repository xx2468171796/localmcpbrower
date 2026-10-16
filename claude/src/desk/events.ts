/**
 * 工具调用事件时间线(监测层):每次工具调用记「开始」和「结束」两条,人和管理服务据此看 AI 在干什么、有没有卡住。
 *
 * - 只在内存里存最近 N 条(有界环形),不落盘;管理服务要长期留存就自己订阅后存。
 * - id 单调递增、不复用:订阅方断线重连带 Last-Event-ID / since 就能补齐。
 * - 推送给订阅者是旁路:订阅者慢或抛错都不影响工具调用。
 * - 参数先摘要、打码再进来(summarizeArgs):输入框内容、脚本源码、cookie 值一律不进时间线。
 */

export type ToolEventKind = 'call_start' | 'call_end' | 'gate' | 'browser' | 'display';

export interface ToolEvent {
  id: number;
  ts: number;
  kind: ToolEventKind;
  /** 同一次调用的 start / end 共用一个 callId */
  callId?: number;
  session?: string;
  space?: string;
  tool?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  ms?: number;
  code?: string;
  error?: string;
  url?: string;
  /** gate / browser / display 事件的说明,如 paused、resumed、restarted、1920x1080 → 2560x1440 */
  detail?: string;
}

export type ToolEventInput = Omit<ToolEvent, 'id' | 'ts'>;
type Listener = (e: ToolEvent) => void;

export class EventRing {
  private readonly buf: ToolEvent[] = [];
  private nextId = 1;
  private nextCallId = 1;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly capacity = 2000, private readonly now: () => number = Date.now) {}

  newCallId(): number {
    return this.nextCallId++;
  }

  push(input: ToolEventInput): ToolEvent {
    const e: ToolEvent = { id: this.nextId++, ts: this.now(), ...input };
    this.buf.push(e);
    if (this.buf.length > this.capacity) this.buf.splice(0, this.buf.length - this.capacity);
    for (const l of this.listeners) {
      try { l(e); } catch { /* 订阅者自己的问题,不连累工具调用 */ }
    }
    return e;
  }

  /**
   * id 大于 since 的事件(最多 limit 条,取最新的那段)。
   * since 比当前最大 id 还大 = 订阅方记的是上一个进程的 id(本服务重启过,id 从 1 重新数):从头补发,
   * 否则它会一直等一个永远到不了的 id,重启后的事件全部漏掉。
   */
  since(since = 0, limit = 500): ToolEvent[] {
    const from = since > this.lastId ? 0 : since;
    const out = this.buf.filter((e) => e.id > from);
    return out.length > limit ? out.slice(out.length - limit) : out;
  }

  /** 已开始、还没结束的调用(卡住检测用) */
  inFlight(): ToolEvent[] {
    const ended = new Set<number>();
    for (const e of this.buf) if (e.kind === 'call_end' && e.callId !== undefined) ended.add(e.callId);
    return this.buf.filter((e) => e.kind === 'call_start' && e.callId !== undefined && !ended.has(e.callId));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  }

  get lastId(): number {
    return this.nextId - 1;
  }
}

/** 这些参数名的值一律不进时间线(可能是密码、正文、脚本、cookie) */
const SECRET_KEYS = /^(text|value|values|password|secret|token|script|code|expression|cookies?|headers?|body|content|otp|proxy)$/i;
const MAX_STR = 200;

/**
 * 参数摘要:保留网址、选择器、ref、数量这类「看得懂在干什么」的字段,打掉可能含敏感内容的值。
 * fill_form 的 fields 只留字段名 / 选择器,不留值。
 */
export function summarizeArgs(args: unknown): Record<string, unknown> | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? redacted(v) : summarizeValue(v, 0);
  }
  return out;
}

function redacted(v: unknown): string {
  if (typeof v === 'string') return `«${v.length} 字符»`;
  if (Array.isArray(v)) return `«${v.length} 项»`;
  return '«已隐藏»';
}

function summarizeValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.length > MAX_STR ? `${v.slice(0, MAX_STR)}…(${v.length})` : v;
  if (typeof v !== 'object' || v === null) return v;
  if (depth >= 2) return Array.isArray(v) ? `«${v.length} 项»` : '«…»';
  if (Array.isArray(v)) {
    const head = v.slice(0, 10).map((x) => summarizeValue(x, depth + 1));
    return v.length > 10 ? [...head, `…共 ${v.length} 项`] : head;
  }
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    o[k] = SECRET_KEYS.test(k) ? redacted(x) : summarizeValue(x, depth + 1);
  }
  return o;
}
