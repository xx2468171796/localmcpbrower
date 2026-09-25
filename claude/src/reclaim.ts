/**
 * 回收「没人管」的资源,防止项目多、时间久以后内存和磁盘被慢慢吃满:
 *   1. 孤儿浏览器:服务崩溃 / 被强杀 / 机器休眠后,它开的 Chromium 不会跟着退出(Windows 上尤其如此),
 *      一直占着几百 MB。服务启动时找出「用的是本服务 profile、但父进程已经不在(或不是 node)」的浏览器,整棵杀掉。
 *      父进程还活着的不碰 —— 那可能是别的窗口正在用的直连模式服务。
 *   2. 磁盘:14 天没用的工作区 profile 目录、7 天前的截图,删掉。
 * 都是尽力而为:任何一步失败只记日志,不影响服务启动。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const IS_WIN = process.platform === 'win32';

interface Proc { pid: number; ppid: number; name: string; cmd: string }

async function listProcesses(): Promise<Proc[]> {
  if (IS_WIN) {
    const ps =
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
    });
    const rows = JSON.parse(stdout) as Array<{ ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null }>;
    return rows.map((r) => ({ pid: r.ProcessId, ppid: r.ParentProcessId, name: r.Name ?? '', cmd: r.CommandLine ?? '' }));
  }
  const { stdout } = await run('ps', ['-eo', 'pid=,ppid=,comm=,args='], { timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
  return stdout.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), name: m[3]!, cmd: m[4]! }] : [];
  });
}

/** 命令行里的 --user-data-dir,规范化成可比较的形式 */
function userDataDirOf(cmd: string): string | null {
  const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(cmd);
  return m ? norm(m[1] ?? m[2]!) : null;
}
const norm = (p: string) => {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return IS_WIN ? r.toLowerCase() : r;
};

/**
 * 杀掉本服务 profile(userDataDir 本身和它的 -spaces/ 子目录)上的孤儿浏览器。
 * 返回杀掉的浏览器主进程 pid。
 */
export async function killOrphanBrowsers(userDataDir: string): Promise<number[]> {
  const base = norm(userDataDir);
  const spaces = norm(`${userDataDir}-spaces`) + path.sep;
  const procs = await listProcesses();
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const ours = (dir: string | null) => dir !== null && (dir === base || (dir + path.sep).startsWith(IS_WIN ? spaces.toLowerCase() : spaces));
  const orphans = procs.filter((p) => {
    // 只看浏览器主进程:子进程带 --type=;崩溃上报进程(chrome_crashpad_handler)也带 profile 参数但不带 --type,单独排除
    if (!/chrom/i.test(p.name) || /--type=/.test(p.cmd) || /crashpad/i.test(p.name + ' ' + p.cmd.split(' ')[0])) return false;
    if (!ours(userDataDirOf(p.cmd))) return false;
    const parent = byPid.get(p.ppid);
    if (parent && /chrom/i.test(parent.name)) return false; // 父进程是浏览器自己 → 它是某个浏览器的下属,不是根
    // 看完整命令行而不是进程名:Linux 上 Node 24 会把主线程改名成 MainThread,进程名里没有 node
    // (debian12test 实测)。只看名字会把别的窗口正在用的浏览器当孤儿杀掉。
    return !parent || !/node/i.test(`${parent.name} ${parent.cmd}`);
  });
  for (const o of orphans) {
    try {
      if (IS_WIN) {
        await run('taskkill', ['/PID', String(o.pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 });
      } else {
        // 连同它的子进程(渲染、GPU 等)一起杀
        for (const c of procs) if (c.ppid === o.pid) { try { process.kill(c.pid, 'SIGKILL'); } catch { /* 已退出 */ } }
        process.kill(o.pid, 'SIGKILL');
      }
    } catch { /* 可能刚好自己退出了 */ }
  }
  if (orphans.length) {
    console.log(`[Reclaim] 清理了 ${orphans.length} 个孤儿浏览器(上次服务异常退出留下的):pid ${orphans.map((o) => o.pid).join(', ')}`);
  }
  return orphans.map((o) => o.pid);
}

/** 最近一次被用到的时间:目录本身和 Chromium 关闭时会写的 Local State 取较新的 */
function lastTouched(dir: string): number {
  let t = 0;
  for (const f of [dir, path.join(dir, 'Local State'), path.join(dir, 'Default', 'Preferences')]) {
    try { t = Math.max(t, fs.statSync(f).mtimeMs); } catch { /* 没有这个文件 */ }
  }
  return t;
}

/**
 * 删掉久未使用的工作区 profile 和旧截图。inUse 里的工作区(当前开着的)不动。
 * 返回删掉的工作区名和截图数。
 */
export function cleanDisk(opts: {
  userDataDir: string; screenshotDir: string; inUse: Set<string>; spaceDays?: number; screenshotDays?: number;
}): { spaces: string[]; screenshots: number } {
  const now = Date.now();
  const spaceMs = (opts.spaceDays ?? Number(process.env['SPACE_KEEP_DAYS'] ?? 14)) * 86_400_000;
  const shotMs = (opts.screenshotDays ?? Number(process.env['SCREENSHOT_KEEP_DAYS'] ?? 7)) * 86_400_000;
  const removed: string[] = [];
  const spacesDir = `${opts.userDataDir}-spaces`;
  for (const name of safeList(spacesDir)) {
    const dir = path.join(spacesDir, name);
    if (opts.inUse.has(name) || now - lastTouched(dir) < spaceMs) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); removed.push(name); } catch { /* 被占用就下次再删 */ }
  }
  let shots = 0;
  for (const name of safeList(opts.screenshotDir)) {
    const f = path.join(opts.screenshotDir, name);
    try {
      const st = fs.statSync(f);
      if (st.isFile() && now - st.mtimeMs > shotMs) { fs.rmSync(f, { force: true }); shots++; }
    } catch { /* 已删 */ }
  }
  if (removed.length || shots) {
    console.log(`[Reclaim] 清理磁盘:${removed.length ? `久未使用的工作区 ${removed.join('、')};` : ''}${shots ? `旧截图 ${shots} 张` : ''}`);
  }
  return { spaces: removed, screenshots: shots };
}

function safeList(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}
