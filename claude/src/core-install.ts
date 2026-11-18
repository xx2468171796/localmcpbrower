/**
 * 浏览器核心(powerbrowser-core)在这台电脑上的安装:第一次用指纹环境时自己从公司下载源取,不用人装。
 *
 *   ~/.ankotti/browser-core/<版本>/powerbrowser-core[.exe]  核心程序(各平台的版本和 sha256 钉在下面,换核心 = 发一版本服务)
 *   ~/.ankotti/browser-core/browser-mcp.grant               授权文件(核心自己验签和有效期;过期了重新取一次)
 *
 * 程序按 sha256 校验,对不上不落地;按版本分目录,所以正在跑的旧核心不挡新版本落盘。
 * 环境变量 POWERBROWSER_CORE / POWERBROWSER_CORE_GRANT 指了文件就用指的(开发时用),不下载。
 * 下载源:ANKOTTI_DOWNLOAD_SOURCE(默认公司下载源),路径 browser-core/<版本>/<平台>/…
 * 各平台是同一份核心代码(仓库 admin/powerbrowser)编出来的;没有登记的平台(目前 macOS)用到时明说不支持。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 本服务配套的核心版本(仓库 admin/powerbrowser 的 powerbrowser-core) */
export interface CoreBuild { dir: string; file: string; sha256: string; size: number }

/** 本服务配套的核心版本(仓库 admin/powerbrowser 的 powerbrowser-core);键 = Node 的 `<platform>-<arch>` */
export const CORE_RELEASE: { version: string; builds: Readonly<Record<string, CoreBuild>> } = {
  version: '0.2.12',
  builds: {
    'win32-x64': { dir: 'windows-x64', file: 'powerbrowser-core.exe', sha256: 'bda86fe2dd27a320d4cf52cb08d05e67b360a80c6a8305456917d5402998525a', size: 4_242_432 },
    // 在 Ubuntu 20.04 上编的(只要求 glibc 2.31):Ubuntu 20.04 / 22.04 / 24.04、Debian 11 / 12 / 13 都能跑
    'linux-x64': { dir: 'linux-x64-glibc231', file: 'powerbrowser-core', sha256: '88e52618be21318bd2e09e9e7a742c9ef316514789f23539ff93e3db35bc354e', size: 4_659_992 },
  },
};

/** 这台电脑该用哪个核心;没有对应构建就返回 null(纯函数,测试可以传别的平台) */
export function coreBuildFor(platform: string = process.platform, arch: string = process.arch): CoreBuild | null {
  return CORE_RELEASE.builds[`${platform}-${arch}`] ?? null;
}

const GRANT_NAME = 'browser-mcp.grant';
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface CoreFiles { exe: string; grant: string }

const homeDir = (): string => path.join(os.homedir(), '.ankotti', 'browser-core');
const source = (): string => (process.env['ANKOTTI_DOWNLOAD_SOURCE']?.trim() || 'https://baolei.zygskins.cn/dl').replace(/\/+$/, '');

export const sha256Hex = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex');

/** 授权文件长这样:<base64url 载荷>.<base64url 签名>(真假由核心验,这里只挡下载到错误页的情况;纯函数) */
export function looksLikeGrant(text: string): boolean {
  return /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{80,}$/.test(text.trim());
}

async function download(route: string): Promise<Buffer> {
  const url = `${source()}/browser-core/${route}`;
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (e) {
    throw new Error(`下载浏览器核心失败(${url}):${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`下载浏览器核心失败(${url}):HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 先写到旁边再改名:另一个服务同时在装、或者装到一半断电,都不会留下半个文件 */
function placeFile(file: string, buf: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partial = `${file}.partial-${process.pid}`;
  fs.writeFileSync(partial, buf);
  try {
    fs.renameSync(partial, file);
  } catch (e) {
    fs.rmSync(partial, { force: true });
    if (!fs.existsSync(file)) throw e;   // 别人已经放好了(文件正被占用时改名会失败)就用别人的
  }
}

let verifiedExe: string | null = null;

async function ensureExe(): Promise<string> {
  const fromEnv = process.env['POWERBROWSER_CORE']?.trim();
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) throw new Error(`POWERBROWSER_CORE 指的核心程序不存在:${fromEnv}`);
    return fromEnv;
  }
  const build = coreBuildFor();
  if (!build) throw new Error(`指纹环境还不支持这个系统(${process.platform}-${process.arch});目前有 Windows 和 Linux 的 x64`);
  const file = path.join(homeDir(), CORE_RELEASE.version, build.file);
  if (verifiedExe === file && fs.existsSync(file)) return file;
  if (fs.existsSync(file) && sha256Hex(fs.readFileSync(file)) === build.sha256) {
    verifiedExe = file;
    return file;
  }
  const buf = await download(`${CORE_RELEASE.version}/${build.dir}/${build.file}`);
  if (buf.length !== build.size || sha256Hex(buf) !== build.sha256) {
    throw new Error(`下载到的浏览器核心校验不过(大小 ${buf.length},应为 ${build.size}),没有安装;稍后再试`);
  }
  placeFile(file, buf);
  if (process.platform !== 'win32') fs.chmodSync(file, 0o755);
  console.log(`[core-install] 浏览器核心 ${CORE_RELEASE.version} 已装到 ${file}`);
  verifiedExe = file;
  return file;
}

async function ensureGrant(refresh: boolean): Promise<string> {
  const fromEnv = process.env['POWERBROWSER_CORE_GRANT']?.trim();
  if (fromEnv) {
    if (!fs.existsSync(fromEnv)) throw new Error(`POWERBROWSER_CORE_GRANT 指的授权文件不存在:${fromEnv}`);
    return fromEnv;
  }
  const file = path.join(homeDir(), GRANT_NAME);
  if (!refresh && fs.existsSync(file)) return file;
  const buf = await download(`grants/${GRANT_NAME}`);
  if (!looksLikeGrant(buf.toString('utf8'))) throw new Error('下载到的浏览器核心授权文件格式不对,没有保存;请联系管理员');
  placeFile(file, buf);
  return file;
}

/** 核心程序和授权文件都就位(缺了就下载);refreshGrant = 授权过期后重新取一次 */
export async function ensureCore(opts: { refreshGrant?: boolean } = {}): Promise<CoreFiles> {
  const [exe, grant] = await Promise.all([ensureExe(), ensureGrant(opts.refreshGrant === true)]);
  return { exe, grant };
}

/** 授权文件是不是我们自己管的(环境变量指定的不替人换) */
export const grantIsManaged = (): boolean => !process.env['POWERBROWSER_CORE_GRANT']?.trim();
