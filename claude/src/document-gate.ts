/**
 * 文档请求的工位白名单闸门(context 级 route 用)。
 *
 * 白名单为空(本机日常用法):文档请求原样交回浏览器自己发 —— TLS 指纹、请求头(Accept-Language、带 zstd 的
 * Accept-Encoding)、HTTP/2 都是真 Chrome 的。以前为了往 HTML 里注脚本,所有文档都在 Node 端代取(route.fetch),
 * 网站看到的是 Node 的 TLS 指纹和请求头,这是比任何 JS 特征都硬的机器人特征(2026-10-17 体检发现,
 * docs/architecture.md §12)。脚本现在走 context.addInitScript(patchright 1.63 + 完整版 Chromium 实测原生执行)。
 * 「本服务自己的地址」:直接请求由调用方的 route 拦;经重定向落过来的由 HTTP 入口按 Sec-Fetch-* 拒(desk/gate.ts isForeignNavigation)。
 *
 * 白名单非空(托管工位):浏览器自己跟随重定向时后续跳**不经过 route**(实测),所以仍在 Node 端不跟随地取第一跳,
 * 3xx 时把整条链逐跳过白名单,有一跳不许就整个拦下;全许则把第一跳原样交回浏览器自己跳,
 * 地址栏 / location.origin 都是真实的最终站点(fill_secret 的站点检查靠它)。这条路上的文档仍是 Node 代取 ——
 * 工位开了白名单时安全优先于隐身,如实写在这里。
 */

import type { Route } from 'patchright';

/** 逐跳检查重定向链时最多走几跳 */
const MAX_REDIRECT_HOPS = 10;

/** 工位白名单(document 跳转的每一跳都要过);restricting() = 白名单非空 */
export interface NavGate {
  allows: (url: string) => boolean;
  restricting: () => boolean;
  onBlocked: (url: string) => void;
}

/**
 * 顺着重定向链在服务端逐跳查一遍,每一跳都问 allows();有一跳不许就返回那一跳的网址(拦下),全许返回 null。
 * 探测一律用 GET、不带请求体(不重放原请求的方法和表单内容:原请求是 POST 时,重放等于替页面多提交一次)。
 * 按「失败即拦」处理:探测出错、链太长都当作不许。
 */
async function blockedHop(route: Route, first: string, allows: (url: string) => boolean): Promise<string | null> {
  const headers = Object.fromEntries(Object.entries(route.request().headers()).filter(([k]) => !/^content-(type|length)$/i.test(k)));
  let url = first;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const r = await route.fetch({ url, method: 'GET', headers, postData: Buffer.alloc(0), maxRedirects: 0 }).catch(() => null);
    if (!r) return url;
    const loc = r.headers()['location'];
    if (r.status() < 300 || r.status() >= 400 || !loc) return null;
    url = new URL(loc, url).href;
    if (!allows(url)) return url;
  }
  return url;
}

/** 白名单生效时的文档请求:不跟随地取第一跳,3xx 逐跳过白名单 */
async function gatedDocument(route: Route, gate: NavGate): Promise<void> {
  try {
    const resp = await route.fetch({ maxRedirects: 0 });
    const headers = resp.headers();
    if (resp.status() >= 300 && resp.status() < 400 && headers['location']) {
      const target = new URL(headers['location'], route.request().url()).href;
      const bad = !gate.allows(target) ? target : await blockedHop(route, target, gate.allows);
      if (bad) {
        gate.onBlocked(bad);
        await route.abort('blockedbyclient');
        return;
      }
      await route.fulfill({ status: resp.status(), headers });
      return;
    }
    await route.fulfill({ response: resp });
  } catch {
    // 取原响应失败(网络错误 / 被中断):失败即拦 —— 交回浏览器自己取的话,它跟随的重定向就不再经过这里
    await route.abort('blockedbyclient').catch(() => { /* 已被别处处理 */ });
  }
}

export function buildDocumentGate(gate: NavGate) {
  return async function documentRoute(route: Route): Promise<void> {
    if (route.request().resourceType() !== 'document' || !gate.restricting()) {
      await route.fallback();
      return;
    }
    await gatedDocument(route, gate);
  };
}
