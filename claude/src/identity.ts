/**
 * 工作区身份(docs/architecture.md §12):一个工作区 = 一个稳定的「回访用户」。
 *
 * 存在该工作区 profile 目录里的 identity.json(跟着登录态走,删 profile 身份一起没):
 *   screen   屏幕尺寸。无头时经 --screen-info 报给页面;有头用真实屏幕,这项不生效。
 *            默认工作区固定 1920×1080,别的工作区首次创建时从常见分辨率里随机挑一个,以后不变。
 *   locale   语言(--lang / --accept-lang,JS、请求头、Worker 三处一致),默认 zh-CN。
 *   proxy    代理(http:// https:// socks5://,可带账号);null = 直连。
 *   humanize 拟人操作开关;null = 跟环境变量 BROWSER_HUMANIZE。
 *   geo      经代理查到的出口 IP 和时区(geoip.ts);时区跟着它走。换了代理就作废重查。
 *
 * 只用原生通道(启动参数 / 上下文选项),不在页面里改任何值。平台不伪装:字体和 GPU 跟着真实系统,改平台反而自相矛盾。
 */

import { randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const IDENTITY_FILE = 'identity.json';

const ScreenSchema = z.object({ width: z.number().int().min(800).max(7680), height: z.number().int().min(600).max(4320) });
const GeoSchema = z.object({ proxy: z.string(), ip: z.string(), timezone: z.string(), country: z.string(), at: z.number() });
const IdentitySchema = z.object({
  version: z.literal(1),
  screen: ScreenSchema,
  locale: z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
  proxy: z.string().nullable(),
  humanize: z.boolean().nullable(),
  geo: GeoSchema.nullable(),
});
export type Identity = z.infer<typeof IdentitySchema>;
export type Screen = z.infer<typeof ScreenSchema>;

/** 常见桌面分辨率(按大致占比重复几次 1920×1080) */
const COMMON_SCREENS: Screen[] = [
  { width: 1920, height: 1080 }, { width: 1920, height: 1080 }, { width: 1920, height: 1080 },
  { width: 1536, height: 864 }, { width: 2560, height: 1440 }, { width: 1366, height: 768 },
  { width: 1440, height: 900 }, { width: 1680, height: 1050 },
];
const DEFAULT_SCREEN: Screen = { width: 1920, height: 1080 };

/** 代理主机名:字母数字点横线,或方括号里的 IPv6 */
const PROXY_HOST_RE = /^([A-Za-z0-9.-]+|\[[0-9a-fA-F:.]+\])$/;

/**
 * 代理地址格式校验(space_new 的入参和 BROWSER_PROXY 都过它)。按 URL 解析严格查:只许 http / https / socks5、
 * 没有路径 / 查询 / 片段(否则 `http://tok#en@proxy` 会被解析成主机 tok,半截密码进启动参数和 DNS 查询)。
 * socks5 带账号密码的不收:Chromium 不支持 SOCKS5 认证,收下了工作区会起不来。
 */
export function isProxyUrl(url: string): boolean {
  const v = url.trim();
  if (!v || /\s/.test(v)) return false;
  let u: URL;
  try { u = new URL(v); } catch { return false; }
  if (!/^(https?|socks5):$/i.test(u.protocol) || u.search || u.hash) return false;
  if (u.pathname !== '' && u.pathname !== '/') return false;
  if (!PROXY_HOST_RE.test(u.hostname)) return false;
  return !(u.protocol.toLowerCase() === 'socks5:' && (u.username || u.password));
}

/** 回环 / 局域网地址(公司自己的代理一般在这里) */
function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1') return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(h);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * AI 经工具(space_new)能挂的代理:本机 / 局域网的,或运维在 BROWSER_PROXY_ALLOW 里列出的主机(`host` 或 `host:port`,逗号分隔)。
 * 不限制的话,被网页诱导的 AI 一次调用就能把工作区永久挂到攻击者的代理上,明文 http 的内网系统、它们的 cookie 全过对方的手。
 */
export function proxyAllowedForTool(url: string, env: Record<string, string | undefined> = process.env): boolean {
  if (!isProxyUrl(url)) return false;
  const u = new URL(url.trim());
  if (isPrivateHost(u.hostname)) return true;
  const allow = (env['BROWSER_PROXY_ALLOW'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const host = u.hostname.toLowerCase();
  return allow.includes(host) || (u.port !== '' && allow.includes(`${host}:${u.port}`));
}

/** 给人看 / 进事件流的代理地址:账号密码换成 *** */
export function maskProxy(url: string | null): string | null {
  return url ? url.replace(/\/\/[^/@]+@/, '//***@') : null;
}

/** 代理地址 → Playwright 的 proxy 选项(账号密码拆出来,不留在 server 里) */
export function proxyOption(url: string): { server: string; username?: string; password?: string } {
  const u = new URL(url.trim());
  const server = `${u.protocol}//${u.host}`;
  if (!u.username) return { server };
  return { server, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

export function pickScreen(rand: (n: number) => number = randomInt): Screen {
  return COMMON_SCREENS[rand(COMMON_SCREENS.length)] ?? DEFAULT_SCREEN;
}

/** 身份读不了 / 坏了 / 环境变量不对:拒绝启动(宁可起不来,也不悄悄改成直连、暴露真实出口) */
export class IdentityError extends Error {
  constructor(readonly kind: 'unreadable' | 'broken' | 'env', message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/** 运维给默认工作区配的代理(BROWSER_PROXY);格式不对直接报错 */
function envProxy(isDefaultSpace: boolean, env: Record<string, string | undefined>): string | null {
  const v = isDefaultSpace ? (env['BROWSER_PROXY'] ?? '').trim() : '';
  if (!v) return null;
  if (!isProxyUrl(v)) throw new IdentityError('env', 'BROWSER_PROXY 格式不对(http:// https:// socks5://,socks5 不能带账号密码),默认工作区不启动');
  return v;
}

export function defaultIdentity(isDefaultSpace: boolean, env: Record<string, string | undefined> = process.env, rand?: (n: number) => number): Identity {
  return {
    version: 1,
    screen: isDefaultSpace ? DEFAULT_SCREEN : pickScreen(rand),
    locale: 'zh-CN',
    proxy: envProxy(isDefaultSpace, env),
    humanize: null,
    geo: null,
  };
}

function readIdentity(file: string): Identity | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new IdentityError('unreadable', `读不了身份文件 ${file}(${(e as NodeJS.ErrnoException).code ?? String(e)}),工作区先不启动`);
  }
  let parsed: ReturnType<typeof IdentitySchema.safeParse> | null = null;
  try { parsed = IdentitySchema.safeParse(JSON.parse(raw)); } catch { /* 不是 JSON */ }
  if (parsed?.success) return parsed.data;
  throw new IdentityError('broken', `身份文件 ${file} 坏了,工作区先不启动(里面可能记着代理,直接重建会悄悄改成直连)。`
    + '用 space_new({ name, proxy: "<代理>" 或 "" }) 重设,旧文件会留备份');
}

/**
 * 读身份。没有就按默认新建;读不了 / 坏了抛 IdentityError(失败即关)。
 * 默认工作区以运维配的 BROWSER_PROXY 为准(和身份里记的不一样就改过来)。
 */
export function loadIdentity(dir: string, isDefaultSpace: boolean, env: Record<string, string | undefined> = process.env): Identity {
  const file = path.join(dir, IDENTITY_FILE);
  const stored = readIdentity(file);
  const forced = envProxy(isDefaultSpace, env);
  if (stored && (!forced || stored.proxy === forced)) return stored;
  const next = stored ? { ...stored, proxy: forced, geo: null } : defaultIdentity(isDefaultSpace, env);
  try { saveIdentity(dir, next); } catch (e) {
    console.error(`[identity] 写不进 ${file}:${e instanceof Error ? e.message : String(e)}(这次先用内存里的身份)`);
  }
  return next;
}

/** 写身份:目录 0700、文件 0600(里面可能有代理账号密码) */
export function saveIdentity(dir: string, id: Identity): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, IDENTITY_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(id, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * space_new 改身份:proxy 给 "" = 清掉;返回新身份和代理是否变了(变了要重启浏览器才生效)。
 * 身份文件坏了时,显式给了 proxy(含 "")= 人 / AI 明确重设:留 .broken-<时刻> 备份(0600)后按默认重建。
 */
export function patchIdentity(dir: string, isDefaultSpace: boolean, patch: { proxy?: string; humanize?: boolean }): { identity: Identity; proxyChanged: boolean } {
  let cur: Identity;
  let rebuilt = false;   // 从坏文件重建的:浏览器若开着,按新身份重开
  try {
    cur = loadIdentity(dir, isDefaultSpace);
  } catch (e) {
    if (!(e instanceof IdentityError) || e.kind !== 'broken' || patch.proxy === undefined) throw e;
    const file = path.join(dir, IDENTITY_FILE);
    const backup = `${file}.broken-${Date.now()}`;
    fs.copyFileSync(file, backup);
    fs.chmodSync(backup, 0o600);
    cur = defaultIdentity(isDefaultSpace);
    rebuilt = true;
  }
  const proxy = patch.proxy === undefined ? cur.proxy : (patch.proxy.trim() || null);
  const next: Identity = { ...cur, proxy, humanize: patch.humanize ?? cur.humanize, geo: proxy === cur.proxy ? cur.geo : null };
  saveIdentity(dir, next);
  return { identity: next, proxyChanged: rebuilt || proxy !== cur.proxy };
}

/** navigator.languages 的顺序:zh-CN → zh-CN,zh,en;en-US → en-US,en */
export function acceptLanguages(locale: string): string {
  const base = locale.split('-')[0] ?? locale;
  const list = [locale, base, 'en'].filter((v, i, a) => a.indexOf(v) === i);
  return list.join(',');
}

/** 任务栏 / 菜单栏占掉的高度(无头时报给页面的可用区域;真机上 availHeight 总比 height 小) */
function workArea(platform: NodeJS.Platform): { edge: 'workAreaTop' | 'workAreaBottom'; px: number } {
  if (platform === 'darwin') return { edge: 'workAreaTop', px: 25 };
  if (platform === 'linux') return { edge: 'workAreaTop', px: 32 };
  return { edge: 'workAreaBottom', px: 48 };
}

/**
 * 身份对应的启动参数。--screen-info 只给无头(有头用真实屏幕)。
 * 挂了代理时 WebRTC 只许走代理:Chromium 默认 STUN 走 UDP 直连,页面能拿到真实出口 IP,检测站专门比这个。
 */
export function identityArgs(id: Identity, headless: boolean, platform: NodeJS.Platform = process.platform): string[] {
  const args = [`--lang=${id.locale}`, `--accept-lang=${acceptLanguages(id.locale)}`];
  const wa = workArea(platform);
  if (headless) args.push(`--screen-info={0,0 ${id.screen.width}x${id.screen.height} ${wa.edge}=${wa.px}}`);
  if (id.proxy) args.push('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
  return args;
}

/**
 * 浏览器进程要额外带的环境变量:时区跟出口时在 Linux / macOS 上设 TZ ——
 * 上下文的 timezoneId 是按页面经 CDP 下发的,Service / Shared Worker 里多半还是系统时区,自相矛盾。Windows 不认 TZ。
 */
export function identityEnv(id: Identity, platform: NodeJS.Platform = process.platform): Record<string, string> {
  const tz = effectiveTimezone(id);
  return tz && platform !== 'win32' ? { TZ: tz } : {};
}

/** 窗口不能比屏幕大(无头时屏幕是报出来的,窗口按配置开,得收进屏幕里) */
export function fitWindow(
  width: number, height: number, screen: Screen, headless: boolean, platform: NodeJS.Platform = process.platform,
): { width: number; height: number } {
  if (!headless) return { width, height };
  // 最多和「最大化」一样大:屏幕减去任务栏 / 菜单栏
  return { width: Math.min(width, screen.width), height: Math.min(height, screen.height - workArea(platform).px) };
}

/** 现在该用的时区:有代理且查过出口就跟出口走;否则 null = 跟系统 */
export function effectiveTimezone(id: Identity): string | null {
  return id.proxy && id.geo && id.geo.proxy === id.proxy ? id.geo.timezone : null;
}

/** 有代理但还没查过(或换了代理)出口 */
export function needsGeo(id: Identity): boolean {
  return !!id.proxy && (!id.geo || id.geo.proxy !== id.proxy);
}

/** 上下文选项:代理和时区 */
export function contextOptions(id: Identity): { proxy?: ReturnType<typeof proxyOption>; timezoneId?: string } {
  const tz = effectiveTimezone(id);
  return { ...(id.proxy ? { proxy: proxyOption(id.proxy) } : {}), ...(tz ? { timezoneId: tz } : {}) };
}
