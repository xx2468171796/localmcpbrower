/**
 * 管理接口 /admin/display 背后的流程:查当前分辨率、改分辨率(串行)。
 *
 * 改分辨率 = xrandr 切模式并核对 → 记到工位数据目录(重启后 display-cli 按它恢复)→ 重铺壁纸 →
 * 浏览器窗口设回最大化 → 让本工位的 Selkies 重启(它只在连接建立时读一次屏幕大小,而且只看连接会一直沿用
 * 第一个连接时的大小,不重启就一直是旧尺寸;重启靠 polkit 规则只许 desk-<id> 重启自己的 desk-selkies@<id>)→
 * 时间线记一条 display 事件。
 * 只有「切换」失败算失败;记住 / 壁纸 / 窗口 / 画面重启各自失败只在返回里标出来。
 */
import type { ToolEventInput } from './events.js';
import { ALLOWED_RESOLUTIONS, formatResolution, type Resolution } from './display.js';

export interface DisplayDriver {
  current(): Promise<Resolution>;
  apply(r: Resolution): Promise<Resolution>;
  save(r: Resolution): Promise<void>;
  refreshWallpaper(): Promise<boolean>;
}

export interface DisplayInfo {
  width: number;
  height: number;
  allowed: Resolution[];
}

/** stream:restarting = 已让 Selkies 重启(画面会断开几秒后要重连);unchanged = 分辨率没变没动它;restart_failed = 没能重启(要人重连 / deskctl 处理) */
export type StreamAction = 'restarting' | 'unchanged' | 'restart_failed';

export interface DisplaySetResult extends DisplayInfo {
  changed: boolean;
  previous: Resolution;
  saved: boolean;
  windows: number;
  stream: StreamAction;
}

export interface DisplayPort {
  info(): Promise<DisplayInfo>;
  set(r: Resolution): Promise<DisplaySetResult>;
}

export interface DisplayControlDeps {
  driver: DisplayDriver;
  /** 把浏览器窗口设回最大化,返回处理的窗口数 */
  fitWindows: () => Promise<number>;
  /** 让画面服务重启;null = 不支持(本机单用) */
  restartStream: (() => Promise<void>) | null;
  push: (e: ToolEventInput) => void;
  now?: () => number;
}

/** /admin/state 每秒被面板轮询:当前分辨率缓存这么久,不每次都起 xrandr 进程 */
const INFO_TTL_MS = 5_000;

export class DisplayControl implements DisplayPort {
  private queue: Promise<unknown> = Promise.resolve();
  private last: { r: Resolution; at: number } | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: DisplayControlDeps) {
    this.now = deps.now ?? Date.now;
  }

  private infoOf(r: Resolution): DisplayInfo {
    return { width: r.width, height: r.height, allowed: ALLOWED_RESOLUTIONS.map((a) => ({ ...a })) };
  }

  async info(): Promise<DisplayInfo> {
    const last = this.last;
    if (last && this.now() - last.at < INFO_TTL_MS) return this.infoOf(last.r);
    const r = await this.deps.driver.current();
    this.last = { r, at: this.now() };
    return this.infoOf(r);
  }

  /** 串行执行:两个人同时点,后一个等前一个切完 */
  set(r: Resolution): Promise<DisplaySetResult> {
    const run = this.queue.then(() => this.doSet(r), () => this.doSet(r));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async doSet(r: Resolution): Promise<DisplaySetResult> {
    const { driver } = this.deps;
    const previous = await driver.current();
    const changed = previous.width !== r.width || previous.height !== r.height;
    const now = changed ? await driver.apply(r) : previous;
    this.last = { r: now, at: this.now() };
    const saved = await driver.save(now).then(() => true, (e: unknown) => {
      console.error(`[Desk] 记住分辨率失败:${e instanceof Error ? e.message : String(e)}`);
      return false;
    });
    if (!changed) return { ...this.infoOf(now), changed, previous, saved, windows: 0, stream: 'unchanged' };
    await driver.refreshWallpaper();
    const windows = await this.deps.fitWindows().catch(() => 0);
    const stream = await this.restartStream();
    this.deps.push({ kind: 'display', detail: `${formatResolution(previous)} → ${formatResolution(now)}` });
    return { ...this.infoOf(now), changed, previous, saved, windows, stream };
  }

  private async restartStream(): Promise<StreamAction> {
    if (!this.deps.restartStream) return 'restart_failed';
    try {
      await this.deps.restartStream();
      return 'restarting';
    } catch (e) {
      console.error(`[Desk] 重启画面服务失败(要装 polkit 规则 50-ai-desk.rules):${e instanceof Error ? e.message : String(e)}`);
      return 'restart_failed';
    }
  }
}
