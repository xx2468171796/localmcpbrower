/**
 * 资产登记的站点 → 主机规则,以及「页面来源是否属于这条资产」的比对(fill_secret 防外泄的核心判断)。
 *
 * 规则(2026-10 收紧):
 *   - 默认**精确主机名**:登记 example.com 只认 example.com,不认 www.example.com;
 *   - 要放子域名必须明写 `*.example.com`(只认子域名,不含 example.com 本身;两个都要就都登记);
 *   - 登记地址里写了端口(如 http://10.0.0.1:8080)就连端口一起比;没写端口不限端口;
 *   - IP / localhost / [IPv6] 照样认(只精确匹配,通配对 IP 无意义);
 *   - 只从 address 和新版堡垒机的 data.hosts 里取,**绝不用自由填写的 tags**(谁都能往 tags 里写个域名)。
 */

export interface HostRule {
  /** 小写主机名;subdomains=true 时是去掉「*.」后的父域 */
  host: string;
  /** 登记时写明的端口;null = 不限 */
  port: string | null;
  /** 登记为 *.host:只认它的子域名 */
  subdomains: boolean;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** 把一段像网址 / 主机[:端口] 的文字解析成规则;不像就返回 null */
export function parseHostRule(raw: string): HostRule | null {
  let s = raw.trim();
  if (!s) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  const prefix = scheme ? scheme[0] : '';
  let rest = s.slice(prefix.length);
  const subdomains = rest.startsWith('*.');
  if (subdomains) rest = rest.slice(2);
  s = `${prefix || 'http://'}${rest}`;
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    const hostLike = host.includes('.') || host === 'localhost' || host.startsWith('[');
    if (!host || !hostLike) return null;
    // 只有登记文字里真的写了端口才比端口(URL 会把 https 的 :443 规范成空,那也当没写)
    return { host, port: u.port || null, subdomains: subdomains && !IPV4.test(host) && !host.startsWith('[') };
  } catch {
    return null;
  }
}

/** 规则的展示形式(报错里给人看) */
export function ruleText(r: HostRule): string {
  return `${r.subdomains ? '*.' : ''}${r.host}${r.port ? `:${r.port}` : ''}`;
}

/**
 * 资产登记的站点规则:address(可能写成「http://a:1（外网 http://b）」这种)里的网址 / 域名 / IP,
 * 加上新版堡垒机给的 hosts。去重。
 */
export function assetHostRules(info: { address: string; hosts?: readonly string[] }): HostRule[] {
  const out = new Map<string, HostRule>();
  const add = (raw: string): void => {
    const r = parseHostRule(raw);
    if (r) out.set(ruleText(r), r);
  };
  for (const m of info.address.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s()（）,，;；<>"']+/gi)) add(m[0]);
  const bare = /(?:^|[\s(（,，])((?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?|localhost(?::\d+)?)(?=$|[\s/)）,，;；])/gi;
  for (const m of info.address.matchAll(bare)) if (m[1]) add(m[1]);
  for (const h of info.hosts ?? []) add(h);
  return [...out.values()];
}

/** 兼容旧调用:规则的展示文字列表 */
export function assetHosts(info: { address: string; hosts?: readonly string[] }): string[] {
  return assetHostRules(info).map(ruleText);
}

function effectivePort(u: { protocol: string; port: string }): string {
  if (u.port) return u.port;
  return u.protocol === 'https:' || u.protocol === 'wss:' ? '443' : '80';
}

/** 页面(来源 URL)是否属于资产登记的站点 */
export function hostMatches(page: { hostname: string; port: string; protocol: string }, rules: readonly HostRule[]): boolean {
  const h = page.hostname.toLowerCase().replace(/\.$/, '');
  return rules.some((r) => {
    const hostOk = r.subdomains ? h.endsWith(`.${r.host}`) : h === r.host;
    return hostOk && (r.port === null || r.port === effectivePort(page));
  });
}

/** 资产地址里写了网址、且全是 https → 页面也必须是 https(防止降级到明文 http 的同名站点) */
export function requiresHttps(info: { address: string }): boolean {
  const schemes = [...info.address.matchAll(/\b([a-z][a-z0-9+.-]*):\/\//gi)].map((m) => (m[1] ?? '').toLowerCase());
  return schemes.length > 0 && schemes.every((s) => s === 'https');
}
