/**
 * 查工作区代理的出口 IP 和时区(docs/architecture.md §12)。
 *
 * 必须经**这个工作区的浏览器自己**去查:Node 端的请求不走浏览器的代理(SOCKS5 / 带账号的 HTTP 代理尤其如此),
 * 查到的会是本机真实出口。所以在启动自带的空白页上用 CDP Runtime.evaluate 跑一次 fetch
 * (和 browser.ts 读默认 Client Hints 同一个做法:不导航、不开新标签页、不进隔离世界)。
 * 两个公开接口轮流试,都失败返回 null(调用方照常启动,只是时区不跟出口)。
 */

import type { BrowserContext } from 'patchright';
import { z } from 'zod';

const GeoSchema = z.object({
  ip: z.string().min(3).max(64),
  timezone: z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){1,2}$/),
  country: z.string().max(8),
});
export type GeoResult = z.infer<typeof GeoSchema>;

const LOOKUP_SRC = `(async () => {
  const urls = ['https://ipinfo.io/json', 'http://ip-api.com/json/?fields=status,query,timezone,countryCode'];
  for (const u of urls) {
    try {
      const r = await fetch(u, { cache: 'no-store', credentials: 'omit' });
      if (!r.ok) continue;
      const j = await r.json();
      const ip = j.ip || j.query, timezone = j.timezone, country = j.country || j.countryCode || '';
      if (ip && timezone) return { ip: String(ip), timezone: String(timezone), country: String(country) };
    } catch (e) { /* 换下一个 */ }
  }
  return null;
})()`;

const LOOKUP_TIMEOUT_MS = 20_000;

export async function lookupGeo(context: BrowserContext): Promise<GeoResult | null> {
  const page = context.pages()[0];
  if (!page) return null;
  const s = await context.newCDPSession(page);
  try {
    const run = s.send('Runtime.evaluate', { expression: LOOKUP_SRC, awaitPromise: true, returnByValue: true });
    const timeout = new Promise<null>((r) => { setTimeout(() => r(null), LOOKUP_TIMEOUT_MS).unref(); });
    const res = await Promise.race([run, timeout]);
    const parsed = GeoSchema.safeParse(res?.result.value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    await s.detach().catch(() => { /* 浏览器可能已经没了 */ });
  }
}
