/**
 * BrowserManager - 跨平台 Playwright 浏览器单例管理器
 * 支持 macOS / Linux (Debian/Ubuntu) / Windows 无头模式
 * Claude Code 版本
 */

import { chromium, type BrowserContext, type Page } from 'patchright';
import * as path from 'path';
import * as fs from 'fs';
import type { ConsoleLogEntry, NetworkRequestEntry, BrowserConfig } from './types.js';

const IS_LINUX = process.platform === 'linux';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

// Chrome 版本号 token，统一用于各平台 UA 字符串
// patchright 1.60 捆绑 Chrome for Testing 148，UA 需与真实内核版本一致，否则指纹自相矛盾
const CHROME_VERSION = process.env['UA_CHROME_VERSION'] ?? '148.0.0.0';

const DEFAULT_CONFIG: BrowserConfig = {
  // headless 默认开启；Mac 调试时设 HEADLESS=false
  headless: process.env['HEADLESS'] !== 'false',
  userDataDir: process.env['USER_DATA_DIR'] ?? 'storage/user_data',
  viewportWidth: parseInt(process.env['VIEWPORT_WIDTH'] ?? '1280', 10),
  viewportHeight: parseInt(process.env['VIEWPORT_HEIGHT'] ?? '800', 10),
  devtools: process.env['DEVTOOLS'] === 'true',
  slowMo: parseInt(process.env['SLOW_MO'] ?? '0', 10)
};

class BrowserManager {
  private static instance: BrowserManager | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private consoleLogs: ConsoleLogEntry[] = [];
  private networkRequests: NetworkRequestEntry[] = [];
  // 已挂过监听器的页面，防止 switch_tab 来回切换时重复挂载导致日志重复
  private listenedPages = new WeakSet<Page>();
  private config: BrowserConfig;
  // 当前 chromium 子进程 PID — 用于 stdio 模式退出兜底 SIGKILL，防止孤儿
  private chromiumPid: number | null = null;

  private constructor(config: BrowserConfig) {
    this.config = config;
  }

  public static getInstance(config: BrowserConfig = DEFAULT_CONFIG): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager(config);
    }
    return BrowserManager.instance;
  }

  private ensureUserDataDir(): void {
    const dir = path.resolve(this.config.userDataDir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  public async getContext(): Promise<BrowserContext> {
    if (this.context && this.isAlive()) {
      return this.context;
    }

    this.ensureUserDataDir();

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

    this.context = await chromium.launchPersistentContext(
      path.resolve(this.config.userDataDir),
      {
        headless: this.config.headless,
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

    // 反爬虫指纹伪装：在每个页面执行前注入，掩盖常见的自动化检测向量
    await this.context.addInitScript(() => {
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
    });

    // 抓 chromium 子进程 pid — Playwright 内部 API 但多年稳定；失败不影响主流程
    try {
      const browser = this.context.browser();
      const child = (browser as unknown as { _process?: { pid?: number } })?._process;
      this.chromiumPid = child?.pid ?? null;
    } catch {
      this.chromiumPid = null;
    }

    const pages = this.context.pages();
    this.page = pages[0] ?? await this.context.newPage();
    this.setupPageListeners(this.page);

    return this.context;
  }

  /** 返回当前 chromium 进程 PID（无活跃浏览器则 null）— stdio 退出钩子用 */
  public getChromiumPid(): number | null {
    return this.chromiumPid;
  }

  /** 同步 SIGKILL chromium 子进程 — 用于 process.on('exit') / 超时兜底，无 await */
  public killChromiumSync(): void {
    const pid = this.chromiumPid;
    this.chromiumPid = null;
    if (!pid) return;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已死或无权限，无所谓
    }
  }

  public async getPage(): Promise<Page> {
    if (!this.isAlive()) {
      console.log('[BrowserManager] 检测到浏览器/页面已失效，正在重建...');
      this.context = null;
      this.page = null;
    }
    await this.getContext();
    if (!this.page) {
      throw new Error('无法获取页面实例');
    }
    return this.page;
  }

  private setupPageListeners(page: Page): void {
    if (this.listenedPages.has(page)) return;
    this.listenedPages.add(page);
    page.on('console', (msg) => {
      const type = msg.type() as ConsoleLogEntry['type'];
      this.consoleLogs.push({ type, text: msg.text(), timestamp: Date.now() });
      if (this.consoleLogs.length > 2000) {
        this.consoleLogs = this.consoleLogs.slice(-1000);
      }
    });

    page.on('response', (response) => {
      const request = response.request();
      this.networkRequests.push({
        url: request.url(),
        method: request.method(),
        status: response.status(),
        resourceType: request.resourceType(),
        timestamp: Date.now()
      });
      if (this.networkRequests.length > 500) {
        this.networkRequests = this.networkRequests.slice(-250);
      }
    });

    page.on('crash', () => {
      console.error('[BrowserManager] 页面崩溃，将在下次请求时重建');
      this.page = null;
    });
  }

  public getConsoleLogs(): ConsoleLogEntry[] {
    return [...this.consoleLogs];
  }

  public clearConsoleLogs(): void {
    this.consoleLogs = [];
  }

  public getNetworkRequests(): NetworkRequestEntry[] {
    return [...this.networkRequests];
  }

  public clearNetworkRequests(): void {
    this.networkRequests = [];
  }

  public isAlive(): boolean {
    try {
      return this.context !== null && this.page !== null && !this.page.isClosed();
    } catch {
      return false;
    }
  }

  public setActivePage(page: Page): void {
    this.page = page;
    this.setupPageListeners(page);
  }

  public async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
      this.chromiumPid = null;
    }
  }
}

export function getBrowserManager(): BrowserManager {
  return BrowserManager.getInstance();
}

export { BrowserManager };
