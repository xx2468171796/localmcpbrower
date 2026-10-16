/**
 * fill_secret 填 https 站点前,在服务端独立验一次对方证书(防中间人)。
 *
 * 为什么要自己验:本机单用时浏览器开着 ignoreHTTPSErrors(内网自签站点照常打开),
 * 浏览器侧拿不到可信的证书状态。网络上的中间人对浏览器和本进程是同一个(前提:浏览器直连;挂了代理的工作区
 * 不忽略证书错误,由浏览器自己拒 —— 代理可能冒充站点,而本进程是直连验的,见 browser.ts),
 * 校验不过就拒填:证书有问题的页面上,来源比对没有意义。
 *
 * 只缓存「验过了」30 秒(一次 login_with_asset 会连填几个框);失败不缓存。
 */

import tls from 'node:tls';
import { isIP } from 'node:net';

const OK_TTL_MS = 30_000;
const okUntil = new Map<string, number>();

let caCache: string[] | null = null;
/** Node 自带 + NODE_EXTRA_CA_CERTS + 操作系统信任的根证书(公司内网 CA 装在系统里也认) */
function trustedCas(): string[] {
  if (caCache) return caCache;
  const all = new Set<string>();
  for (const kind of ['default', 'system'] as const) {
    try { for (const c of tls.getCACertificates(kind)) all.add(c); } catch { /* 老版本 Node 没有 system */ }
  }
  caCache = [...all];
  return caCache;
}

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    const bare = host.replace(/^\[|\]$/g, '');
    const sock = tls.connect({
      host: bare, port, ca: trustedCas(), rejectUnauthorized: true,
      ...(isIP(bare) ? {} : { servername: bare }),
    }, () => finish(sock.authorized));
    sock.setTimeout(timeoutMs, () => finish(false));
    sock.on('error', () => finish(false));
  });
}

/** https 来源的证书是否可信(主机名、有效期、签发链都对);非 https 返回 true(是否允许明文由 requiresHttps 管) */
export async function originCertTrusted(origin: URL, timeoutMs = 5000): Promise<boolean> {
  if (origin.protocol !== 'https:') return true;
  const port = Number(origin.port || 443);
  const key = `${origin.hostname}:${port}`;
  if ((okUntil.get(key) ?? 0) > Date.now()) return true;
  const ok = await probe(origin.hostname, port, timeoutMs);
  if (ok) okUntil.set(key, Date.now() + OK_TTL_MS);
  return ok;
}
