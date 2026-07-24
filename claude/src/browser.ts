/**
 * BrowserManager - 跨平台 Playwright 浏览器管理器(支持 Task Spaces 多隔离工作区)
 * 支持 macOS / Linux (Debian/Ubuntu) / Windows 无头模式
 * Claude Code 版本
 *
 * Task Spaces(对齐 ego-lite 的并行隔离工作区):
 *   - 每个 space = 独立的 persistent context + 独立 userDataDir(cookie/登录态互不污染)
 *     + 独立 console/network 缓冲。可并行跑多任务或多账号,互不干扰。
 *   - 默认存在名为 'default' 的 space,行为与旧版单例完全一致;不用多 space 的调用方无感。
 *   - 所有既有工具都作用于「当前活跃 space」的页面;space_* 工具用于新建/切换/关闭/列举。
 */

import { chromium, type BrowserContext, type Page } from 'patchright';
import * as path from 'path';
import * as fs from 'fs';
import type { ConsoleLogEntry, NetworkRequestEntry, BrowserConfig } from './types.js';
import { EGO_HELPER_SRC } from './injected.js';

const IS_LINUX = process.platform === 'linux';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// Chrome 版本号 token，统一用于各平台 UA 字符串
// patchright 1.60 捆绑 Chrome for Testing 148，UA 需与真实内核版本一致，否则指纹自相矛盾
const CHROME_VERSION = process.env['UA_CHROME_VERSION'] ?? '148.0.0.0';

const DEFAULT_SPACE = 'default';

const DEFAULT_CONFIG: BrowserConfig = {
  // headless 默认开启；Mac 调试时设 HEADLESS=false
  headless: process.env['HEADLESS'] !== 'false',
  userDataDir: process.env['USER_DATA_DIR'] ?? 'storage/user_data',
  viewportWidth: parseInt(process.env['VIEWPORT_WIDTH'] ?? '1280', 10),
  viewportHeight: parseInt(process.env['VIEWPORT_HEIGHT'] ?? '800', 10),
  devtools: process.env['DEVTOOLS'] === 'true',
  slowMo: parseInt(process.env['SLOW_MO'] ?? '0', 10)
};

/** 单个工作区(space)的运行态 —— 一个 space 一份浏览器上下文与独立缓冲 */
interface Space {
  name: string;
  userDataDir: string;
  context: BrowserContext | null;
  page: Page | null;
  consoleLogs: ConsoleLogEntry[];
  networkRequests: NetworkRequestEntry[];
  listenedPages: WeakSet<Page>;
  chromiumPid: number | null;
}

class BrowserManager {
  private static instance: BrowserManager | null = null;
  private config: BrowserConfig;
  private spaces = new Map<string, Space>();
  private activeSpace = DEFAULT_SPACE;

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
      page: null,
      consoleLogs: [],
      networkRequests: [],
      listenedPages: new WeakSet<Page>(),
      chromiumPid: null,
    };
  }

  /** 当前活跃 space(不存在则回落到 default 并按需重建) */
  private current(): Space {
    let sp = this.spaces.get(this.activeSpace);
    if (!sp) {
      this.activeSpace = DEFAULT_SPACE;
      sp = this.spaces.get(DEFAULT_SPACE);
      if (!sp) {
        sp = this.newSpaceState(DEFAULT_SPACE, this.config.userDataDir);
        this.spaces.set(DEFAULT_SPACE, sp);
      }
    }
    return sp;
  }

  private ensureUserDataDir(dir: string): void {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true });
    }
  }

  private isSpaceAlive(sp: Space): boolean {
    try {
      return sp.context !== null && sp.page !== null && !sp.page.isClosed();
    } catch {
      return false;
    }
  }

  /** 启动某个 space 的浏览器上下文(幂等:已存活直接返回) */
  private async launchSpace(sp: Space): Promise<BrowserContext> {
    if (sp.context && this.isSpaceAlive(sp)) {
      return sp.context;
    }
    this.ensureUserDataDir(sp.userDataDir);

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
      '--js-flags=--max-old-space-size=512',
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
    const linuxArgs = ['--disable-gpu', '--disable-software-rasterizer', '--disable-setuid-sandbox', '--single-process', '--no-zygote'];
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
        headless: this.config.headless,
        // patchright 在无显式 channel 时，即使 headless:false 也可能悄悄选中
        // chrome-headless-shell（阉割掉窗口渲染的专用二进制），导致有头模式实际不弹窗。
        // 显式指定 channel 强制走完整版 chrome.exe，真正弹出可见窗口。
        ...(this.config.headless ? {} : { channel: 'chromium' as const }),
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
    await context.exposeBinding('__mcpConsoleLog', (_source, type: string, text: string) => {
      sp.consoleLogs.push({ type: type as ConsoleLogEntry['type'], text, timestamp: Date.now() });
      if (sp.consoleLogs.length > 2000) {
        sp.consoleLogs = sp.consoleLogs.slice(-1000);
      }
    });

    // 反爬虫指纹伪装：在每个页面执行前注入，掩盖常见的自动化检测向量
    await context.addInitScript(() => {
      // 1. navigator.webdriver -> undefined
      try { delete (Navigator.prototype as { webdriver?: unknown }).webdriver; } catch { /* noop */ }
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      // 2. navigator.languages
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
      // 3. navigator.plugins 非空伪装
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const arr = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
            { name: 'Native Client', filename: 'internal-nacl-plugin' },
          ];
          (arr as unknown as { item: (i: number) => unknown }).item = (i: number) => arr[i];
          return arr;
        },
      });
      // 4. window.chrome
      if (!(window as { chrome?: unknown }).chrome) {
        (window as { chrome?: unknown }).chrome = { runtime: {} };
      }
      // 5. permissions.query 修补（notifications 返回正常状态）
      const origQuery = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (params: PermissionDescriptor) =>
        params && params.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
          : origQuery(params);
      // 6. console 劫持:转发给 Node 端(见上方 exposeBinding),同时保留原始行为。
      // patchright 对同一文档会执行两遍 addInitScript(推测是其绕开 Runtime.enable
      // 的双重注入机制所致),不加幂等标记会把 console 包两层、每条日志上报两次。
      try {
        const w = window as unknown as {
          __mcpConsoleLog?: (type: string, text: string) => void;
          __mcpConsolePatched?: boolean;
        };
        if (!w.__mcpConsolePatched) {
          w.__mcpConsolePatched = true;
          (['log', 'info', 'warn', 'error', 'debug'] as const).forEach((m) => {
            const orig = console[m].bind(console);
            console[m] = (...args: unknown[]) => {
              try {
                const text = args.map((a) => {
                  if (typeof a === 'string') return a;
                  try { return JSON.stringify(a); } catch { return String(a); }
                }).join(' ');
                w.__mcpConsoleLog?.(m, text);
              } catch { /* noop */ }
              orig(...args);
            };
          });
        }
      } catch { /* noop */ }
    });

    // __ego 一次跑完 helper:注入到该 context 所有页面,供 run_script 免手动安装即用。
    // 幂等自安装(见 injected.ts),重复注入无副作用。
    await context.addInitScript(EGO_HELPER_SRC);

    // 抓 chromium 子进程 pid — Playwright 内部 API 但多年稳定；失败不影响主流程
    try {
      const browser = context.browser();
      const child = (browser as unknown as { _process?: { pid?: number } })?._process;
      sp.chromiumPid = child?.pid ?? null;
    } catch {
      sp.chromiumPid = null;
    }

    sp.context = context;
    const pages = context.pages();
    sp.page = pages[0] ?? await context.newPage();
    this.setupPageListeners(sp, sp.page);

    return context;
  }

  public async getContext(): Promise<BrowserContext> {
    return this.launchSpace(this.current());
  }

  /** 返回当前活跃 space 的 chromium 进程 PID（无活跃浏览器则 null）— stdio 退出钩子用 */
  public getChromiumPid(): number | null {
    return this.current().chromiumPid;
  }

  /** 同步 SIGKILL 所有 space 的 chromium 子进程 — 用于 process.on('exit') / 超时兜底，无 await */
  public killChromiumSync(): void {
    for (const sp of this.spaces.values()) {
      const pid = sp.chromiumPid;
      sp.chromiumPid = null;
      if (!pid) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 已死或无权限，无所谓
      }
    }
  }

  public async getPage(): Promise<Page> {
    const sp = this.current();
    if (!this.isSpaceAlive(sp)) {
      console.log(`[BrowserManager] space '${sp.name}' 浏览器/页面已失效，正在重建...`);
      sp.context = null;
      sp.page = null;
    }
    await this.launchSpace(sp);
    if (!sp.page) {
      throw new Error('无法获取页面实例');
    }
    return sp.page;
  }

  private setupPageListeners(sp: Space, page: Page): void {
    if (sp.listenedPages.has(page)) return;
    sp.listenedPages.add(page);
    page.on('console', (msg) => {
      const type = msg.type() as ConsoleLogEntry['type'];
      sp.consoleLogs.push({ type, text: msg.text(), timestamp: Date.now() });
      if (sp.consoleLogs.length > 2000) {
        sp.consoleLogs = sp.consoleLogs.slice(-1000);
      }
    });

    page.on('response', (response) => {
      const request = response.request();
      sp.networkRequests.push({
        url: request.url(),
        method: request.method(),
        status: response.status(),
        resourceType: request.resourceType(),
        timestamp: Date.now()
      });
      if (sp.networkRequests.length > 500) {
        sp.networkRequests = sp.networkRequests.slice(-250);
      }
    });

    page.on('crash', () => {
      console.error(`[BrowserManager] space '${sp.name}' 页面崩溃，将在下次请求时重建`);
      sp.page = null;
    });
  }

  public getConsoleLogs(): ConsoleLogEntry[] {
    return [...this.current().consoleLogs];
  }

  public clearConsoleLogs(): void {
    this.current().consoleLogs = [];
  }

  public getNetworkRequests(): NetworkRequestEntry[] {
    return [...this.current().networkRequests];
  }

  public clearNetworkRequests(): void {
    this.current().networkRequests = [];
  }

  public isAlive(): boolean {
    return this.isSpaceAlive(this.current());
  }

  public setActivePage(page: Page): void {
    const sp = this.current();
    sp.page = page;
    this.setupPageListeners(sp, page);
  }

  // ============================================================
  // Task Spaces 管理
  // ============================================================

  /** 当前活跃 space 名 */
  public getActiveSpace(): string {
    return this.activeSpace;
  }

  /** 列出所有 space 及状态 */
  public listSpaces(): { name: string; active: boolean; alive: boolean; url: string | null }[] {
    return [...this.spaces.values()].map((sp) => ({
      name: sp.name,
      active: sp.name === this.activeSpace,
      alive: this.isSpaceAlive(sp),
      url: sp.page && !sp.page.isClosed() ? sp.page.url() : null,
    }));
  }

  /**
   * 新建并切换到一个 space(隔离的 userDataDir → 独立 cookie/登录态)。
   * 已存在同名 space 则直接切过去,不重复创建。
   */
  public async createSpace(name: string): Promise<{ name: string; created: boolean }> {
    const clean = name.trim();
    if (!clean) throw new Error('space 名不能为空');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(clean)) {
      throw new Error('space 名仅允许字母/数字/下划线/连字符,长度 1-40');
    }
    let created = false;
    if (!this.spaces.has(clean)) {
      // 每个 space 一份独立 userDataDir,挂在默认 userDataDir 同级的 spaces/ 下
      const base = path.resolve(this.config.userDataDir);
      const dir = path.join(path.dirname(base), 'spaces', clean);
      this.spaces.set(clean, this.newSpaceState(clean, dir));
      created = true;
    }
    this.activeSpace = clean;
    await this.launchSpace(this.spaces.get(clean)!);
    return { name: clean, created };
  }

  /** 切换活跃 space(必须已存在) */
  public async switchSpace(name: string): Promise<{ name: string }> {
    const clean = name.trim();
    if (!this.spaces.has(clean)) throw new Error(`space '${clean}' 不存在,请先 space_new 创建`);
    this.activeSpace = clean;
    await this.launchSpace(this.spaces.get(clean)!);
    return { name: clean };
  }

  /** 关闭并销毁一个 space(不允许关 default);若关的是当前 space 则回落到 default */
  public async closeSpace(name: string): Promise<{ closed: boolean; active: string }> {
    const clean = name.trim();
    if (clean === DEFAULT_SPACE) throw new Error('default space 不可关闭');
    const sp = this.spaces.get(clean);
    if (!sp) throw new Error(`space '${clean}' 不存在`);
    try { await sp.context?.close(); } catch { /* noop */ }
    this.spaces.delete(clean);
    if (this.activeSpace === clean) this.activeSpace = DEFAULT_SPACE;
    return { closed: true, active: this.activeSpace };
  }

  /** 关闭全部 space 的浏览器上下文 */
  public async close(): Promise<void> {
    for (const sp of this.spaces.values()) {
      if (sp.context) {
        try { await sp.context.close(); } catch { /* noop */ }
        sp.context = null;
        sp.page = null;
        sp.chromiumPid = null;
      }
    }
  }
}

export function getBrowserManager(): BrowserManager {
  return BrowserManager.getInstance();
}

export { BrowserManager };
