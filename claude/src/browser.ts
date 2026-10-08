/**
 * BrowserManager - 跨平台 Playwright 浏览器管理器(Task Spaces + 每会话独立标签页)
 * 支持 macOS / Linux (Debian/Ubuntu) / Windows 无头模式
 * Claude Code 版本
 *
 * 三层资源模型(一个 chromium 进程被所有会话共享,替代原来每个客户端窗口一份):
 *   Chromium ×1
 *   └── BrowserContext = Space   独立 userDataDir → 独立 cookie/登录态,显式 space_new 才新建
 *       ├── Page ← Session A     每个 MCP 会话自动分到自己的标签页,互不抢占
 *       └── Page ← Session B
 *
 * 两级隔离各司其职:
 *   - Session → Page:自动分配,成本极低,多窗口并行互不干扰且**共享登录态**
 *   - Space → Context:显式 space_new,成本高,用于多账号/需要隔离 cookie 的场景
 *
 * 会话隔离要点:console/network 缓冲挂在**会话级**而非 space 级 —— 否则 HTTP 多会话
 * 下 A 窗口会读到 B 窗口的日志。sessionSpace 也是每会话独立,space_switch 只影响调用方。
 *
 * 向后兼容:stdio 下 currentSessionId() 恒为 __stdio__,全服务只有一个会话,
 * 行为与改造前的「单 space 单 page」完全一致。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { cleanDisk, killOrphanBrowsers } from './reclaim.js';
import { SCREENSHOT_DIR, adoptLegacy, legacyOf, profileDir, removeLegacyLeftover, useServiceTmp } from './paths.js';
import { chromium, type BrowserContext, type Cookie, type Page, type Route } from 'patchright';
import * as path from 'path';
import * as fs from 'fs';
import type { ConsoleLogEntry, NetworkRequestEntry, BrowserConfig } from './types.js';
import { EGO_HELPER_SRC } from './injected.js';
import { MAIN_WORLD_SRC, DRAIN_SRC, buildHtmlInjector } from './inject.js';
import { currentSessionId } from './context.js';
import { killProcessTreeSync } from './portkill.js';

const IS_LINUX = process.platform === 'linux';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// Chrome 版本号 token，统一用于各平台 UA 字符串
// patchright 1.60 捆绑 Chrome for Testing 148，UA 需与真实内核版本一致，否则指纹自相矛盾
const CHROME_VERSION = process.env['UA_CHROME_VERSION'] ?? '148.0.0.0';

const DEFAULT_SPACE = 'default';

/**
 * 这台机能不能弹出可见窗口;不能就返回原因(给人看的中文),能就返回 null。
 * 只有 Linux 能可靠判断(没有 DISPLAY / WAYLAND_DISPLAY 就没有图形会话)。
 * Windows / macOS 恒有显示服务;但服务若被装成 Windows 系统服务(Session 0),窗口照样看不见 ——
 * 那属于装错了(README 里禁止),这里查不出来。
 */
function noDisplayReason(): string | null {
  if (IS_LINUX && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY']) {
    return '这台 Linux 没有图形界面(未检测到 DISPLAY / WAYLAND_DISPLAY),弹不出可见窗口;需要人工处理请配 Xvfb + VNC 或换桌面机';
  }
  return null;
}

/** 换形态后重开网址的超时;页面慢也不能把等人工的调用卡死 */
const RESTORE_NAV_TIMEOUT_MS = 30_000;

/**
 * 服务安装根目录(dist/ 的上一级)。
 * 默认 userDataDir 必须相对**安装目录**解析而不是 process.cwd():
 * 按 CWD 解析会导致每个项目目录各落一份 profile —— 登录态不共享、storage/ 散落各处。
 * 跨平台一律走 path 模块,不假设分隔符。
 */
const DEFAULT_CONFIG: BrowserConfig = {
  // headless 默认开启；Mac 调试时设 HEADLESS=false
  headless: process.env['HEADLESS'] !== 'false',
  // 落在哪个盘 / 目录见 paths.ts(Windows 不放 C:,Linux 不放 /tmp)
  userDataDir: profileDir(process.env['USER_DATA_DIR']),
  viewportWidth: parseInt(process.env['VIEWPORT_WIDTH'] ?? '1280', 10),
  viewportHeight: parseInt(process.env['VIEWPORT_HEIGHT'] ?? '800', 10),
  devtools: process.env['DEVTOOLS'] === 'true',
  slowMo: parseInt(process.env['SLOW_MO'] ?? '0', 10)
};

/** 单个 MCP 会话在某个 space 内的运行态 —— 自己的标签页集合与自己的日志缓冲 */
interface SessionState {
  /** 该会话拥有的标签页(new_tab/switch_tab/close_tab 只在这个集合内操作) */
  pages: Page[];
  activeIndex: number;
  consoleLogs: ConsoleLogEntry[];
  networkRequests: NetworkRequestEntry[];
  /**
   * set_block_rules 的拦截 handler —— 挂在**本会话的每张标签页**上,而不是整个 context。
   * 挂 context 会连带影响同 space 的其它会话(A 开屏蔽图片 → B 的 take_screenshot 缺图)。
   * 存下来是为了给本会话**后开**的标签页补挂,语义与原来的 context.route 保持一致。
   */
  blockRoute: ((route: Route) => void) | null;
}

/** 单个工作区(space)的运行态 —— 一个 space 一份浏览器上下文,内含多个会话 */
interface Space {
  name: string;
  userDataDir: string;
  context: BrowserContext | null;
  /** sessionId → 该会话在本 space 内的状态 */
  sessions: Map<string, SessionState>;
  listenedPages: WeakSet<Page>;
  chromiumPid: number | null;
  /** 正在启动中的 promise —— 用于合并并发启动请求,见 launchSpace */
  launching: Promise<BrowserContext> | null;
  /** 最近一次有工具调用的时间;空闲回收按它算 */
  lastUsed: number;
  /** 正在执行的工具调用数;>0 时绝不回收(等人工登录这类长调用可能跑几十分钟) */
  inflight: number;
  /**
   * 这个工作区的浏览器**现在**是不是有窗口的。
   * 以前有头 / 无头是整个服务进程一个开关(HEADLESS),桌面机只好跑两个服务、注册两个 MCP,
   * AI 分不清该用哪个。现在挂在工作区上:平时无头,要人过验证码 / 扫码时 ensureHeaded 原地换成有窗口的。
   */
  headed: boolean;
  /** 服务配置给的默认形态(HEADLESS);空闲回收、人手动关窗之后回到它 */
  baseHeaded: boolean;
}

/** ensureHeaded / ensureHeadless 的结果 */
export interface ModeSwitchResult {
  /** 切换后(或本来就)是不是有窗口 */
  headed: boolean;
  /** 这一次调用是否真的换了形态(本来就是目标形态时为 false) */
  switched: boolean;
  /** 换形态后重新打开的网址(按会话、按标签页顺序) */
  restored: string[];
  /** 没换成 / 有部分没恢复时的原因(给人看的中文) */
  reason?: string;
}

/** 换形态前记下的一个会话的标签页,换完按原顺序重开 */
interface TabMemo {
  sessionId: string;
  urls: string[];
  activeIndex: number;
}

class BrowserManager {
  private static instance: BrowserManager | null = null;
  private config: BrowserConfig;
  private spaces = new Map<string, Space>();
  /** sessionId → 该会话当前所处的 space 名(space_switch 只改这里,不再是全局状态) */
  private sessionSpace = new Map<string, string>();
  /**
   * 已回收的会话 ID(墓碑)。
   * 会话回收与在途工具调用有竞态:closeSession() 是异步的,而 SDK 关闭 transport 只 abort
   * 请求的 AbortSignal(工具函数并不检查)。一个 30s 的 navigate 若在 DELETE 之后才跑到
   * getPage(),ALS 里仍是旧 sessionId → 会**重新建出** SessionState 并再开一张标签页;
   * 此时 transports 里已无该 sid,TTL 清理和 onclose 都不会再命中它 → 页面与状态永久驻留。
   * 记墓碑后这类迟到调用直接抛错,由工具既有的 catch 转成 ToolResult 错误形状。
   */
  private retired = new Set<string>();
  /** 墓碑集合自身也要有界,超限按插入序淘汰最旧的(Set 保持插入序) */
  private static readonly RETIRED_MAX = 1000;
  /**
   * 当前这次工具调用落在哪个工作区(track 里设)。
   * ensureHeaded 要判断「除了我自己,这个工作区还有没有别的调用在跑」:
   * inflight 里本来就算着调用方自己,靠它把自己那 1 次减掉。
   */
  private callSpace = new AsyncLocalStorage<Space>();

  private constructor(config: BrowserConfig) {
    this.config = config;
    this.spaces.set(DEFAULT_SPACE, this.newSpaceState(DEFAULT_SPACE, config.userDataDir));
  }

  public static getInstance(config: BrowserConfig = DEFAULT_CONFIG): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager(config);
    }
    return BrowserManager.instance;
  }

  private newSpaceState(name: string, userDataDir: string): Space {
    return {
      name,
      userDataDir,
      context: null,
      sessions: new Map<string, SessionState>(),
      listenedPages: new WeakSet<Page>(),
      chromiumPid: null,
      launching: null,
      lastUsed: Date.now(),
      inflight: 0,
      headed: !this.config.headless,
      baseHeaded: !this.config.headless,
    };
  }

  // ============================================================
  // 空闲回收:项目多、时间久以后,AI 开了工作区(space_new)却忘了 space_close,
  // 每个工作区都是一整个浏览器进程,越积越多把内存顶爆。这里按空闲时间自动关掉浏览器,
  // 并限制同时开着的工作区浏览器数量。登录态存在 profile 目录里,下次用到自动重开(约 1–2 秒)。
  // ============================================================

  /** 包住一次工具调用:记最近使用时间、在途计数(server.ts 的 wrap 调用) */
  public async track<R>(fn: () => Promise<R>): Promise<R> {
    const sp = this.spaceFor(currentSessionId());
    sp.inflight++;
    sp.lastUsed = Date.now();
    try {
      return await this.callSpace.run(sp, fn);
    } finally {
      sp.inflight--;
      sp.lastUsed = Date.now();
    }
  }

  /**
   * 空闲多久关浏览器:其它工作区 10 分钟;默认工作区无头 30 分钟、有头 2 小时(人可能正看着)。0 = 不回收。
   * 例外:平时无头、临时为人工弹出来的窗口(wait_for_human 等)空闲 10 分钟就收掉(HEADED_IDLE_CLOSE_MIN),
   * 下次用到按默认的无头重开 —— 人处理完、AI 又忘了 hide_window 时,窗口不会在桌面上挂两个小时。
   */
  private idleLimitMs(sp: Space): number {
    const isDefault = sp.name === DEFAULT_SPACE;
    const onDemand = sp.headed && !sp.baseHeaded;
    const env = process.env[onDemand ? 'HEADED_IDLE_CLOSE_MIN' : isDefault ? 'IDLE_CLOSE_MIN' : 'SPACE_IDLE_CLOSE_MIN'];
    const min = env !== undefined && env !== '' ? Number(env) : onDemand ? 10 : isDefault ? (sp.headed ? 120 : 30) : 10;
    return Number.isFinite(min) && min > 0 ? min * 60_000 : Infinity;
  }

  /** 同时最多开着几个工作区浏览器(含默认),超出先关最久没用的空闲那个 */
  private static readonly MAX_OPEN_SPACES = Math.max(1, Number(process.env['MAX_OPEN_SPACES'] ?? 4) || 4);

  /**
   * 关掉一个工作区的浏览器(不删工作区,会话留着,下次调用自动重开)。
   * keepMode=false(默认,空闲回收 / 腾位置)时形态回到服务默认:临时弹出的窗口不会在下次重开时又冒出来。
   * 换形态(switchMode)自己管 headed,传 keepMode=true。
   */
  private async shutSpaceBrowser(sp: Space, reason: string, keepMode = false): Promise<void> {
    const ctx = sp.context;
    if (!keepMode) sp.headed = sp.baseHeaded;
    if (!ctx) return;
    console.log(`[BrowserManager] space '${sp.name}' ${reason},关闭浏览器(登录态在 profile 里,下次用到自动重开)`);
    sp.context = null;
    sp.chromiumPid = null;
    for (const st of sp.sessions.values()) {
      st.pages = [];
      st.activeIndex = 0;
    }
    try { await ctx.close(); } catch { /* 可能已经没了 */ }
  }

  /** 关掉所有空闲超时的工作区浏览器,返回关了哪些(定时器每分钟调一次) */
  public async reapIdle(now = Date.now()): Promise<string[]> {
    const closed: string[] = [];
    for (const sp of [...this.spaces.values()]) {
      if (!sp.context || sp.inflight > 0 || sp.launching) continue;
      const idle = now - sp.lastUsed;
      if (idle < this.idleLimitMs(sp)) continue;
      await this.shutSpaceBrowser(sp, `空闲 ${Math.round(idle / 60_000)} 分钟`);
      closed.push(sp.name);
    }
    return closed;
  }

  private reaper: NodeJS.Timeout | null = null;
  /** 本服务的临时目录(killOrphans 里设好);没设好就不清,绝不去清系统临时目录 */
  private tmpDir: string | null = null;
  /** 服务启动时调用:每分钟回收空闲浏览器;启动时和之后每天清一次磁盘 */
  public startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => { void this.reapIdle().catch(() => { /* 下一轮再试 */ }); }, 60_000);
    this.reaper.unref();
    const clean = () => {
      try {
        const inUse = new Set([...this.spaces.values()].filter((s) => s.context || s.launching).map((s) => s.name));
        this.removeLeftovers();
        cleanDisk({ userDataDir: path.resolve(this.config.userDataDir), screenshotDir: SCREENSHOT_DIR, inUse, ...(this.tmpDir ? { tmpDir: this.tmpDir } : {}) });
      } catch { /* 下次再清 */ }
    };
    clean();
    setInterval(clean, 24 * 3600_000).unref();
  }

  /**
   * 服务启动、开浏览器之前调用:
   *   1. 杀掉上次服务异常退出留下的孤儿浏览器(占着内存,还锁着 profile);
   *   2. profile 和工作区还在老位置(安装目录 storage/)的,搬到 paths.ts 选定的数据目录;
   *   3. 本服务的临时文件改写到数据目录下自己的 tmp,并清掉上次留下的(这时本服务还没开浏览器,不会误删)。
   */
  public async killOrphans(): Promise<number[]> {
    const target = path.resolve(this.config.userDataDir);
    const old = legacyOf(target);
    const kill = (dir: string) => killOrphanBrowsers(dir).catch((e) => {
      console.error(`[Reclaim] 扫描孤儿浏览器失败(不影响启动):${e instanceof Error ? e.message : String(e)}`);
      return [] as number[];
    });
    // 老位置上的孤儿也要先杀:它们锁着 profile,不杀搬不动
    const killed = [...(await kill(target)), ...(old ? await kill(old) : [])];
    const dir = adoptLegacy(target);
    if (dir === target) adoptLegacy(`${target}-spaces`);
    else {
      // 没搬成:这次整套(profile + 工作区)继续用老位置
      this.config.userDataDir = dir;
      const sp = this.spaces.get(DEFAULT_SPACE);
      if (sp && !sp.context && !sp.launching) sp.userDataDir = dir;
    }
    adoptLegacy(SCREENSHOT_DIR);
    this.removeLeftovers();
    try {
      const tmp = useServiceTmp(this.config.userDataDir);
      this.tmpDir = tmp;
      for (const name of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
    } catch (e) {
      console.error(`[Storage] 准备临时目录失败:${e instanceof Error ? e.message : String(e)}`);
    }
    return killed;
  }

  /** 搬家后老位置删不掉的残留(别的窗口的老式浏览器占着),能删了就删;启动时和每日清理各试一次 */
  private removeLeftovers(): void {
    const target = path.resolve(this.config.userDataDir);
    for (const dir of [target, `${target}-spaces`, SCREENSHOT_DIR]) removeLegacyLeftover(dir);
  }

  /** 新开一个工作区浏览器之前:已开的够数了,就关掉最久没用、且没有在途调用的那个 */
  private async makeRoomFor(sp: Space): Promise<void> {
    const open = [...this.spaces.values()].filter((s) => s !== sp && (s.context || s.launching));
    if (open.length < BrowserManager.MAX_OPEN_SPACES) return;
    const victim = open.filter((s) => s.context && s.inflight === 0 && !s.launching).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (victim) await this.shutSpaceBrowser(victim, `同时开着的工作区浏览器已达上限 ${BrowserManager.MAX_OPEN_SPACES} 个,它最久没用`);
  }

  private newSessionState(): SessionState {
    return { pages: [], activeIndex: 0, consoleLogs: [], networkRequests: [], blockRoute: null };
  }

  // ============================================================
  // 会话 → space 解析
  // ============================================================

  /**
   * 身份 → space 的**单一映射点**(设计文档 §8.2)。
   * V1 恒返回 default:本机单人场景就是要共享登录态。
   * 终局跨机多用户时改成按身份返回各自 space,即可让每人独立 profile、cookie 不互串,
   * 调用方无需改动 —— 架构上先把口子留在这里。
   */
  private resolveSpace(_sessionId: string): string {
    return DEFAULT_SPACE;
  }

  /** 会话当前所处的 space 名:space_switch/space_new 设置过就用它,否则回落映射默认值 */
  private spaceNameFor(sessionId: string): string {
    const picked = this.sessionSpace.get(sessionId);
    if (picked) {
      if (this.spaces.has(picked)) return picked;
      // 指向的 space 已被 space_close 销毁,残留映射失效,回落默认
      this.sessionSpace.delete(sessionId);
    }
    return this.resolveSpace(sessionId);
  }

  /** 会话当前所处的 space(default 被意外删除时按需重建) */
  private spaceFor(sessionId: string): Space {
    const name = this.spaceNameFor(sessionId);
    let sp = this.spaces.get(name);
    if (!sp) {
      sp = this.newSpaceState(DEFAULT_SPACE, this.config.userDataDir);
      this.spaces.set(DEFAULT_SPACE, sp);
    }
    return sp;
  }

  /** 取(必要时创建)会话在该 space 内的状态;已回收的会话拒绝重建,防止泄漏游离标签页 */
  private sessionState(sp: Space, sessionId: string): SessionState {
    let st = sp.sessions.get(sessionId);
    if (!st) {
      if (this.retired.has(sessionId)) {
        throw new Error(`MCP session ${sessionId} already closed`);
      }
      st = this.newSessionState();
      sp.sessions.set(sessionId, st);
    }
    return st;
  }

  /** 只读地取当前会话状态,不创建 —— 供日志/网络读取类接口使用,避免空连接白占资源 */
  private peekSession(): SessionState | undefined {
    const sessionId = currentSessionId();
    const name = this.spaceNameFor(sessionId);
    return this.spaces.get(name)?.sessions.get(sessionId);
  }

  /**
   * 摘掉已关闭的标签页,并把焦点**钉在原来那张页面对象上**。
   *
   * 只做「越界就收缩」是不够的:移除下标 < activeIndex 的页会让后面的页整体左移,
   * activeIndex 不变 = 焦点静默漂到隔壁页,后续 navigate/click 全打到错误页面
   * (关掉活跃页之前的标签、或站点自己 window.close() 都会触发)。
   * 所以先记住活跃页对象,过滤后按对象身份重新定位。
   */
  private pruneClosed(st: SessionState): void {
    if (!st.pages.some((p) => p.isClosed())) {
      if (st.activeIndex >= st.pages.length) {
        st.activeIndex = Math.max(0, st.pages.length - 1);
      }
      return;
    }
    const active = st.pages[st.activeIndex];
    st.pages = st.pages.filter((p) => !p.isClosed());
    const j = active && !active.isClosed() ? st.pages.indexOf(active) : -1;
    // 活跃页自己被关掉时,焦点顺延到同位置(或最后一个),与关闭前的直觉一致
    st.activeIndex = j >= 0 ? j : Math.min(st.activeIndex, Math.max(0, st.pages.length - 1));
  }

  private ensureUserDataDir(dir: string): void {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
  }

  /** space 是否有可用的浏览器上下文(页面级存活由各会话自行懒建,不影响这里) */
  private isSpaceAlive(sp: Space): boolean {
    return sp.context !== null;
  }

  /**
   * 启动某个 space 的浏览器上下文(幂等:已存活直接返回)。
   * HTTP 下多个会话可能同时打进来触发首次启动,同一 userDataDir 被并发启动两次会
   * 因 profile 目录被锁而失败,所以用 in-flight promise 把并发请求合并成一次启动。
   */
  private async launchSpace(sp: Space): Promise<BrowserContext> {
    sp.lastUsed = Date.now();
    if (sp.context) return sp.context;
    if (!sp.launching) {
      sp.launching = this.makeRoomFor(sp).then(() => this.doLaunchSpace(sp)).finally(() => { sp.launching = null; });
    }
    return sp.launching;
  }

  private async doLaunchSpace(sp: Space): Promise<BrowserContext> {
    if (sp.context) {
      return sp.context;
    }
    this.ensureUserDataDir(sp.userDataDir);

    // 无显示环境自动降级为无头并告警,而不是启动失败(设计文档 §8.3)。
    // Linux 服务器上 HEADLESS=false 会因为找不到 X11/Wayland 直接 launch 失败,
    // 常驻服务下这等于整个服务起不来。Windows/macOS 恒有显示服务,不受影响。
    // 有没有窗口按工作区自己的形态(sp.headed),不再是整个服务一个开关
    let headless = !sp.headed;
    if (!headless && noDisplayReason()) {
      console.warn(`[BrowserManager] ${noDisplayReason()},space '${sp.name}' 自动降级为无头模式`);
      headless = true;
      sp.headed = false;   // 如实记成无头:space_list / ensureHeaded 不能把降级后的浏览器报成有窗口
    }

    // 通用参数（macOS + Linux）
    const commonArgs = [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-dev-shm-usage',
      '--disable-breakpad',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      // 不再限制页面 JS 堆(原 --max-old-space-size=512):重的后台 / 开发版 SPA 超过 512MB 就崩页。
      // 2026-09-25 实测:同一页分配约 800MB 对象,带限制崩页,不带正常。
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-component-extensions-with-background-pages',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-translate',
      '--disable-features=TranslateUI,BlinkGenPropertyTrees',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--aggressive-cache-discard',
      '--force-color-profile=srgb',
      '--metrics-recording-only',
      '--password-store=basic',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
    ];
    // macOS 专属（Metal GPU 加速）
    const macArgs = ['--enable-gpu-rasterization', '--enable-zero-copy', '--use-mock-keychain'];
    // Linux 专属（无 GPU，服务器沙箱兼容）
    // 不用 --single-process:整个浏览器挤在一个进程里,任何一个标签页崩溃都会带走整个浏览器(所有标签页和登录态)。
    // 2026-09-25 在 ubuntu-244 实测:带它时一页 chrome://crash 整个浏览器关闭;去掉后只坏那一页,其余照常。
    const linuxArgs = ['--disable-gpu', '--disable-software-rasterizer', '--disable-setuid-sandbox', '--no-zygote'];
    // Windows 专属：无需额外启动参数，通用参数已足够
    const winArgs: string[] = [];
    const platformArgs = IS_LINUX ? linuxArgs : IS_MAC ? macArgs : IS_WIN ? winArgs : [];
    const launchArgs = [
      ...commonArgs,
      ...platformArgs,
      `--window-size=${this.config.viewportWidth},${this.config.viewportHeight}`
    ];

    if (this.config.devtools) {
      launchArgs.push('--auto-open-devtools-for-tabs');
      launchArgs.push('--remote-debugging-port=9222');
    }

    const context = await chromium.launchPersistentContext(
      path.resolve(sp.userDataDir),
      {
        headless,
        // patchright 在无显式 channel 时，即使 headless:false 也可能悄悄选中
        // chrome-headless-shell（阉割掉窗口渲染的专用二进制），导致有头模式实际不弹窗。
        // 显式指定 channel 强制走完整版 chrome.exe，真正弹出可见窗口。
        ...(headless ? {} : { channel: 'chromium' as const }),
        slowMo: this.config.slowMo,
        viewport: null,
        args: launchArgs,
        ignoreDefaultArgs: ['--enable-automation'],
        // 性能优化选项
        bypassCSP: true,                    // 绕过 CSP，加速页面加载
        ignoreHTTPSErrors: true,            // 忽略 HTTPS 错误，避免卡住
        javaScriptEnabled: true,
        acceptDownloads: true,
        // 平台对应 UA（macOS / Linux / Windows 各自匹配）
        userAgent: IS_WIN
          ? `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`
          : IS_LINUX
            ? `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`
            : `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VERSION} Safari/537.36`,
        extraHTTPHeaders: {
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br'
        }
      }
    );

    // patchright 为规避 Console.enable 检测泄漏，彻底禁用了 CDP Console 域，
    // 导致 page.on('console') 收不到页面脚本自己的 console.log/warn/error。
    // 用 exposeBinding 搭一条不经过 CDP Console 域的旁路：页面内 console 方法被
    // 劫持后直接把日志转发回 Node 端，绕开被禁用的通道。exposeBinding 与
    // addInitScript 一样对该 context 下所有现有/后续页面自动生效。
    // 多会话下必须按 source.page 找回**该页所属会话**的缓冲，否则日志会串台。
    await context.exposeBinding('__mcpConsoleLog', (source, type: string, text: string) => {
      const st = this.ownerOfPage(sp, source.page);
      if (!st) return;
      st.consoleLogs.push({ type: type as ConsoleLogEntry['type'], text, timestamp: Date.now() });
      if (st.consoleLogs.length > 2000) {
        st.consoleLogs = st.consoleLogs.slice(-1000);
      }
    });

    // ── 反爬指纹伪装 + console 劫持:走 route 注入 HTML,而不是 addInitScript
    //
    // 原实现用 context.addInitScript(),实测(2026-08-31 / patchright 1.62.2)**整段从未执行**,
    // 6 项指纹伪装全部形同虚设:navigator.webdriver 直接暴露、window.chrome 不存在、plugins 为空,
    // 爬公网站点基本会被当成机器人。page.addInitScript 与 CDP
    // Page.addScriptToEvaluateOnNewDocument 同样无效(下发成功但不执行)。
    // 唯一可用的通道是拦 HTML 响应把 <script> 注进 <head> —— 详见 src/inject.ts 的实测表。
    //
    // ⚠️ 排错提醒:判断脚本"有没有执行"必须走 DOM(跨世界共享)。
    // page.evaluate 跑在**隔离世界**,读不到主世界的 window.X,会把"执行了"误判成"没执行"。
    //
    // 装在 **context** 级:页面级 route(set_block_rules)优先匹配,放行时调 route.fallback()
    // 就会落到这里,两者互不冲突。若改成页面级,两个 '**/*' handler 的优先级会打架。
    await context.route('**/*', buildHtmlInjector([MAIN_WORLD_SRC, EGO_HELPER_SRC]));

    // 抓 chromium 子进程 pid — Playwright 内部 API 但多年稳定；失败不影响主流程
    try {
      const browser = context.browser();
      const child = (browser as unknown as { _process?: { pid?: number } })?._process;
      sp.chromiumPid = child?.pid ?? null;
    } catch {
      sp.chromiumPid = null;
    }

    // 浏览器被外部关掉(用户点 X / 崩溃)时把 space 打回未启动态,
    // 下次请求自动重建;各会话的日志缓冲保留,只清失效的页面引用。
    // 人把临时弹出的窗口关了 = 处理完了,下次按服务默认形态(通常是无头)重开,不再弹窗。
    context.on('close', () => {
      if (sp.context !== context) return;
      console.log(`[BrowserManager] space '${sp.name}' 浏览器上下文已关闭,将在下次请求时重建`);
      sp.context = null;
      sp.headed = sp.baseHeaded;
      sp.chromiumPid = null;
      for (const st of sp.sessions.values()) {
        st.pages = [];
        st.activeIndex = 0;
      }
    });

    sp.context = context;
    return context;
  }

  // ============================================================
  // 按需弹窗:平时无头,要人工处理时同一个工作区原地换成有窗口的,处理完再换回去。
  //
  // 换形态 = 关掉这个工作区的浏览器、用**同一个 userDataDir** 按新形态重开,
  // 所以 profile 里的登录态 / localStorage 自然带过去;会话 cookie(没有过期时间、不落盘的那种)
  // 关浏览器会丢,先取出来、重开后补回去。各会话的标签页记下网址,重开后按原顺序打开、焦点不变。
  // 带不过去的:sessionStorage、表单里没提交的输入、页面内存里的 JS 状态 —— 所以要在
  // **把页面导航到需要人工那一步之后、开始填之前**弹窗(wait_for_human 一进来就弹正是这个时机)。
  // ============================================================

  /** 当前会话所在工作区换成有窗口的(已经是就什么都不做) */
  public async ensureHeaded(): Promise<ModeSwitchResult> {
    return this.switchMode(this.spaceFor(currentSessionId()), true);
  }

  /** 当前会话所在工作区换回无头(已经是就什么都不做);人工处理完收窗口用 */
  public async ensureHeadless(): Promise<ModeSwitchResult> {
    return this.switchMode(this.spaceFor(currentSessionId()), false);
  }

  private async switchMode(sp: Space, headed: boolean): Promise<ModeSwitchResult> {
    // 正在启动 / 正在被别的调用换形态:等它落定再判断,不并发重开同一个 profile(会抢 SingletonLock)
    while (sp.launching) await sp.launching.catch(() => { /* 启动失败也往下走,由下面重开 */ });
    if (sp.headed === headed) return { headed, switched: false, restored: [] };
    if (headed) {
      const why = noDisplayReason();
      if (why) return { headed: false, switched: false, restored: [], reason: why };
    }
    // 还没开浏览器(刚启动 / 被空闲回收了):只改形态,下次用到按新形态开,不用关什么
    if (!sp.context) {
      sp.headed = headed;
      return { headed, switched: true, restored: [] };
    }
    // 别的调用正在用这个浏览器(另一个窗口在跑 navigate / 批量抓取…):关掉它等于把别人的活掐断。
    // 宁可明确拒绝,让 AI 等那边跑完再来。inflight 里含调用方自己这一次,先减掉。
    const self = this.callSpace.getStore() === sp ? 1 : 0;
    const others = sp.inflight - self;
    if (others > 0) {
      throw new Error(
        `工作区 '${sp.name}' 还有 ${others} 个别的调用正在用浏览器,现在${headed ? '弹出窗口' : '收起窗口'}会打断它们。`
        + '等那些调用结束后再试;或用 space_new 开一个单独的工作区处理需要人工的页面。');
    }
    // 整个换形态过程挂在 launching 上:这期间进来的 getPage / launchSpace 都等它,
    // 不会有人趁浏览器关着另起一个,也不会被空闲回收、makeRoomFor 挑中
    const run = this.doSwitchMode(sp, headed);
    const launching = run.then(() => {
      if (!sp.context) throw new Error(`space '${sp.name}' 换形态后浏览器没起来`);
      return sp.context;
    }).finally(() => { if (sp.launching === launching) sp.launching = null; });
    launching.catch(() => { /* 错误由 run 交给调用方;这里只防未处理拒绝 */ });
    sp.launching = launching;
    return run;
  }

  private async doSwitchMode(sp: Space, headed: boolean): Promise<ModeSwitchResult> {
    const old = sp.context!;
    // 1. 记下每个会话的标签页和焦点
    const memos: TabMemo[] = [];
    for (const [sessionId, st] of sp.sessions) {
      this.pruneClosed(st);
      const urls = st.pages.filter((p) => !p.isClosed()).map((p) => p.url());
      if (urls.length) memos.push({ sessionId, urls, activeIndex: st.activeIndex });
    }
    // 2. 会话 cookie 不落盘,关浏览器就没了 —— 先取出来(持久 cookie 也一并取,补回去无害)
    let cookies: Cookie[] = [];
    try { cookies = await old.cookies(); } catch { /* 取不到就只靠 profile */ }

    // 3. 关掉、按新形态重开(同一个 userDataDir)
    await this.shutSpaceBrowser(sp, headed ? '要人工处理,换成有窗口的' : '人工处理完,收起窗口换回无头', true);
    sp.headed = headed;
    let reason: string | undefined;
    try {
      await this.relaunch(sp);
    } catch (e) {
      // 有窗口的起不来(例如完整版 Chromium 没装):退回无头,别让工作区直接没了浏览器
      if (!headed) throw e;
      const msg = e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e);
      reason = `有窗口的浏览器启动失败,已退回无头:${msg}`;
      console.error(`[BrowserManager] space '${sp.name}' ${reason}`);
      sp.headed = false;
      await this.relaunch(sp);
    }
    const ctx = sp.context!;
    if (cookies.length) {
      try { await ctx.addCookies(cookies); } catch (e) {
        console.error(`[BrowserManager] space '${sp.name}' 补回 cookie 失败:${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // 4. 各会话按原顺序重开标签页、恢复焦点
    const restored: string[] = [];
    const failed: string[] = [];
    let adopt = true;   // 第一张页接管 launchPersistentContext 自带的空白页,不多留一个游离标签
    for (const m of memos) {
      const st = sp.sessions.get(m.sessionId);
      if (!st) continue;   // 换形态期间这个会话已经下线
      for (const url of m.urls) {
        const page = await this.openPage(sp, m.sessionId, st, adopt);
        adopt = false;
        if (!url || url === 'about:blank') continue;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: RESTORE_NAV_TIMEOUT_MS });
          restored.push(url);
        } catch {
          failed.push(url);
        }
      }
      st.activeIndex = Math.min(m.activeIndex, Math.max(0, st.pages.length - 1));
    }
    if (failed.length) {
      const note = `有 ${failed.length} 个标签页没能重新打开:${failed.join(' , ')}`;
      reason = reason ? `${reason};${note}` : note;
    }
    return { headed: sp.headed, switched: sp.headed === headed, restored, ...(reason ? { reason } : {}) };
  }

  /** 关掉后立刻用同一个 profile 重开;Chromium 退出后 profile 锁偶尔晚一拍释放,失败等一下再试一次 */
  private async relaunch(sp: Space): Promise<void> {
    try {
      await this.doLaunchSpace(sp);
    } catch {
      await new Promise((r) => setTimeout(r, 1500));
      await this.doLaunchSpace(sp);
    }
  }

  /** 找出某个 page 属于哪个会话(console/network 事件回流时用) */
  private ownerOfPage(sp: Space, page: Page): SessionState | undefined {
    for (const st of sp.sessions.values()) {
      if (st.pages.includes(page)) return st;
    }
    return undefined;
  }

  /**
   * 为会话开一个新标签页。
   * 首个会话优先接管 launchPersistentContext 自带的空白页(以及无主的孤儿页),
   * 否则每次启动都会多出一个没人用的游离标签页。
   */
  private async openPage(sp: Space, sessionId: string, st: SessionState, adoptOrphan: boolean): Promise<Page> {
    const context = await this.launchSpace(sp);
    let page: Page | undefined;
    if (adoptOrphan) {
      const owned = new Set<Page>();
      for (const s of sp.sessions.values()) {
        for (const p of s.pages) owned.add(p);
      }
      page = context.pages().find((p) => !p.isClosed() && !owned.has(p));
    }
    if (!page) page = await context.newPage();
    st.pages.push(page);
    st.activeIndex = st.pages.length - 1;
    this.setupPageListeners(sp, sessionId, page);
    // 本会话若开着屏蔽规则,新标签页要补挂 —— 原来挂 context 时新页自动生效,语义要保持一致
    if (st.blockRoute) {
      await page.route('**/*', st.blockRoute).catch(() => { /* 页面可能刚被关掉 */ });
    }
    return page;
  }

  public async getContext(): Promise<BrowserContext> {
    return this.launchSpace(this.spaceFor(currentSessionId()));
  }

  /** 返回当前会话所在 space 的 chromium 进程 PID（无活跃浏览器则 null）— stdio 退出钩子用 */
  public getChromiumPid(): number | null {
    return this.spaceFor(currentSessionId()).chromiumPid;
  }

  /**
   * 同步杀掉所有 space 的 chromium **进程树** — 用于 process.on('exit') / 超时兜底,无 await。
   *
   * 原来这里是 `process.kill(pid, 'SIGKILL')`,只干掉浏览器主进程一个。chromium 会 fork 出
   * renderer / GPU / network / zygote 一大串子进程,主进程被硬杀后它们不保证跟着走 ——
   * 活下来的孤儿仍然握着 userDataDir 的 profile 锁,下次启动直接失败。这个钩子存在的
   * 全部意义就是「别留孤儿」,只杀一个进程等于没做干净。
   * 现在统一交给 portkill 的跨平台实现(Windows: taskkill /F /T;POSIX: 杀进程组),
   * 三平台语义一致。幂等:pid 先置空再杀,重复调用不会重复发信号,也永远不抛异常。
   */
  public killChromiumSync(): void {
    for (const sp of this.spaces.values()) {
      const pid = sp.chromiumPid;
      sp.chromiumPid = null;
      if (!pid) continue;
      killProcessTreeSync(pid);
    }
  }

  /** 当前会话的活跃标签页;没有(或已关闭)则在其 space 里懒建一个 */
  public async getPage(): Promise<Page> {
    const sessionId = currentSessionId();
    const sp = this.spaceFor(sessionId);
    await this.launchSpace(sp);
    const st = this.sessionState(sp, sessionId);
    this.pruneClosed(st);
    const page = st.pages[st.activeIndex];
    if (page && !page.isClosed()) return page;
    return this.openPage(sp, sessionId, st, true);
  }

  private setupPageListeners(sp: Space, sessionId: string, page: Page): void {
    if (sp.listenedPages.has(page)) return;
    sp.listenedPages.add(page);

    // 事件回调不在 ALS 上下文里,会话归属靠闭包捕获的 sessionId,
    // 且每次都重新 get —— 会话被回收后事件自然丢弃,不会写进已释放的缓冲。
    page.on('console', (msg) => {
      const st = sp.sessions.get(sessionId);
      if (!st) return;
      const type = msg.type() as ConsoleLogEntry['type'];
      st.consoleLogs.push({ type, text: msg.text(), timestamp: Date.now() });
      if (st.consoleLogs.length > 2000) {
        st.consoleLogs = st.consoleLogs.slice(-1000);
      }
    });

    page.on('response', (response) => {
      const st = sp.sessions.get(sessionId);
      if (!st) return;
      const request = response.request();
      st.networkRequests.push({
        url: request.url(),
        method: request.method(),
        status: response.status(),
        resourceType: request.resourceType(),
        timestamp: Date.now()
      });
      if (st.networkRequests.length > 500) {
        st.networkRequests = st.networkRequests.slice(-250);
      }
    });

    // 按下标补偿:移除活跃页**之前**的标签会让后面整体左移,activeIndex 必须跟着减 1,
    // 否则焦点会静默漂到隔壁页(页面被站点自身 window.close() 关闭时同样会走到这里)。
    const drop = (): void => {
      const st = sp.sessions.get(sessionId);
      if (!st) return;
      const i = st.pages.indexOf(page);
      if (i < 0) return;
      st.pages.splice(i, 1);
      if (i < st.activeIndex) st.activeIndex--;
      if (st.activeIndex >= st.pages.length) {
        st.activeIndex = Math.max(0, st.pages.length - 1);
      }
    };
    page.on('close', drop);
    page.on('crash', () => {
      console.error(`[BrowserManager] space '${sp.name}' 会话 ${sessionId} 页面崩溃，将在下次请求时重建`);
      drop();
      // 崩溃的页并不会自己关:不关的话它还挂在 context 里,下次 openPage 的「接管无主页」会把这具尸体捡回来,
      // 之后每个操作都失败。关掉它,下次请求就开一张干净的新页。
      void page.close().catch(() => { /* 可能已随浏览器一起没了 */ });
    });

    // window.open 弹出的新页归属**开它的那个会话**,否则会变成孤儿页被别的会话认领
    page.on('popup', (popup) => {
      const st = sp.sessions.get(sessionId);
      if (!st) return;
      st.pages.push(popup);
      this.setupPageListeners(sp, sessionId, popup);
      if (st.blockRoute) {
        void popup.route('**/*', st.blockRoute).catch(() => { /* noop */ });
      }
    });
  }

  public getConsoleLogs(): ConsoleLogEntry[] {
    const st = this.peekSession();
    return st ? [...st.consoleLogs] : [];
  }

  /**
   * 把页面里攒着的 console 日志取回本会话缓冲。
   *
   * 主世界的 console 劫持调不到 exposeBinding(实测在主世界是 undefined),
   * 所以它把日志写进一个隐藏 DOM 节点;这里从**隔离世界**把它排空 —— DOM 跨世界共享,
   * 这是两个世界之间唯一可靠的通道。详见 src/inject.ts。
   *
   * 取走即删除,重复调用不会重复上报。只扫本会话自己的页面,不会串台。
   * 单页失败(已关闭/跨域限制)只跳过该页,不影响其它页 —— 读日志失败绝不该让工具失败。
   */
  public async drainPageLogs(): Promise<void> {
    const sessionId = currentSessionId();
    const sp = this.spaceFor(sessionId);
    const st = sp.sessions.get(sessionId);
    if (!st) return;
    this.pruneClosed(st);
    for (const p of st.pages) {
      if (p.isClosed()) continue;
      try {
        const rows = (await p.evaluate(DRAIN_SRC)) as Array<{ type: string; text: string }>;
        if (!Array.isArray(rows) || rows.length === 0) continue;
        for (const r of rows) {
          st.consoleLogs.push({
            type: (r.type as ConsoleLogEntry['type']) ?? 'log',
            text: String(r.text ?? ''),
            timestamp: Date.now(),
          });
        }
        if (st.consoleLogs.length > 2000) st.consoleLogs = st.consoleLogs.slice(-1000);
      } catch { /* 该页读不到就跳过 */ }
    }
  }

  public clearConsoleLogs(): void {
    const st = this.peekSession();
    if (st) st.consoleLogs = [];
  }

  public getNetworkRequests(): NetworkRequestEntry[] {
    const st = this.peekSession();
    return st ? [...st.networkRequests] : [];
  }

  public clearNetworkRequests(): void {
    const st = this.peekSession();
    if (st) st.networkRequests = [];
  }

  public isAlive(): boolean {
    return this.isSpaceAlive(this.spaceFor(currentSessionId()));
  }

  /** 当前会话所在工作区现在是不是有窗口 */
  public isHeaded(): boolean {
    return this.spaceFor(currentSessionId()).headed;
  }

  /** 把某个页面设为当前会话的活跃页(不属于本会话则先纳入本会话) */
  public setActivePage(page: Page): void {
    const sessionId = currentSessionId();
    const sp = this.spaceFor(sessionId);
    const st = this.sessionState(sp, sessionId);
    const i = st.pages.indexOf(page);
    if (i >= 0) {
      st.activeIndex = i;
      return;
    }
    st.pages.push(page);
    st.activeIndex = st.pages.length - 1;
    this.setupPageListeners(sp, sessionId, page);
    if (st.blockRoute) {
      void page.route('**/*', st.blockRoute).catch(() => { /* noop */ });
    }
  }

  /**
   * 设置(或清除)当前会话的请求屏蔽规则 —— set_block_rules 的落地点。
   * 挂在**本会话自己的每张标签页**上而不是 context 上:多会话共享同一个 default space 的
   * context,挂 context 会让 A 会话的屏蔽规则连带作用到 B 会话的所有标签页
   * (B 的 take_screenshot 会拿到缺图页面),与「多会话互不干扰」的总目标冲突。
   * 本会话之后新开的标签页在 openPage/popup 里自动补挂,行为与原来的 context.route 一致。
   */
  public async setBlockRoute(handler: ((route: Route) => void) | null): Promise<void> {
    const sessionId = currentSessionId();
    const sp = this.spaceFor(sessionId);
    await this.launchSpace(sp);
    const st = this.sessionState(sp, sessionId);
    this.pruneClosed(st);
    const prev = st.blockRoute;
    if (prev) {
      for (const p of st.pages) {
        if (!p.isClosed()) await p.unroute('**/*', prev).catch(() => { /* noop */ });
      }
    }
    st.blockRoute = handler;
    if (handler) {
      for (const p of st.pages) {
        if (!p.isClosed()) await p.route('**/*', handler).catch(() => { /* noop */ });
      }
    }
  }

  // ============================================================
  // 多标签页(收敛到当前会话自己的标签页,不再枚举整个 context)
  // ============================================================

  /** 当前会话的标签页列表(保证至少有一个) */
  public async getSessionPages(): Promise<Page[]> {
    await this.getPage();
    const sessionId = currentSessionId();
    const st = this.sessionState(this.spaceFor(sessionId), sessionId);
    this.pruneClosed(st);
    return [...st.pages];
  }

  /** 当前会话活跃标签页的下标 */
  public getActiveTabIndex(): number {
    const st = this.peekSession();
    return st ? st.activeIndex : 0;
  }

  /** 给当前会话开一个新标签页并设为活跃 */
  public async openTab(): Promise<{ page: Page; index: number }> {
    const sessionId = currentSessionId();
    const sp = this.spaceFor(sessionId);
    await this.launchSpace(sp);
    const st = this.sessionState(sp, sessionId);
    this.pruneClosed(st);
    // 会话还没有任何标签页时允许接管自带空白页,避免留下游离标签
    const page = await this.openPage(sp, sessionId, st, st.pages.length === 0);
    return { page, index: st.activeIndex };
  }

  /**
   * 批量任务用的临时标签页:挂上本会话的屏蔽规则(openPage 负责),但不抢焦点 ——
   * 用户 / AI 当前看的那页保持不变。用完直接 page.close(),close 事件会把它从会话里摘掉。
   */
  public async openWorkerTab(): Promise<Page> {
    const sessionId = currentSessionId();
    const sp = this.spaceFor(sessionId);
    await this.launchSpace(sp);
    const st = this.sessionState(sp, sessionId);
    this.pruneClosed(st);
    const keep = st.activeIndex;
    const page = await this.openPage(sp, sessionId, st, false);
    st.activeIndex = keep;
    return page;
  }

  /** 切换当前会话的活跃标签页 */
  public async activateTab(index: number): Promise<Page> {
    const pages = await this.getSessionPages();
    if (index < 0 || index >= pages.length) {
      throw new Error(`Tab index ${index} out of range (0-${pages.length - 1})`);
    }
    const sessionId = currentSessionId();
    const st = this.sessionState(this.spaceFor(sessionId), sessionId);
    st.activeIndex = index;
    return pages[index]!;
  }

  /** 关闭当前会话的某个标签页,返回剩余数量 */
  public async closeTabAt(index: number): Promise<number> {
    const pages = await this.getSessionPages();
    if (index < 0 || index >= pages.length) {
      throw new Error(`Tab index ${index} out of range (0-${pages.length - 1})`);
    }
    if (pages.length <= 1) {
      throw new Error('Cannot close the last tab');
    }
    const sessionId = currentSessionId();
    const st = this.sessionState(this.spaceFor(sessionId), sessionId);
    // 先记住活跃页**对象**:关掉它之前的标签后下标会左移,只有按对象身份才能把焦点钉住
    const active = st.pages[st.activeIndex];
    await pages[index]!.close();
    this.pruneClosed(st);   // page.on('close') 里的 drop 可能已经摘过,pruneClosed 幂等
    const j = active && !active.isClosed() ? st.pages.indexOf(active) : -1;
    // 关的就是活跃页时才顺延焦点(同位置或最后一个);关别的页则焦点不动
    st.activeIndex = j >= 0 ? j : Math.min(index, Math.max(0, st.pages.length - 1));
    return st.pages.length;
  }

  // ============================================================
  // 会话生命周期
  // ============================================================

  /**
   * 回收一个会话:关闭它的全部标签页、清空缓冲、丢弃 space 映射。
   * 故意**不关 context** —— 最后一个会话退出后保留浏览器进程,下次连上秒开(热启动)。
   */
  public async closeSession(sessionId: string): Promise<void> {
    for (const sp of this.spaces.values()) {
      const st = sp.sessions.get(sessionId);
      if (!st) continue;
      sp.sessions.delete(sessionId);
      for (const page of st.pages) {
        try {
          if (!page.isClosed()) await page.close();
        } catch { /* 页面可能已随浏览器一起消失 */ }
      }
      st.pages = [];
      st.consoleLogs = [];
      st.networkRequests = [];
      st.blockRoute = null;
    }
    this.sessionSpace.delete(sessionId);
    // 立墓碑:在途工具调用晚于本次回收到达时,不许再把会话状态建回来(见 retired 注释)
    this.retired.add(sessionId);
    while (this.retired.size > BrowserManager.RETIRED_MAX) {
      const oldest = this.retired.values().next().value;
      if (oldest === undefined) break;
      this.retired.delete(oldest);
    }
  }

  /** 当前存活的会话数(跨所有 space 去重) */
  public countSessions(): number {
    const ids = new Set<string>();
    for (const sp of this.spaces.values()) {
      for (const id of sp.sessions.keys()) ids.add(id);
    }
    return ids.size;
  }

  // ============================================================
  // Task Spaces 管理(只影响调用方会话)
  // ============================================================

  /** 当前会话所处的 space 名 */
  public getActiveSpace(): string {
    return this.spaceNameFor(currentSessionId());
  }

  /** 列出所有 space 及状态(active/url 按**调用方会话**的视角给) */
  public listSpaces(): { name: string; active: boolean; alive: boolean; headed: boolean; url: string | null }[] {
    const sessionId = currentSessionId();
    const activeName = this.spaceNameFor(sessionId);
    return [...this.spaces.values()].map((sp) => {
      const st = sp.sessions.get(sessionId);
      const page = st?.pages[st.activeIndex];
      return {
        name: sp.name,
        active: sp.name === activeName,
        alive: this.isSpaceAlive(sp),
        headed: sp.headed,
        url: page && !page.isClosed() ? page.url() : null,
      };
    });
  }

  /**
   * 计算某个 space 的独立 userDataDir。
   *
   * 必须**从属于本服务自己的 userDataDir**,而不是它的父目录:
   * 有头(3213)与无头(3215)的默认 profile 是 storage/ 下的**同级**目录
   * (user_data_headed / user_data),父目录都是 storage/。若按 dirname(userDataDir)/spaces/<name>
   * 算,两个服务用同名 space(例如都 space_new('job1'))就会落到同一个 profile 目录,
   * 两个 Chromium 抢同一把 SingletonLock —— 与默认 profile 撞车是同一类上线阻断级 bug,只是换了入口。
   *
   * 取 <userDataDir>-spaces/<name>:天然带上本服务 profile 的目录名,
   * 有头 → storage/user_data_headed-spaces/job1,无头 → storage/user_data-spaces/job1,永不相交。
   * 显式设了 USER_DATA_DIR 的部署同理(每个 USER_DATA_DIR 各带一棵 space 树)。
   * 全程走 path 模块拼接,不硬编码分隔符,Windows / macOS / Linux 一致。
   */
  private spaceDirFor(name: string): string {
    const base = path.resolve(this.config.userDataDir);
    return path.join(path.dirname(base), `${path.basename(base)}-spaces`, name);
  }

  /**
   * 新建并切换到一个 space(隔离的 userDataDir → 独立 cookie/登录态)。
   * 已存在同名 space 则直接切过去,不重复创建。切换只作用于调用方会话。
   * headed:这个工作区要不要可见窗口(新建时直接按它开;已存在且形态不同则原地换)。
   * 不给就按服务默认(通常无头;要人工时 wait_for_human 会自动弹窗)。
   */
  public async createSpace(name: string, headed?: boolean): Promise<{ name: string; created: boolean; headed: boolean; reason?: string }> {
    const clean = name.trim();
    if (!clean) throw new Error('space 名不能为空');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(clean)) {
      throw new Error('space 名仅允许字母/数字/下划线/连字符,长度 1-40');
    }
    let created = false;
    let reason: string | undefined;
    if (!this.spaces.has(clean)) {
      const fresh = this.newSpaceState(clean, this.spaceDirFor(clean));
      if (headed !== undefined) {
        reason = (headed ? noDisplayReason() : null) ?? undefined;
        fresh.headed = headed && !reason;
      }
      this.spaces.set(clean, fresh);
      created = true;
    }
    const sp = this.spaces.get(clean)!;
    this.sessionSpace.set(currentSessionId(), clean);
    if (!created && headed !== undefined && sp.headed !== headed) {
      reason = (await this.switchMode(sp, headed)).reason;
    }
    await this.launchSpace(sp);
    return { name: clean, created, headed: sp.headed, ...(reason ? { reason } : {}) };
  }

  /** 切换调用方会话的 space(必须已存在) */
  public async switchSpace(name: string): Promise<{ name: string }> {
    const clean = name.trim();
    if (!this.spaces.has(clean)) throw new Error(`space '${clean}' 不存在,请先 space_new 创建`);
    this.sessionSpace.set(currentSessionId(), clean);
    await this.launchSpace(this.spaces.get(clean)!);
    return { name: clean };
  }

  /** 关闭并销毁一个 space(不允许关 default);停留在该 space 的会话自动回落到 default */
  public async closeSpace(name: string): Promise<{ closed: boolean; active: string }> {
    const clean = name.trim();
    if (clean === DEFAULT_SPACE) throw new Error('default space 不可关闭');
    const sp = this.spaces.get(clean);
    if (!sp) throw new Error(`space '${clean}' 不存在`);
    try { await sp.context?.close(); } catch { /* noop */ }
    sp.context = null;
    sp.chromiumPid = null;
    sp.sessions.clear();
    this.spaces.delete(clean);
    for (const [sid, spaceName] of this.sessionSpace) {
      if (spaceName === clean) this.sessionSpace.delete(sid);
    }
    return { closed: true, active: this.getActiveSpace() };
  }

  /** 关闭全部 space 的浏览器上下文 */
  public async close(): Promise<void> {
    for (const sp of this.spaces.values()) {
      if (sp.context) {
        try { await sp.context.close(); } catch { /* noop */ }
        sp.context = null;
        sp.chromiumPid = null;
      }
      sp.sessions.clear();
    }
    this.sessionSpace.clear();
  }
}

export function getBrowserManager(): BrowserManager {
  return BrowserManager.getInstance();
}

export { BrowserManager };
