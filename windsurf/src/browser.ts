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
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-breakpad',
      '--disable-component-extensions-with-background-pages',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-hang-monitor',
      '--disable-ipc-flooding-protection',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-renderer-backgrounding',
      '--disable-sync',
      '--enable-features=NetworkService,NetworkServiceInProcess',
      '--force-color-profile=srgb',
      '--metrics-recording-only',
      '--password-store=basic',
      '--use-mock-keychain',
      '--js-flags=--max-old-space-size=2048',
      '--enable-gpu-rasterization',
      '--enable-zero-copy',
      '--enable-features=VaapiVideoDecoder',
      '--ignore-gpu-blocklist',
      '--disable-gpu-driver-bug-workarounds',
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
        ignoreDefaultArgs: ['--enable-automation']
      }
    );

    const pages = this.context.pages();
    this.page = pages[0] ?? await this.context.newPage();
    this.setupPageListeners(this.page);

    return this.context;
  }

  public async getPage(): Promise<Page> {
    if (!this.isAlive()) {
      console.log('[BrowserManager] 检测到浏览�?页面已失效，正在重建...');
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
