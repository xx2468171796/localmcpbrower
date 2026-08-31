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

import { chromium, type BrowserContext, type Page, type Route } from 'patchright';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import type { ConsoleLogEntry, NetworkRequestEntry, BrowserConfig } from './types.js';
import { EGO_HELPER_SRC } from './injected.js';
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
 * 服务安装根目录(dist/ 的上一级)。
 * 默认 userDataDir 必须相对**安装目录**解析而不是 process.cwd():
 * 按 CWD 解析会导致每个项目目录各落一份 profile —— 登录态不共享、storage/ 散落各处。
 * 跨平台一律走 path 模块,不假设分隔符。
 */
const INSTALL_ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');

const DEFAULT_CONFIG: BrowserConfig = {
  // headless 默认开启；Mac 调试时设 HEADLESS=false
  headless: process.env['HEADLESS'] !== 'false',
  userDataDir: process.env['USER_DATA_DIR'] ?? path.join(INSTALL_ROOT, 'storage', 'user_data'),
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
    };
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
    if (sp.context) return sp.context;
    if (!sp.launching) {
      sp.launching = this.doLaunchSpace(sp).finally(() => { sp.launching = null; });
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
    let headless = this.config.headless;
    if (!headless && IS_LINUX && !process.env['DISPLAY'] && !process.env['WAYLAND_DISPLAY']) {
      console.warn('[BrowserManager] 未检测到 DISPLAY/WAYLAND_DISPLAY,HEADLESS=false 自动降级为无头模式(需要窗口请配 Xvfb)');
      headless = true;
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

    // 浏览器被外部关掉(用户点 X / 崩溃)时把 space 打回未启动态,
    // 下次请求自动重建;各会话的日志缓冲保留,只清失效的页面引用。
    context.on('close', () => {
      if (sp.context !== context) return;
      console.log(`[BrowserManager] space '${sp.name}' 浏览器上下文已关闭,将在下次请求时重建`);
      sp.context = null;
      sp.chromiumPid = null;
      for (const st of sp.sessions.values()) {
        st.pages = [];
        st.activeIndex = 0;
      }
    });

    sp.context = context;
    return context;
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
  public listSpaces(): { name: string; active: boolean; alive: boolean; url: string | null }[] {
    const sessionId = currentSessionId();
    const activeName = this.spaceNameFor(sessionId);
    return [...this.spaces.values()].map((sp) => {
      const st = sp.sessions.get(sessionId);
      const page = st?.pages[st.activeIndex];
      return {
        name: sp.name,
        active: sp.name === activeName,
        alive: this.isSpaceAlive(sp),
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
   */
  public async createSpace(name: string): Promise<{ name: string; created: boolean }> {
    const clean = name.trim();
    if (!clean) throw new Error('space 名不能为空');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(clean)) {
      throw new Error('space 名仅允许字母/数字/下划线/连字符,长度 1-40');
    }
    let created = false;
    if (!this.spaces.has(clean)) {
      this.spaces.set(clean, this.newSpaceState(clean, this.spaceDirFor(clean)));
      created = true;
    }
    this.sessionSpace.set(currentSessionId(), clean);
    await this.launchSpace(this.spaces.get(clean)!);
    return { name: clean, created };
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
