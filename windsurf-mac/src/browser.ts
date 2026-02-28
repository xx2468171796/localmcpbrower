/**
 * BrowserManager - Playwright 浏览器单例管理器
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import type { ConsoleLogEntry, NetworkRequestEntry, BrowserConfig } from './types.js';

const DEFAULT_CONFIG: BrowserConfig = {
  headless: process.env['HEADLESS'] === 'true',
  userDataDir: process.env['USER_DATA_DIR'] ?? 'storage/user_data',
  viewportWidth: parseInt(process.env['VIEWPORT_WIDTH'] ?? '1920', 10),
  viewportHeight: parseInt(process.env['VIEWPORT_HEIGHT'] ?? '1080', 10),
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

    const launchArgs = [
      // 反自动化检测
      '--disable-blink-features=AutomationControlled',
      // 沙箱 & 安全（macOS 不需要 setuid-sandbox）
      '--no-sandbox',
      '--no-first-run',
      '--no-default-browser-check',
      // 内存 & 进程优化
      '--disable-dev-shm-usage',
      '--disable-breakpad',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--js-flags=--max-old-space-size=512',
      // 禁用不必要的后台服务（加速启动）
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
      // 网络优化
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--aggressive-cache-discard',
      // 渲染优化（macOS Metal）
      '--force-color-profile=srgb',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      // 其他
      '--metrics-recording-only',
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
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
        // 伪装真实浏览器 UA
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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
