/**
 * BrowserManager - 跨平台 Playwright 浏览器单例管理器
 * 支持 macOS / Linux (Debian/Ubuntu) 无头模式
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import type { ConsoleLogEntry, NetworkRequestEntry, BrowserConfig } from './types.js';

const IS_LINUX = process.platform === 'linux';
const IS_MAC = process.platform === 'darwin';

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
  private config: BrowserConfig;

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
    const launchArgs = [
      ...commonArgs,
      ...(IS_LINUX ? linuxArgs : (IS_MAC ? macArgs : [])),
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
        // 平台对应 UA
        userAgent: IS_LINUX
          ? 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
          : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        extraHTTPHeaders: {
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br'
        }
      }
    );

    const pages = this.context.pages();
    this.page = pages[0] ?? await this.context.newPage();
    this.setupPageListeners(this.page);

    return this.context;
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
    }
  }
}

export function getBrowserManager(): BrowserManager {
  return BrowserManager.getInstance();
}

export { BrowserManager };
