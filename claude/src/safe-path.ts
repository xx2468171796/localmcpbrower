/**
 * 文件路径收口:截图 / PDF 只往允许的目录里写,file_upload 只读允许目录里的文件。
 *
 * 为什么要有:工具参数来自 AI,而 AI 读的网页内容可能含提示注入。以前
 *   - pdf_export 收绝对路径,能把文件写到磁盘任何地方(覆盖 ~/.bashrc 之类);
 *   - take_screenshot 的 name 能带 ../ 跳出截图目录;
 *   - file_upload 能把本机任意文件(密钥、配置)传给网页。
 *
 * 规则(托管 = 设了 DESK_ID;严格 = 托管或 STRICT_PATHS=1):
 *   - 截图 name 只许是单纯的文件名(不含路径分隔符、..、盘符冒号、控制字符)。
 *   - PDF 相对路径一律落在 PDF_DIR 里,../ 跳出去就拒;绝对路径在允许的输出目录里放行,
 *     不在时:严格模式拒绝,本机模式照旧放行(本机是业主自己的电脑,考卷 file.pdf-export 也靠它)。
 *     无论哪种模式,扩展名都必须是 .pdf(没有就补上),不能拿来覆盖别的文件类型。
 *   - 上传:允许目录 = 数据目录 uploads/、截图、PDF、下载目录 + UPLOAD_ALLOW_DIRS(按系统路径分隔符分开)。
 *     UPLOAD_ALLOW_DIRS 没设且不是严格模式 → 不限制(本机老行为,考卷 file.upload 的文件在临时目录)。
 *   - 判断一律先 realpath(防符号链接 / 目录联接跳出),Windows 上不分大小写、认盘符。
 *
 * 本文件只放纯函数(根目录由调用方传入),不 import paths.ts —— 单测可以直接跑,不碰真数据目录。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from './errors.js';

export type Platform = 'win32' | 'posix';

export interface PathEnv {
  platform: Platform;
  /** 把路径解析成真实路径(跟随符号链接);不存在的部分原样拼回。单测可替换 */
  realpath: (p: string) => string;
}

export function currentPlatform(): Platform {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

const pathOf = (platform: Platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * 「宽松」realpath:路径不存在时,找到最近一个存在的上级目录取真实路径,再把剩下的段拼回去。
 * 要写的新文件本身还不存在,但它的上级目录可能是指向别处的链接 —— 必须按上级的真实位置判断。
 */
export function realpathLoose(p: string): string {
  const abs = path.resolve(p);
  let cur = abs;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(cur);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function defaultPathEnv(): PathEnv {
  return { platform: currentPlatform(), realpath: realpathLoose };
}

/** 比较用的规范形:绝对化、去掉末尾分隔符;Windows 上统一小写、分隔符统一成 \ */
export function normalizeForCompare(p: string, platform: Platform): string {
  const P = pathOf(platform);
  let n = P.resolve(p);
  if (platform === 'win32') n = n.replace(/\//g, '\\').toLowerCase();
  if (n.length > 1 && (n.endsWith('\\') || n.endsWith('/')) && !/^[a-z]:\\$/i.test(n)) n = n.slice(0, -1);
  return n;
}

/** child 是否在 root 里面(含 root 本身);两者都应是已经 realpath 过的绝对路径 */
export function isInside(child: string, root: string, platform: Platform): boolean {
  const P = pathOf(platform);
  const c = normalizeForCompare(child, platform);
  const r = normalizeForCompare(root, platform);
  if (c === r) return true;
  const rel = P.relative(r, c);
  return rel !== '' && !rel.startsWith('..') && !P.isAbsolute(rel);
}

function denied(message: string): ToolError {
  return new ToolError('PATH_DENIED', message);
}

/**
 * 截图名之类「只该是一个文件名」的参数:拒绝路径分隔符、..、冒号(盘符 / NTFS 备用流)、控制字符。
 * 返回原名(去掉首尾空白)。
 */
export function safeFileName(name: string): string {
  const n = name.trim();
  if (!n) throw denied('文件名不能为空');
  if (n.length > 200) throw denied('文件名太长(最多 200 个字符)');
  // eslint-disable-next-line no-control-regex
  if (/[\\/:\x00-\x1f]/.test(n) || n === '.' || n === '..' || n.includes('..')) {
    throw denied(`文件名不允许含路径:${JSON.stringify(n)}。只给文件名即可(如 "home-page"),文件固定存到截图目录`);
  }
  return n;
}

/** 按系统路径分隔符拆开环境变量里的目录列表,去空、转绝对路径 */
export function parseRootList(value: string | undefined, platform: Platform = currentPlatform()): string[] {
  if (!value) return [];
  const P = pathOf(platform);
  return value.split(P.delimiter).map((s) => s.trim()).filter(Boolean).map((s) => P.resolve(s));
}

export interface WritePolicy {
  /** 相对路径的落点 */
  baseDir: string;
  /** 绝对路径允许落进的目录(baseDir 自动算在内) */
  allowRoots: string[];
  /** 严格模式:绝对路径不在 allowRoots 里就拒绝;否则放行(本机老行为) */
  strict: boolean;
  /** 强制的扩展名(含点,如 ".pdf"):不是这个扩展名就补上 */
  extension?: string;
}

/**
 * 解析一个要写入的文件路径,越界抛 PATH_DENIED。返回最终要写的绝对路径。
 * 相对路径永远不许跳出 baseDir(不论模式):"a/../../x" 这类写法几乎都是越界企图。
 */
export function resolveWritePath(requested: string, policy: WritePolicy, env: PathEnv = defaultPathEnv()): string {
  const P = pathOf(env.platform);
  const raw = requested.trim();
  if (!raw) throw denied('路径不能为空');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(raw)) throw denied('路径里不能有控制字符');
  let target = P.isAbsolute(raw) ? P.resolve(raw) : P.resolve(policy.baseDir, raw);
  if (policy.extension && P.extname(target).toLowerCase() !== policy.extension) target += policy.extension;

  const real = env.realpath(target);
  const roots = [policy.baseDir, ...policy.allowRoots].map((r) => env.realpath(r));
  const inside = roots.some((r) => isInside(real, r, env.platform));
  if (!P.isAbsolute(raw)) {
    if (!isInside(real, env.realpath(policy.baseDir), env.platform)) {
      throw denied(`相对路径跳出了输出目录:${raw}。相对路径只能落在 ${policy.baseDir} 里`);
    }
    return target;
  }
  if (!inside && policy.strict) {
    throw denied(`不允许写到这个位置:${target}。只能写进 ${roots.join(' / ')}(或给相对路径)`);
  }
  return target;
}

export interface ReadPolicy {
  /** null = 不限制(本机老行为) */
  allowRoots: string[] | null;
}

/**
 * 上传前核对要读的本地文件:必须存在、是普通文件,且(有白名单时)真实路径在白名单目录里。
 * 返回真实路径(之后就用它,防止核对完到真正读之间被换成链接)。
 */
export function resolveReadPath(requested: string, policy: ReadPolicy, env: PathEnv = defaultPathEnv(),
  stat: (p: string) => { isFile(): boolean } | null = statOrNull): string {
  const P = pathOf(env.platform);
  const raw = requested.trim();
  if (!raw) throw denied('文件路径不能为空');
  if (!P.isAbsolute(raw)) throw denied(`要给本地文件的绝对路径:${raw}`);
  const real = env.realpath(P.resolve(raw));
  if (policy.allowRoots) {
    const roots = policy.allowRoots.map((r) => env.realpath(r));
    if (!roots.some((r) => isInside(real, r, env.platform))) {
      throw denied(`不允许上传这个位置的文件:${raw}。允许的目录:${roots.join(' / ')}`
        + '(把文件放进其中之一,或由管理员在 UPLOAD_ALLOW_DIRS 里加目录)');
    }
  }
  const st = stat(real);
  if (!st) throw new ToolError('INVALID_ARGS', `文件不存在:${raw}`);
  if (!st.isFile()) throw new ToolError('INVALID_ARGS', `不是普通文件:${raw}`);
  return real;
}

function statOrNull(p: string): fs.Stats | null {
  try { return fs.statSync(p); } catch { return null; }
}

/** 托管模式(工位)或显式 STRICT_PATHS=1 时走严格规则 */
export function isStrictPaths(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env['DESK_ID'] || env['STRICT_PATHS'] === '1';
}

/**
 * 上传白名单。UPLOAD_ALLOW_DIRS 没设且不是严格模式 → null(不限制,本机老行为)。
 * builtin = 数据目录 uploads/、截图、PDF、下载目录。
 */
export function uploadAllowRoots(builtin: string[], env: NodeJS.ProcessEnv = process.env,
  platform: Platform = currentPlatform()): string[] | null {
  const extra = parseRootList(env['UPLOAD_ALLOW_DIRS'], platform);
  if (!extra.length && !isStrictPaths(env)) return null;
  return [...builtin, ...extra];
}
