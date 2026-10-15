/**
 * 管理接口 /admin/*:给工位管理服务、Hermes 面板、人看状态和接管用。
 *
 * 鉴权独立于 MCP 令牌:设了 ADMIN_TOKEN 就要 Bearer ADMIN_TOKEN;没设时只许本机回环访问
 * (本机单用的人照样能用,外面的人碰不到)。
 * 只做 HTTP 适配:状态从哪来、怎么截图、怎么重启都由调用方以 AdminDeps 传进来。
 */

import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { DeskGate } from './gate.js';
import type { EventRing } from './events.js';

export interface AdminDeps {
  ring: EventRing;
  gate: DeskGate;
  adminToken: string;
  /** 和 /mcp 同一份 Host / Origin 白名单(server.ts 的 ALLOWED):挡 DNS 重绑定和网页跨站请求 */
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
  deskId?: string;
  version: string;
  /** 只读快照,绝不拉起浏览器 */
  state: () => Promise<unknown>;
  screenshot: (space?: string) => Promise<Buffer | null>;
  restart: (space: string) => Promise<unknown>;
  metrics: () => Promise<unknown>;
}

const PauseBody = z.object({
  by: z.string().max(100).optional(),
  reason: z.string().max(500).optional(),
  mode: z.enum(['wait', 'reject']).optional(),
}).strict();
const AllowlistBody = z.object({ domains: z.array(z.string().max(253)).max(500) }).strict();
const SinceQuery = z.object({
  since: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});
const SpaceQuery = z.object({ space: z.string().max(64).optional() });

function isLoopback(addr: string | undefined): boolean {
  const a = (addr ?? '').replace(/^::ffff:/, '');
  return a === '::1' || /^127\./.test(a);
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function apiError(res: Response, status: number, code: string, message: string): void {
  res.status(status).json({ error: { code, message } });
}

export function createAdminRouter(deps: AdminDeps): Router {
  const r = express.Router();
  r.use(express.json({ limit: '64kb' }));
  r.use((req: Request, res: Response, next: NextFunction) => {
    // 被操控的浏览器本身就在本机:任何网页都能对 127.0.0.1 发请求(no-cors POST 照样有副作用),
    // DNS 重绑定还能读到返回。所以 Host 必须是自己的地址,带了 Origin 的(来自网页)必须在白名单里。
    if (!deps.allowedHosts.includes(req.headers.host ?? '')) { apiError(res, 403, 'FORBIDDEN', 'Host 不在允许列表'); return; }
    const origin = req.headers.origin;
    if (origin && !deps.allowedOrigins.includes(origin)) { apiError(res, 403, 'FORBIDDEN', '不接受来自网页的跨站请求'); return; }
    if (!deps.adminToken) {
      if (isLoopback(req.socket.remoteAddress)) { next(); return; }
      apiError(res, 403, 'FORBIDDEN', '没设 ADMIN_TOKEN 时管理接口只许本机访问');
      return;
    }
    const m = /^Bearer\s+(.+)$/i.exec((req.headers.authorization ?? '').trim());
    if (!m?.[1] || !sameToken(m[1].trim(), deps.adminToken)) {
      res.header('WWW-Authenticate', 'Bearer');
      apiError(res, 401, 'UNAUTHORIZED', '管理令牌不对');
      return;
    }
    next();
  });

  r.get('/state', async (_req, res) => {
    try {
      res.json({ deskId: deps.deskId ?? null, version: deps.version, gate: deps.gate.status(), inFlight: deps.ring.inFlight(), lastEventId: deps.ring.lastId, browser: await deps.state() });
    } catch (e) {
      apiError(res, 500, 'INTERNAL', e instanceof Error ? e.message : String(e));
    }
  });

  r.get('/events', (req, res) => {
    const q = SinceQuery.safeParse(req.query);
    if (!q.success) { apiError(res, 400, 'INVALID_ARGS', q.error.message); return; }
    const headerSince = Number(req.headers['last-event-id']);
    const since = Number.isFinite(headerSince) && headerSince > 0 ? headerSince : (q.data.since ?? 0);
    if (!(req.headers.accept ?? '').includes('text/event-stream')) {
      res.json({ events: deps.ring.since(since, q.data.limit ?? 500), lastEventId: deps.ring.lastId });
      return;
    }
    streamEvents(req, res, deps.ring, since);
  });

  r.post('/pause', (req, res) => {
    const b = PauseBody.safeParse(req.body ?? {});
    if (!b.success) { apiError(res, 400, 'INVALID_ARGS', b.error.message); return; }
    const status = deps.gate.pause(b.data);
    deps.ring.push({ kind: 'gate', detail: 'paused', error: b.data.reason });
    res.json(status);
  });

  r.post('/resume', (_req, res) => {
    const status = deps.gate.resume();
    deps.ring.push({ kind: 'gate', detail: 'resumed' });
    res.json(status);
  });

  r.put('/allowlist', (req, res) => {
    const b = AllowlistBody.safeParse(req.body ?? {});
    if (!b.success) { apiError(res, 400, 'INVALID_ARGS', b.error.message); return; }
    const allowlist = deps.gate.setAllowlist(b.data.domains);
    deps.ring.push({ kind: 'gate', detail: `allowlist ${allowlist.length}` });
    res.json({ allowlist });
  });

  r.get('/screenshot', async (req, res) => {
    const q = SpaceQuery.safeParse(req.query);
    if (!q.success) { apiError(res, 400, 'INVALID_ARGS', q.error.message); return; }
    try {
      const png = await deps.screenshot(q.data.space);
      if (!png) { apiError(res, 404, 'NO_PAGE', '这个工作区现在没有打开的页面'); return; }
      res.type('image/png').send(png);
    } catch (e) {
      apiError(res, 500, 'INTERNAL', e instanceof Error ? e.message : String(e));
    }
  });

  r.post('/restart', async (req, res) => {
    const q = SpaceQuery.safeParse(req.query);
    if (!q.success) { apiError(res, 400, 'INVALID_ARGS', q.error.message); return; }
    const space = q.data.space ?? 'default';
    try {
      await deps.restart(space);
      deps.ring.push({ kind: 'browser', space, detail: 'restarted' });
      res.json({ restarted: space });
    } catch (e) {
      apiError(res, 500, 'INTERNAL', e instanceof Error ? e.message : String(e));
    }
  });

  r.get('/metrics', async (_req, res) => {
    try { res.json(await deps.metrics()); } catch (e) { apiError(res, 500, 'INTERNAL', e instanceof Error ? e.message : String(e)); }
  });

  return r;
}

const MAX_STREAMS = 20;
/** 订阅方读不过来时积压超过这么多字节就断开它(它可以带 Last-Event-ID 重连补齐),不让内存越攒越多 */
const MAX_BACKLOG_BYTES = 1_000_000;
let openStreams = 0;

/** 当前打开的实时事件流个数(测试用) */
export function openStreamCount(): number {
  return openStreams;
}

/**
 * SSE:先补发 since 之后的,再实时推;15 秒一次心跳,防代理断开空闲连接。
 * 断开(对方关、积压过多被我们踢、写出错)只走一个 shutdown:置 closed、退订、停心跳、destroy —— 之后的事件 / 心跳
 * 一律不再写。以前积压时只 res.end() 不置 closed,后面的事件继续 write → write after end → 未捕获错误 → 进程退出。
 */
export function streamEvents(_req: Request, res: Response, ring: EventRing, since: number): void {
  if (openStreams >= MAX_STREAMS) { apiError(res, 503, 'TOO_MANY_STREAMS', `实时事件流最多 ${MAX_STREAMS} 个连接`); return; }
  openStreams++;
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  let closed = false;
  let unsubscribe: () => void = () => {};
  let beat: NodeJS.Timeout | undefined;
  const shutdown = (): void => {
    if (closed) return;
    closed = true;
    openStreams--;
    clearInterval(beat);
    unsubscribe();
    if (!res.destroyed) res.destroy();
  };
  const write = (chunk: string): void => {
    if (closed || res.writableEnded || res.destroyed) { shutdown(); return; }
    if (res.writableLength > MAX_BACKLOG_BYTES) { shutdown(); return; }
    res.write(chunk);
  };
  res.on('error', () => shutdown());
  res.on('close', () => shutdown());
  for (const e of ring.since(since, 2000)) write(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
  if (closed) return;
  unsubscribe = ring.subscribe((e) => write(`id: ${e.id}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`));
  beat = setInterval(() => write(': ping\n\n'), 15_000);
}
