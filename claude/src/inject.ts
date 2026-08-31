/**
 * 页面脚本注入 —— 绕开 patchright 失效的 addInitScript。
 *
 * ## 背景:三条注入通道全废,只剩一条
 *
 * 原实现用 `context.addInitScript()` 注入反爬指纹伪装与 console 劫持。实测(2026-08-31,
 * patchright 1.62.2 + 本机 chromium)**它整段从未在页面里执行过**,连带 6 项指纹伪装
 * 全部形同虚设 —— `navigator.webdriver` 直接暴露、`window.chrome` 不存在、plugins 为空,
 * 爬公网站点基本会被当成机器人。而且这不是协议迁移引入的,是一直如此。
 *
 * 逐条实测(用 **DOM 属性**当跨世界信道,避免 page.evaluate 读到隔离世界产生假阴性):
 *
 * | 通道 | 结果 |
 * |---|---|
 * | `context.addInitScript` | ❌ 不执行 |
 * | `page.addInitScript` | ❌ 不执行 |
 * | CDP `Page.enable` + `Page.addScriptToEvaluateOnNewDocument` | 下发成功但 ❌ 不执行 |
 * | **route 拦截 HTML 响应,把 `<script>` 注进 `<head>`** | ✅ **执行,且早于页面自己的脚本** |
 *
 * ⚠️ 排查时差点被带偏:`page.evaluate` 跑在**隔离世界**,主世界设的 `window.X` 它看不见。
 * 所以判断"脚本有没有执行"**必须走 DOM**(跨世界共享),不能用 `page.evaluate` 读全局变量,
 * 否则会把"执行了但读不到"误判成"没执行"。
 *
 * ## console 转发为什么要绕一圈
 *
 * `exposeBinding` 暴露的 `__mcpConsoleLog` **在主世界里是 undefined**(实测),
 * 而我们的脚本只能在主世界跑。所以主世界不能直接调 binding,改成:
 *
 *   主世界 console 劫持 → 写进一个隐藏 DOM 节点(跨世界共享)
 *   → 隔离世界的排空器读走 → 调 binding → Node 端
 *
 * 隐藏节点同时充当**缓冲**:页面早期的日志先攒着,等排空器装好一次性取走,不会丢。
 */

/** 主世界与隔离世界之间传日志用的隐藏节点 id */
export const LOG_BRIDGE_ID = '__mcp_log_bridge__';

/**
 * 主世界注入脚本。**必须是纯字符串**(要塞进 HTML),不能是 TS 函数。
 *
 * 幂等:重复注入只生效一次(SPA 或 route 重放时不会把 console 包两层)。
 */
export const MAIN_WORLD_SRC = `(function(){
  if (window.__mcpInjected) return;
  window.__mcpInjected = true;

  // ── 1. navigator.webdriver -> undefined
  try { delete Navigator.prototype.webdriver; } catch (e) {}
  try { Object.defineProperty(navigator, 'webdriver', { get: function(){ return undefined; } }); } catch (e) {}

  // ── 2. navigator.languages
  try { Object.defineProperty(navigator, 'languages', { get: function(){ return ['zh-CN','zh','en']; } }); } catch (e) {}

  // ── 3. navigator.plugins 非空伪装(空 plugins 是最常被查的自动化特征之一)
  try {
    Object.defineProperty(navigator, 'plugins', { get: function(){
      var arr = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' }
      ];
      arr.item = function(i){ return arr[i]; };
      return arr;
    }});
  } catch (e) {}

  // ── 4. window.chrome
  try { if (!window.chrome) window.chrome = { runtime: {} }; } catch (e) {}

  // ── 5. permissions.query(notifications 返回正常状态,否则是明显的无头特征)
  try {
    var oq = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = function(p){
      return (p && p.name === 'notifications')
        ? Promise.resolve({ state: Notification.permission })
        : oq(p);
    };
  } catch (e) {}

  // ── 6. console 劫持 → 写进 DOM 桥(见文件头:主世界调不到 exposeBinding)
  try {
    var bridgeId = ${JSON.stringify(LOG_BRIDGE_ID)};
    function bridge(){
      var el = document.getElementById(bridgeId);
      if (!el) {
        el = document.createElement('div');
        el.id = bridgeId;
        el.style.display = 'none';
        (document.documentElement || document).appendChild(el);
      }
      return el;
    }
    ['log','info','warn','error','debug'].forEach(function(m){
      var orig = console[m].bind(console);
      console[m] = function(){
        try {
          var args = Array.prototype.slice.call(arguments);
          var text = args.map(function(a){
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch (e) { return String(a); }
          }).join(' ');
          var el = bridge();
          // 每条一个子节点,排空器取走后删除 —— 天然的 FIFO 队列
          var n = document.createElement('i');
          n.setAttribute('data-t', m);
          n.textContent = text;
          el.appendChild(n);
          // 页面自己疯狂打日志时别把 DOM 撑爆(排空器没跟上时的兜底)
          while (el.childNodes.length > 500) el.removeChild(el.firstChild);
        } catch (e) {}
        orig.apply(console, arguments);
      };
    });
  } catch (e) {}
})();`;

/**
 * 隔离世界排空器。由 Node 端在每次导航后 `page.evaluate` 执行,
 * 把 DOM 桥里攒的日志取走并**从 DOM 中删除**(取走即消费,不会重复上报)。
 *
 * 返回值直接是日志数组 —— 走 evaluate 的返回值比再调 binding 少一跳,也更好排错。
 */
export const DRAIN_SRC = `(function(){
  var el = document.getElementById(${JSON.stringify(LOG_BRIDGE_ID)});
  if (!el) return [];
  var out = [];
  while (el.firstChild) {
    var n = el.firstChild;
    out.push({ type: n.getAttribute ? (n.getAttribute('data-t') || 'log') : 'log',
               text: n.textContent || '' });
    el.removeChild(n);
  }
  return out;
})()`;

/** 会挡住内联脚本执行的响应头 —— 注入时必须剥掉,否则脚本进了 DOM 也不跑 */
const HEADERS_TO_STRIP = /^(content-security-policy(-report-only)?|content-length)$/i;

/**
 * 把脚本注进 HTML 响应。
 *
 * 只处理 `document` 类型且 `content-type` 含 `text/html` 的响应,其余一律放行 ——
 * 对图片/JS/CSS 改字节是灾难。
 *
 * ⚠️ 会剥掉 **CSP** 响应头。这是必要代价:站点的 CSP 会拦住我们的内联脚本,
 * 脚本进了 DOM 也不执行(实测)。本服务是自动化浏览器、只绑回环,
 * 但这条要写清楚 —— 它确实降低了被访问页面的安全边界。
 */
export function buildHtmlInjector(sources: string[]) {
  const tag = `<script>${sources.join('\n')}</script>`;
  return async function injectRoute(route: import('patchright').Route): Promise<void> {
    const req = route.request();
    if (req.resourceType() !== 'document') { await route.fallback(); return; }
    try {
      const resp = await route.fetch();
      const headers = resp.headers();
      const ct = headers['content-type'] ?? '';
      if (!ct.includes('text/html')) { await route.fulfill({ response: resp }); return; }

      let body = await resp.text();
      body = /<head[^>]*>/i.test(body)
        ? body.replace(/<head[^>]*>/i, (m) => m + tag)
        : tag + body;

      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) if (!HEADERS_TO_STRIP.test(k)) out[k] = v;

      await route.fulfill({
        status: resp.status(),
        headers: out,
        body,
        contentType: 'text/html; charset=utf-8',
      });
    } catch {
      // 取原响应失败(网络错误/被中断)—— 放行,让浏览器自己去报错,
      // 别因为注入失败就把整个导航吞掉
      await route.fallback().catch(() => { /* 已被别处处理 */ });
    }
  };
}
