/**
 * 工位虚拟屏分辨率(托管模式):校验、查询、切换、记住。
 *
 * 背景(2026-10-16 在 ai-desk 实测):
 * - Xvfb 的 RandR 上限 = 启动时 -screen 给的大小,所以 Xvfb 一律按最大的 3840x2160 起,再切到工位配置的分辨率;
 * - 只用 `xrandr --fb` 改根窗口时输出(CRTC)会被关掉,Chromium 看不到显示器、最大化的窗口不跟着变;
 *   正经做法是给输出加上每种分辨率的模式(名字 desk-<宽>x<高>,刷新率按 60Hz 算 —— Chromium 按显示器刷新率排帧),
 *   再 `xrandr --output <输出> --mode desk-WxH`:openbox 会把最大化的窗口跟着撑满新屏幕;
 * - 加模式 / 切模式失败时退回 `--fb`(至少根窗口对,Selkies 按根窗口采集);
 * - Xvfb 必须带 -noreset:不带时最后一个客户端断开 X 就整个重置(用户加的模式、切过的分辨率全丢)——
 *   Xvfb 单元启动时还没有别的客户端,每个 xrandr 进程一退出改动就没了(实测 newmode 返回 0 但模式不存在)。
 *
 * 本文件不 import config.ts:Xvfb 单元启动时也用它(display-cli.ts),那里没有令牌,config.ts 会拒绝加载。
 * 外部命令一律 execFile(不经 shell)、带超时,由调用方注入,单测里换成假的。
 */
import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';

export interface Resolution {
  width: number;
  height: number;
}

/** 允许的分辨率(面板下拉就是这几个);默认 1920x1080 */
export const ALLOWED_RESOLUTIONS: readonly Resolution[] = Object.freeze([
  { width: 1280, height: 720 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
]);
export const DEFAULT_RESOLUTION: Resolution = Object.freeze({ width: 1920, height: 1080 });
/** Xvfb 启动大小 = RandR 上限,必须是允许列表里最大的那个 */
export const MAX_RESOLUTION: Resolution = Object.freeze({ width: 3840, height: 2160 });

export function formatResolution(r: Resolution): string {
  return `${r.width}x${r.height}`;
}

export function isAllowedResolution(r: Resolution): boolean {
  return ALLOWED_RESOLUTIONS.some((a) => a.width === r.width && a.height === r.height);
}

/** "1920x1080" → 对象;格式不对或不在允许列表里 → null */
export function parseResolution(text: string | null | undefined): Resolution | null {
  const m = /^\s*(\d{3,4})x(\d{3,4})\s*$/.exec(text ?? '');
  if (!m?.[1] || !m[2]) return null;
  const r = { width: Number(m[1]), height: Number(m[2]) };
  return isAllowedResolution(r) ? r : null;
}

/** `xrandr --current` 第一行的 "current 1920 x 1080" */
export function parseXrandrCurrent(stdout: string): Resolution | null {
  const m = /current\s+(\d+)\s*x\s*(\d+)/.exec(stdout);
  if (!m?.[1] || !m[2]) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

export interface XrandrOutputs {
  /** 第一个 connected 的输出名(Xvfb 上叫 screen);没有 = null */
  output: string | null;
  /** 该输出已有的模式名 */
  modes: Set<string>;
}

/** 解析 `xrandr --current`:找第一个 connected 输出,收集它下面缩进行里的模式名 */
export function parseXrandrOutputs(stdout: string): XrandrOutputs {
  let output: string | null = null;
  const modes = new Set<string>();
  for (const line of stdout.split('\n')) {
    if (output === null) {
      const m = /^(\S+)\s+connected\b/.exec(line);
      if (m?.[1]) output = m[1];
      continue;
    }
    if (!/^\s/.test(line)) break; // 下一个输出 / 段落开始
    const mode = /^\s+(\S+)/.exec(line)?.[1];
    if (mode) modes.add(mode);
  }
  return { output, modes };
}

export function modeName(r: Resolution): string {
  return `desk-${formatResolution(r)}`;
}

/**
 * `xrandr --newmode` 的参数。Xvfb 不管时序,但 RandR 按「像素时钟 / (水平总数 × 垂直总数)」算刷新率,
 * Chromium 又按它排帧 —— 时钟乱给(比如 60MHz)4K 只有 7Hz,页面动画会卡。按 60Hz 算:时钟 = 宽 × 高 × 60 / 1e6 MHz。
 */
export function newModeArgs(r: Resolution): string[] {
  const clock = ((r.width * r.height * 60) / 1e6).toFixed(3);
  const w = String(r.width);
  const h = String(r.height);
  return ['--newmode', modeName(r), clock, w, w, w, w, h, h, h, h];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}
/** 跑外部命令(不经 shell);非零退出码要 reject */
export type Exec = (file: string, args: readonly string[], timeoutMs: number) => Promise<ExecResult>;

/** 真正的 Exec:execFile,不经 shell,超时即杀 */
export const execBin: Exec = (file, args, timeoutMs) => new Promise((resolve, reject) => {
  execFile(file, [...args], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout, stderr) => {
    if (err) reject(new Error(`${file} ${args.join(' ')} 失败:${stderr.trim() || err.message}`));
    else resolve({ stdout, stderr });
  });
});

const XRANDR_TIMEOUT_MS = 5_000;

export interface DeskDisplayOptions {
  exec: Exec;
  /** 记住分辨率的文件(工位数据目录里);null = 不记 */
  stateFile: string | null;
  /** 空闲壁纸;切完分辨率用 feh 重铺(根窗口背景图不会自己拉伸)。null = 不铺 */
  wallpaper: string | null;
}

/** 一块 X 屏:查当前大小、切换、记住选择。DISPLAY / XAUTHORITY 从进程环境继承 */
export class DeskDisplay {
  constructor(private readonly opts: DeskDisplayOptions) {}

  private xrandr(args: readonly string[]): Promise<ExecResult> {
    return this.opts.exec('xrandr', args, XRANDR_TIMEOUT_MS);
  }

  async current(): Promise<Resolution> {
    const r = parseXrandrCurrent((await this.xrandr(['--current'])).stdout);
    if (!r) throw new Error('xrandr 输出里找不到当前分辨率');
    return r;
  }

  /** 切到 r 并核对;返回切完后的实际大小。r 必须已校验过(在允许列表里) */
  async apply(r: Resolution): Promise<Resolution> {
    if (!isAllowedResolution(r)) throw new Error(`分辨率 ${formatResolution(r)} 不在允许列表里`);
    // 不带 --current:完整探测一次,刚起的 X 上已加的模式也列得出来
    const { output, modes } = parseXrandrOutputs((await this.xrandr([])).stdout);
    let switched = false;
    if (output) {
      try {
        if (!modes.has(modeName(r))) {
          // 别的进程可能刚加过同名模式(BadName):忽略,下面 --addmode 照样能用
          await this.xrandr(newModeArgs(r)).catch(() => undefined);
          await this.xrandr(['--addmode', output, modeName(r)]);
        }
        await this.xrandr(['--output', output, '--mode', modeName(r)]);
        switched = true;
      } catch (e) {
        console.error(`[desk-display] 切模式失败,退回 --fb:${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // 退路:只改根窗口(Xvfb 会报 "not large enough for output" 的 BadValue,但根窗口确实变了,以核对结果为准)
    if (!switched) await this.xrandr(['--fb', formatResolution(r)]).catch(() => undefined);
    const now = await this.current();
    if (now.width !== r.width || now.height !== r.height) {
      throw new Error(`切换后屏幕是 ${formatResolution(now)},不是要的 ${formatResolution(r)}`);
    }
    return now;
  }

  /** 读记住的分辨率;没有 / 读不到 / 不合法 → null */
  async readSaved(): Promise<Resolution | null> {
    if (!this.opts.stateFile) return null;
    try {
      return parseResolution(await readFile(this.opts.stateFile, 'utf8'));
    } catch {
      return null;
    }
  }

  /** 原子写(先写临时文件再改名),重启后 display-cli 按它恢复 */
  async save(r: Resolution): Promise<void> {
    const file = this.opts.stateFile;
    if (!file) return;
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, `${formatResolution(r)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  /** 重铺空闲壁纸;失败不要紧(只影响没有浏览器窗口时的背景) */
  async refreshWallpaper(): Promise<boolean> {
    if (!this.opts.wallpaper) return false;
    try {
      await this.opts.exec('feh', ['--no-fehbg', '--bg-fill', this.opts.wallpaper], XRANDR_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }
}

/** 启动时用哪个分辨率:记住的 > DESK_RESOLUTION > 默认 1920x1080(不合法的一律跳过) */
export function pickStartupResolution(saved: Resolution | null, envValue: string | undefined): Resolution {
  return saved ?? parseResolution(envValue) ?? DEFAULT_RESOLUTION;
}
