/**
 * 无头浏览器的 UA 与 Client Hints —— 版本从真实浏览器读,不写死。
 *
 * 背景(2026-10-15 实测,patchright 1.63 / Chromium 153.0.8010.12,Windows):
 *   - 有头(channel=chromium,完整版):UA `Chrome/153.0.0.0`(UA 精简后的格式),
 *     brands = [Chromium 153, Not_A Brand 8],平台版本是真的(Win11 报 20.0.0)。本来就自洽 → **有头不覆盖**。
 *   - 无头:UA 里是 `HeadlessChrome/153.0.8010.12`,brands 第一个就是 `HeadlessChrome` —— 一眼看出是机器人。
 *   - 原实现给 launchPersistentContext 传 userAgent(还写死 Chrome/148,而内核早就是 153):
 *     patchright 会顺带下发 userAgentMetadata,但它只填 platform / platformVersion / architecture,
 *     **不填 brands / fullVersionList** —— 结果 UA 说「Chrome/148」,
 *     navigator.userAgentData.brands 和 Sec-CH-UA 请求头仍是「HeadlessChrome 153」,
 *     platformVersion 还被改成 UA 里冻结的「10.0」(真机 Win11 是 13 以上)。三处自相矛盾,比不改更显眼。
 *
 * 现在的做法(无头):
 *   1. 启动选项 userAgent 仍然给(patchright 会把它下发到每个页面、跨域 iframe、Service Worker,覆盖面最全),
 *      版本取 patchright 自带的 browsers.json(就是这次要启动的那个内核),格式与真 Chrome 一致:`Chrome/<主版本>.0.0.0`;
 *   2. 启动后从浏览器读出真实的默认 Client Hints,只把 HeadlessChrome 这个品牌换掉,
 *      再用 CDP Emulation.setUserAgentOverride 给**每个页面**补上完整的 userAgentMetadata(brands / fullVersionList /
 *      真实 platformVersion …)。页面上的这次下发晚于 patchright 自己那次,以它为准。
 * 剩下的缺口:跨域 iframe、Worker 的 Client Hints 品牌仍带 HeadlessChrome(CDP 只能按页面下发);
 * 要完全一致就用有头(wait_for_human 那种按需弹窗)。
 *
 * UA_CHROME_VERSION 只作显式覆盖:设了就用它(例如要伪装成某个版本),不设就按真实版本。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export interface Brand { brand: string; version: string }

/** CDP Emulation.UserAgentMetadata(只列我们会填的字段) */
export interface UaMetadata {
  brands: Brand[];
  fullVersionList: Brand[];
  fullVersion: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness?: string;
  wow64?: boolean;
}

/** 页面里 navigator.userAgentData.getHighEntropyValues 读回来的默认值(字段都可能缺) */
export interface UaDefaults {
  brands?: Brand[];
  fullVersionList?: Brand[];
  platform?: string;
  platformVersion?: string;
  architecture?: string;
  model?: string;
  mobile?: boolean;
  bitness?: string;
  wow64?: boolean;
}

/** 读默认 Client Hints 的页面脚本(经 CDP Runtime.evaluate,awaitPromise + returnByValue) */
export const READ_UA_DEFAULTS_SRC = `(async () => {
  const d = navigator.userAgentData;
  if (!d) return null;
  const h = await d.getHighEntropyValues(['architecture','bitness','model','platformVersion','fullVersionList','wow64']);
  return { brands: d.brands, mobile: d.mobile, platform: d.platform, ...h };
})()`;

/** patchright 自带的内核版本(browsers.json);读不出返回 null(不让启动因此失败) */
export function bundledChromiumVersion(): string | null {
  try {
    const req = createRequire(import.meta.url);
    // patchright-core 不一定在顶层 node_modules(pnpm),从 patchright 自己的位置去找
    const fromPatchright = createRequire(req.resolve('patchright'));
    const pkg = fromPatchright.resolve('patchright-core/package.json');
    const json = JSON.parse(fs.readFileSync(path.join(path.dirname(pkg), 'browsers.json'), 'utf8')) as {
      browsers?: Array<{ name?: string; browserVersion?: string }>;
    };
    const hit = json.browsers?.find((b) => b.name === 'chromium-headless-shell') ?? json.browsers?.find((b) => b.name === 'chromium');
    return hit?.browserVersion && /^\d+(\.\d+)*$/.test(hit.browserVersion) ? hit.browserVersion : null;
  } catch {
    return null;
  }
}

/** 主版本号('153.0.8010.12' → '153');认不出返回 null */
export function majorOf(version: string | null | undefined): string | null {
  const m = /^(\d+)/.exec((version ?? '').trim());
  return m?.[1] ?? null;
}

/** UA 里的版本 token:显式覆盖原样用;真实版本按真 Chrome 的精简格式 <主版本>.0.0.0 */
export function uaVersionToken(explicit: string | undefined, realVersion: string | null): string | null {
  const e = (explicit ?? '').trim();
  if (e) return e;
  const major = majorOf(realVersion);
  return major ? `${major}.0.0.0` : null;
}

/** 各平台真 Chrome(UA 精简后)的 UA 外形;版本 token 由调用方给 */
export function platformUserAgent(platform: NodeJS.Platform, versionToken: string): string {
  const os = platform === 'win32'
    ? 'Windows NT 10.0; Win64; x64'
    : platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${versionToken} Safari/537.36`;
}

/**
 * 由默认 Client Hints 算出「像有头 Chromium」的那份:去掉 HeadlessChrome 品牌,
 * 保证有 Chromium 品牌(版本跟 UA 一致),GREASE 品牌原样保留(它随版本变,不能自己编)。
 * 显式覆盖版本时,Chromium 品牌和 fullVersion 也跟着覆盖版本走,三处一致。
 */
export function headfulMetadata(defaults: UaDefaults | null, realVersion: string, explicitVersion?: string): UaMetadata {
  const full = (explicitVersion ?? '').trim() || realVersion;
  const major = majorOf(full) ?? full;
  const fix = (list: Brand[] | undefined, ver: string): Brand[] => {
    const rest = (list ?? []).filter((b) => b.brand !== 'HeadlessChrome' && b.brand !== 'Chromium');
    const grease = rest.length ? rest : [greaseBrand(Number(major), ver === major)];
    // 有头 Chromium 153 实测顺序:Chromium 在前,GREASE 在后
    return [{ brand: 'Chromium', version: ver }, ...grease];
  };
  return {
    brands: fix(defaults?.brands, major),
    fullVersionList: fix(defaults?.fullVersionList, full),
    fullVersion: full,
    platform: defaults?.platform ?? fallbackPlatform(process.platform),
    platformVersion: defaults?.platformVersion ?? '',
    architecture: defaults?.architecture ?? (process.arch === 'arm64' ? 'arm' : 'x86'),
    model: defaults?.model ?? '',
    mobile: defaults?.mobile ?? false,
    ...(defaults?.bitness !== undefined ? { bitness: defaults.bitness } : {}),
    ...(defaults?.wow64 !== undefined ? { wow64: defaults.wow64 } : {}),
  };
}

function fallbackPlatform(p: NodeJS.Platform): string {
  return p === 'win32' ? 'Windows' : p === 'darwin' ? 'macOS' : 'Linux';
}

/**
 * 读不到默认值时的兜底 GREASE 品牌,按 Chromium 的算法(以主版本为种子)生成。
 * 153 → "Not_A Brand" / 8,与实测一致。
 */
export function greaseBrand(seed: number, majorOnly: boolean): Brand {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
  const versions = ['8', '99', '24'];
  const s = Number.isFinite(seed) && seed >= 0 ? Math.floor(seed) : 0;
  const v = versions[s % versions.length] ?? '8';
  return { brand: `Not${chars[s % chars.length] ?? '_'}A${chars[(s + 1) % chars.length] ?? ' '}Brand`, version: majorOnly ? v : `${v}.0.0.0` };
}
