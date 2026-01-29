/**
 * BrowserManager - Playwright 浏览器单例管理器
 * @description 负责浏览器实例的生命周期管理、日志收集、网络监控
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import * as path from 'path';
import * as fs from 'fs';
import type { ConsoleLogEntry, NetworkRequestEntry, BrowserConfig } from './types.js';

/** 默认配置 */
const DEFAULT_CONFIG: BrowserConfig = {
  headless: process.env['HEADLESS'] === 'true',
  userDataDir: process.env['USER_DATA_DIR'] ?? 'storage/user_data',
  viewportWidth: parseInt(process.env['VIEWPORT_WIDTH'] ?? '1280', 10),
  viewportHeight: parseInt(process.env['VIEWPORT_HEIGHT'] ?? '720', 10),
  devtools: process.env['DEVTOOLS'] === 'true',
  slowMo: parseInt(process.env['SLOW_MO'] ?? '0', 10)
};

/** 浏览器管理器单例 */
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

  /** 获取单例实例 */
  public static getInstance(config: BrowserConfig = DEFAULT_CONFIG): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager(config);
    }
    return BrowserManager.instance;
  }

  /** 确保用户数据目录存在 */
  private ensureUserDataDir(): void {
    const dir = path.resolve(this.config.userDataDir);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** 获取或创建浏览器上下文 */
  public async getContext(): Promise<BrowserContext> {
    if (this.context && this.isAlive()) {
      return this.context;
    }

    this.ensureUserDataDir();

    // 构建启动参数
    const launchArgs = [
      // 性能优化参数
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
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
      // 内存优化
      '--js-flags=--max-old-space-size=512'
    ];

    // 如果启用 DevTools，添加远程调试端口
    if (this.config.devtools) {
      launchArgs.push('--auto-open-devtools-for-tabs');
      launchArgs.push('--remote-debugging-port=9222');
    }

    this.context = await chromium.launchPersistentContext(
      path.resolve(this.config.userDataDir),
      {
        headless: this.config.headless,
        slowMo: this.config.slowMo,
        viewport: {
          width: this.config.viewportWidth,
          height: this.config.viewportHeight
        },
        args: launchArgs,
        ignoreDefaultArgs: ['--enable-automation']
      }
    );

    // 获取或创建页面
    const pages = this.context.pages();
    this.page = pages[0] ?? await this.context.newPage();

    // 设置事件监听
    this.setupPageListeners(this.page);

    return this.context;
  }

  /** 获取当前活动页面 */
  public async getPage(): Promise<Page> {
    await this.getContext();
    if (!this.page) {
      throw new Error('无法获取页面实例');
    }
    return this.page;
  }

  /** 设置页面事件监听 */
  private setupPageListeners(page: Page): void {
    // 监听控制台输出
    page.on('console', (msg) => {
      const type = msg.type() as ConsoleLogEntry['type'];
      this.consoleLogs.push({
        type,
        text: msg.text(),
        timestamp: Date.now()
      });

      // 限制日志数量，防止内存溢出
      if (this.consoleLogs.length > 1000) {
        this.consoleLogs = this.consoleLogs.slice(-500);
      }
    });

    // 监听网络请求
    page.on('response', (response) => {
      const request = response.request();
      this.networkRequests.push({
        url: request.url(),
        method: request.method(),
        status: response.status(),
        resourceType: request.resourceType(),
        timestamp: Date.now()
      });

      // 限制请求数量
      if (this.networkRequests.length > 500) {
        this.networkRequests = this.networkRequests.slice(-250);
      }
    });

    // 监听页面崩溃
    page.on('crash', () => {
      console.error('[BrowserManager] 页面崩溃，将在下次请求时重建');
      this.page = null;
    });
  }

  /** 获取控制台日志 */
  public getConsoleLogs(): ConsoleLogEntry[] {
    return [...this.consoleLogs];
  }

  /** 清空控制台日志 */
  public clearConsoleLogs(): void {
    this.consoleLogs = [];
  }

  /** 获取网络请求 */
  public getNetworkRequests(): NetworkRequestEntry[] {
    return [...this.networkRequests];
  }

  /** 清空网络请求 */
  public clearNetworkRequests(): void {
    this.networkRequests = [];
  }

  /** 检查浏览器是否存活 */
  public isAlive(): boolean {
    try {
      return this.context !== null && this.page !== null && !this.page.isClosed();
    } catch {
      return false;
    }
  }

  /** 关闭浏览器 */
  public async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
  }
}

/** 导出单例获取函数 */
export function getBrowserManager(): BrowserManager {
  return BrowserManager.getInstance();
}

export { BrowserManager };
