/**
 * 浏览器 MCP 往磁盘写的东西(profile、工作区、截图、PDF、浏览器和 patchright 的临时文件)都从这里取位置。
 * 项目多、时间久以后这些东西会越来越大,放错地方会把盘撑满:
 *   - Windows:不放系统盘 C:。装在别的盘就用安装目录下的 storage/;装在 C: 就挑剩余空间最大的本地非系统盘,
 *     建 <盘>:\localmcp-data。只有 C: 一个盘才留在 C:。
 *   - Linux / macOS:安装目录下的 storage/(在家目录里)。临时文件也进 storage/tmp,不进 /tmp ——
 *     /tmp 常是只有几 GB 的内存盘,撑满了整台机器都会出问题。
 *   - 设了 LOCALMCP_DATA_DIR 就以它为准。
 * 选中的位置记在 <安装目录>/storage/data-root.txt,以后每次启动都用同一个:
 * 不能因为哪天别的盘空了就换地方,换了登录态就丢了。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = process.platform === 'win32';

/** 服务安装根目录(dist/ 的上一级) */
export const INSTALL_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
/** 老版本的固定位置:安装目录下的 storage/(LOCALMCP_LEGACY_DIR 只给测试用,免得碰真数据) */
const LEGACY_ROOT = path.resolve(process.env['LOCALMCP_LEGACY_DIR'] ?? path.join(INSTALL_ROOT, 'storage'));
/** 本进程改临时目录之前的系统临时目录:unix socket 要放在 shim 也能找到的地方(见 pipe.ts) */
export const SYSTEM_TMP = os.tmpdir();

export const DATA_ROOT = resolveDataRoot();
export const SCREENSHOT_DIR = path.resolve(process.env['SCREENSHOT_DIR'] ?? path.join(DATA_ROOT, 'screenshots'));
/** pdf_export 给的是相对路径时放这里 */
export const PDF_DIR = path.join(DATA_ROOT, 'pdf');

function resolveDataRoot(): string {
  const explicit = process.env['LOCALMCP_DATA_DIR'];
  if (explicit) return path.resolve(explicit);
  const marker = path.join(LEGACY_ROOT, 'data-root.txt');
  try {
    const saved = fs.readFileSync(marker, 'utf8').trim();
    if (saved) return saved;
  } catch { /* 第一次启动 */ }
  let root = LEGACY_ROOT;
  if (IS_WIN && driveOf(INSTALL_ROOT) === driveOf(process.env['SystemDrive'] ?? 'C:')) {
    const drive = pickDataDrive();
    if (drive) root = `${drive}\\localmcp-data`;
  }
  try {
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(LEGACY_ROOT, { recursive: true });
    fs.writeFileSync(marker, root);
  } catch {
    root = LEGACY_ROOT; // 选中的盘写不进去就留在原处
  }
  return root;
}

function driveOf(p: string): string {
  return path.resolve(p).slice(0, 2).toUpperCase();
}

/** 剩余空间最大的本地非系统盘(至少 5GB 空闲);没有返回 null */
function pickDataDrive(): string | null {
  try {
    const ps = "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID,FreeSpace | ConvertTo-Json -Compress";
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    const parsed = JSON.parse(out) as { DeviceID: string; FreeSpace: number } | Array<{ DeviceID: string; FreeSpace: number }>;
    const system = driveOf(process.env['SystemDrive'] ?? 'C:');
    const best = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((d) => d.DeviceID.toUpperCase() !== system && d.FreeSpace >= 5 * 1024 ** 3)
      .sort((a, b) => b.FreeSpace - a.FreeSpace)[0];
    return best ? best.DeviceID.toUpperCase() : null;
  } catch {
    return null;
  }
}

function isUnder(p: string, dir: string): boolean {
  const rel = path.relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 某个服务的 profile 目录。USER_DATA_DIR 没设,或设的是老默认位置(安装目录 storage/ 下,
 * PM2 配置和 .env.example 里都这么写)→ 同名目录放进 DATA_ROOT;设成别处(测试的临时目录等)原样用。
 */
export function profileDir(configured: string | undefined): string {
  const p = configured ? path.resolve(INSTALL_ROOT, configured) : path.join(LEGACY_ROOT, 'user_data');
  return isUnder(p, LEGACY_ROOT) ? path.join(DATA_ROOT, path.relative(LEGACY_ROOT, p)) : p;
}

/** target 在老位置的对应目录,且还需要搬(老的在、新的还没有);不用搬返回 null */
export function legacyOf(target: string): string | null {
  if (!isUnder(target, DATA_ROOT) || path.resolve(DATA_ROOT) === path.resolve(LEGACY_ROOT)) return null;
  const legacy = path.join(LEGACY_ROOT, path.relative(DATA_ROOT, target));
  return fs.existsSync(legacy) && !fs.existsSync(target) ? legacy : null;
}

/**
 * 老位置的目录搬到 DATA_ROOT 下的同名位置(登录态跟着走)。返回该用的目录:
 * 搬好了、或本来就不用搬 → target;搬不动(文件被占用等)→ 继续用老位置,下次启动再搬。
 * 跨盘不能改名,就先复制到 <target>.moving 再改名,中途失败不会留下半个 profile。
 */
export function adoptLegacy(target: string): string {
  const legacy = legacyOf(target);
  if (!legacy) return target;
  const partial = `${target}.moving`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.renameSync(legacy, target);
    } catch {
      fs.rmSync(partial, { recursive: true, force: true });
      fs.cpSync(legacy, partial, { recursive: true });
      fs.renameSync(partial, target);
      try { fs.rmSync(legacy, { recursive: true, force: true }); } catch (e) {
        console.error(`[Storage] 已复制到 ${target},但老目录没删干净(下次手动删):${legacy} — ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    console.error(`[Storage] 已搬家:${legacy} → ${target}`);
    return target;
  } catch (e) {
    try { fs.rmSync(partial, { recursive: true, force: true }); } catch { /* 下次再清 */ }
    console.error(`[Storage] 搬家失败,这次继续用老位置 ${legacy}:${e instanceof Error ? e.message : String(e)}`);
    return legacy;
  }
}

/**
 * 这个服务的临时目录(按 profile 区分:有头、无头两个服务同时在跑,互不清对方的)。
 * 设进 TMPDIR / TEMP / TMP 后,Chromium 和 patchright(下载、临时 profile 等)都写到这里,不再写系统临时目录。
 */
export function useServiceTmp(userDataDir: string): string {
  const id = createHash('sha256').update(path.resolve(userDataDir)).digest('hex').slice(0, 8);
  const dir = path.join(DATA_ROOT, 'tmp', `${path.basename(userDataDir)}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env['TMPDIR'] = dir;
  process.env['TEMP'] = dir;
  process.env['TMP'] = dir;
  return dir;
}
