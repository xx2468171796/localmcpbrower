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
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/),
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

const PROXY_RE = /^(https?|socks5):\/\/([^\s/@]+@)?[^\s/@:]+(:\d{1,5})?\/?$/i;

/** 代理地址格式校验(space_new 的入参和 BROWSER_PROXY 都过它) */
export function isProxyUrl(url: string): boolean {
  return PROXY_RE.test(url.trim());
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

export function defaultIdentity(isDefaultSpace: boolean, env: Record<string, string | undefined> = process.env, rand?: (n: number) => number): Identity {
  const proxy = isDefaultSpace ? (env['BROWSER_PROXY'] ?? '').trim() : '';
  return {
    version: 1,
    screen: isDefaultSpace ? DEFAULT_SCREEN : pickScreen(rand),
    locale: 'zh-CN',
    proxy: proxy && isProxyUrl(proxy) ? proxy : null,
    humanize: null,
    geo: null,
  };
}

/** 读身份;没有或坏了就按默认新建并写回(坏文件不让启动失败) */
export function loadIdentity(dir: string, isDefaultSpace: boolean, env: Record<string, string | undefined> = process.env): Identity {
  const file = path.join(dir, IDENTITY_FILE);
  try {
    const parsed = IdentitySchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (parsed.success) return parsed.data;
  } catch { /* 没有或读不了:按默认建 */ }
  const fresh = defaultIdentity(isDefaultSpace, env);
  saveIdentity(dir, fresh);
  return fresh;
}

export function saveIdentity(dir: string, id: Identity): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, IDENTITY_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(id, null, 2));
  fs.renameSync(tmp, file);
}

/** space_new 改身份:proxy 给 "" = 清掉;返回新身份和代理是否变了(变了要重启浏览器才生效) */
export function patchIdentity(dir: string, isDefaultSpace: boolean, patch: { proxy?: string; humanize?: boolean }): { identity: Identity; proxyChanged: boolean } {
  const cur = loadIdentity(dir, isDefaultSpace);
  const proxy = patch.proxy === undefined ? cur.proxy : (patch.proxy.trim() || null);
  const next: Identity = { ...cur, proxy, humanize: patch.humanize ?? cur.humanize, geo: proxy === cur.proxy ? cur.geo : null };
  saveIdentity(dir, next);
  return { identity: next, proxyChanged: proxy !== cur.proxy };
}

/** navigator.languages 的顺序:zh-CN → zh-CN,zh,en;en-US → en-US,en */
export function acceptLanguages(locale: string): string {
  const base = locale.split('-')[0] ?? locale;
  const list = [locale, base, 'en'].filter((v, i, a) => a.indexOf(v) === i);
  return list.join(',');
}

/** 任务栏 / 菜单栏占掉的高度(无头时报给页面的可用区域;真机上 availHeight 总比 height 小) */
function workArea(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'workAreaTop=25';
  if (platform === 'linux') return 'workAreaTop=32';
  return 'workAreaBottom=48';
}

/** 身份对应的启动参数。--screen-info 只给无头(有头用真实屏幕) */
export function identityArgs(id: Identity, headless: boolean, platform: NodeJS.Platform = process.platform): string[] {
  const args = [`--lang=${id.locale}`, `--accept-lang=${acceptLanguages(id.locale)}`];
  if (headless) args.push(`--screen-info={0,0 ${id.screen.width}x${id.screen.height} ${workArea(platform)}}`);
  return args;
}

/** 窗口不能比屏幕大(无头时屏幕是报出来的,窗口按配置开,得收进屏幕里) */
export function fitWindow(width: number, height: number, screen: Screen, headless: boolean): { width: number; height: number } {
  if (!headless) return { width, height };
  return { width: Math.min(width, screen.width), height: Math.min(height, screen.height - 80) };
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
