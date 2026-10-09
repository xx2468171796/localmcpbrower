/**
 * 工具调用遥测(成绩单的数据来源,见 baolei docs/research/2026-10-self-evolving-projects.md 6.1 第 2 条)。
 *
 * 每次工具调用记一条 {tool, ok, ms, bytes, truncated},攒批异步发到堡垒机。铁律:
 *   - 绝不拖慢、绝不弄挂工具调用:record() 只往内存数组里推,发送在定时器里做,所有异常吞掉;
 *   - 只发工具名和数字,不发参数、网址、页面内容(这些可能带登录态和业务数据);
 *   - 缓冲有上限,堡垒机连不上时丢最老的,不会越攒越多。
 *
 * 开关:
 *   - BROWSER_TELEMETRY=0 / off / false → 关;
 *   - 默认:本机配了堡垒机 baolei MCP 密钥就开(和 ai-kit 找密钥的顺序一致:
 *     环境变量 BAOLEI_MCP_URL + BAOLEI_MCP_TOKEN → ~/.claude.json → ~/.codex/config.toml);
 *   - BROWSER_TELEMETRY_URL 改上报地址(默认 <堡垒机 MCP 地址去掉 /mcp>/ai-kit/telemetry),
 *     BROWSER_TELEMETRY_TOKEN 改密钥,BROWSER_TELEMETRY_FLUSH_MS 改攒批间隔(默认 60 秒,最少 1 秒;首批 10 秒内发)。
 *   - baolei MCP 密钥权限很高(能在服务器上执行命令),只发往 baolei 自己:自定义地址和 baolei 不同源时
 *     必须同时给 BROWSER_TELEMETRY_TOKEN,否则不上报。
 *   - 进程退出前(stdio 断开 / SIGTERM)尽量补发一次,最多等 800ms,短会话的数据也能进成绩单。
 *
 * 上报格式(契约 v1,堡垒机那边按这个收):
 *   POST <url>  Authorization: Bearer <密钥>  content-type: application/json
 *   { "event": "tool_calls", "project": "localmcpbrower", "version": "2.3.2", "service": "headless",
 *     "calls": [{ "tool": "navigate", "ok": true, "ms": 812, "bytes": 431, "truncated": false, "retry": false }] }
 *   retry = 本会话里同一个工具上一次调用失败、这次又调(重试率的口径)。
 *   calls 1–100 条;成功回 2xx。回 4xx 说明对方还不收(或密钥不对),暂停 6 小时再试,不刷屏。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface ToolCallSample {
  tool: string;
  ok: boolean;
  ms: number;
  bytes: number;
  truncated: boolean;
  retry?: boolean;
}

export interface TelemetryTarget {
  url: string;
  token: string;
}

export interface TelemetryPayload {
  event: 'tool_calls';
  project: 'localmcpbrower';
  version: string;
  service: string;
  calls: ToolCallSample[];
}

type Env = Record<string, string | undefined>;
type ReadText = (file: string) => string | null;

const OFF = new Set(['0', 'off', 'false', 'no']);
export const TELEMETRY_PATH = '/ai-kit/telemetry';

const readText: ReadText = (file) => {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
};

function bearerOf(servers: unknown): TelemetryTarget | null {
  const s = (servers as Record<string, { url?: unknown; headers?: Record<string, unknown> }> | undefined)?.['baolei'];
  const auth = s?.headers?.['Authorization'] ?? s?.headers?.['authorization'];
  if (typeof s?.url === 'string' && typeof auth === 'string' && auth.startsWith('Bearer ')) {
    return { url: s.url, token: auth.slice(7).trim() };
  }
  return null;
}

/** 本机 baolei MCP 的地址和密钥(和 ai-kit lib.mjs baoleiEndpoint() 同一套查找顺序) */
export function baoleiEndpoint(env: Env, home: string, read: ReadText = readText): TelemetryTarget | null {
  if (env['BAOLEI_MCP_URL'] && env['BAOLEI_MCP_TOKEN']) return { url: env['BAOLEI_MCP_URL'], token: env['BAOLEI_MCP_TOKEN'] };
  const raw = read(path.join(home, '.claude.json'));
  if (raw) {
    try {
      const claude = JSON.parse(raw) as { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> };
      const found = bearerOf(claude.mcpServers)
        ?? Object.values(claude.projects ?? {}).map((p) => bearerOf(p?.mcpServers)).find(Boolean);
      if (found) return found;
    } catch { /* 文件坏了就当没有 */ }
  }
  const toml = read(path.join(home, '.codex', 'config.toml'));
  if (toml) {
    const section = /\[mcp_servers\.baolei\]([\s\S]*?)(?=\n\[|$)/.exec(toml)?.[1] ?? '';
    const url = /^\s*url\s*=\s*"([^"]+)"/m.exec(section)?.[1];
    let token = /Authorization\s*=\s*"Bearer\s+([^"]+)"/.exec(section)?.[1];
    const envVar = /^\s*bearer_token_env_var\s*=\s*"([^"]+)"/m.exec(section)?.[1];
    if (!token && envVar) token = env[envVar];
    if (url && token) return { url, token };
  }
  return null;
}

/** 上报到哪(null = 不上报) */
export function resolveTarget(env: Env, home: string, read: ReadText = readText): TelemetryTarget | null {
  if (OFF.has((env['BROWSER_TELEMETRY'] ?? '').trim().toLowerCase())) return null;
  const endpoint = baoleiEndpoint(env, home, read);
  const explicitToken = (env['BROWSER_TELEMETRY_TOKEN'] ?? '').trim();
  const explicitUrl = (env['BROWSER_TELEMETRY_URL'] ?? '').trim();
  const url = explicitUrl || (endpoint ? endpoint.url.replace(/\/mcp\/?$/, '') + TELEMETRY_PATH : '');
  if (!url) return null;
  if (explicitToken) return { url, token: explicitToken };
  // baolei 密钥只发往 baolei 自己的源,绝不跟着自定义地址发出去
  if (endpoint && sameOrigin(url, endpoint.url)) return { url, token: endpoint.token };
  return null;
}

function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

/** 会话内的重试判定:同一个工具上一次失败、这次又调 → retry */
export class RetryTracker {
  private readonly lastFailed = new Map<string, boolean>();

  mark(sample: ToolCallSample): ToolCallSample {
    const retry = this.lastFailed.get(sample.tool) === true;
    this.lastFailed.set(sample.tool, !sample.ok);
    return { ...sample, retry };
  }
}

/** 一次工具调用的样本:ok 以工具自己的 success 为准,bytes 是回给 AI 的全部文本(token 的代理指标) */
export function sampleOf(tool: string, out: unknown, ms: number, raw?: unknown): ToolCallSample {
  const result = out as { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;
  let bytes = 0;
  for (const c of result?.content ?? []) if (typeof c.text === 'string') bytes += Buffer.byteLength(c.text);
  const r = raw as { success?: unknown; data?: { truncated?: unknown } } | undefined;
  const ok = typeof r?.success === 'boolean' ? r.success : !result?.isError;
  return { tool, ok, ms: Math.max(0, Math.round(ms)), bytes, truncated: r?.data?.truncated === true };
}

export type Sender = (target: TelemetryTarget, payload: TelemetryPayload) => Promise<number>;

const fetchSender: Sender = async (target, payload) => {
  const res = await fetch(target.url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${target.token}`,
      'content-type': 'application/json',
      'user-agent': `localmcpbrower/${payload.version}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  });
  return res.status;
};

export interface TelemetryOptions {
  target: TelemetryTarget;
  version: string;
  service: string;
  send?: Sender;
  flushMs?: number;
  firstFlushMs?: number;
  maxBatch?: number;
  maxBuffer?: number;
  pauseMs?: number;
  now?: () => number;
}

export class ToolTelemetry {
  private buffer: ToolCallSample[] = [];
  private sending = false;
  private pausedUntil = 0;
  private timer: NodeJS.Timeout | null = null;
  private flushedOnce = false;
  /** 缓冲满了丢掉的条数(只给排查用) */
  dropped = 0;

  constructor(private readonly opts: TelemetryOptions) {}

  /** 只推进内存,O(1),永不抛 */
  record(sample: ToolCallSample): void {
    try {
      const max = this.opts.maxBuffer ?? 500;
      this.buffer.push(sample);
      if (this.buffer.length > max) {
        this.dropped += this.buffer.length - max;
        this.buffer.splice(0, this.buffer.length - max);
      }
      this.schedule();
    } catch { /* 遥测永远不影响工具 */ }
  }

  get pending(): number {
    return this.buffer.length;
  }

  private schedule(): void {
    if (this.timer) return;
    const every = this.opts.flushMs ?? 60_000;
    const delay = this.flushedOnce ? every : Math.min(every, this.opts.firstFlushMs ?? 10_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushedOnce = true;
      void this.flush();
    }, delay);
    this.timer.unref?.();
  }

  /** 发一批(最多 maxBatch 条);发不出去的放回缓冲,下次再发 */
  async flush(): Promise<void> {
    const now = this.opts.now ?? Date.now;
    if (this.sending || this.buffer.length === 0) return;
    if (now() < this.pausedUntil) { this.schedule(); return; }
    this.sending = true;
    const calls = this.buffer.splice(0, this.opts.maxBatch ?? 100);
    try {
      const status = await (this.opts.send ?? fetchSender)(this.opts.target, {
        event: 'tool_calls', project: 'localmcpbrower', version: this.opts.version, service: this.opts.service, calls,
      });
      if (status >= 400 && status < 500) this.pausedUntil = now() + (this.opts.pauseMs ?? 6 * 3600_000);
      else if (status >= 500) this.requeue(calls);
    } catch {
      this.requeue(calls);
    } finally {
      this.sending = false;
      if (this.buffer.length) this.schedule();
    }
  }

  /** 退出前补发:把缓冲尽量发完,最多等 timeoutMs,永不抛 */
  async drain(timeoutMs = 800): Promise<void> {
    try {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      const deadline = Date.now() + timeoutMs;
      const work = (async () => {
        while (this.buffer.length && Date.now() < deadline && !this.sending) {
          const before = this.buffer.length;
          await this.flush();
          if (this.buffer.length >= before) break; // 发不出去(暂停中 / 失败放回)就别空转
        }
      })();
      await Promise.race([work, new Promise((r) => { const t = setTimeout(r, timeoutMs); t.unref?.(); })]);
    } catch { /* 遥测永远不影响退出 */ }
  }

  private requeue(calls: ToolCallSample[]): void {
    this.buffer.unshift(...calls);
    const max = this.opts.maxBuffer ?? 500;
    if (this.buffer.length > max) {
      this.dropped += this.buffer.length - max;
      this.buffer.splice(0, this.buffer.length - max);
    }
  }
}

/** 按环境建一个(没配堡垒机密钥或被关掉 → null) */
export function createToolTelemetry(version: string, service: string, env: Env = process.env, home = os.homedir()): ToolTelemetry | null {
  try {
    const target = resolveTarget(env, home);
    const flushMs = Math.max(1000, Number(env['BROWSER_TELEMETRY_FLUSH_MS']) || 60_000);
    return target ? new ToolTelemetry({ target, version, service, flushMs }) : null;
  } catch {
    return null;
  }
}
