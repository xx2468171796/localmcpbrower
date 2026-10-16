/**
 * 页面主世界脚本:只做一件事 —— **console 捕获**。由 browser.ts 用 `context.addInitScript` 装上。
 *
 * ## 历史:注入通道
 *
 * 2026-08-31(patchright 1.62.2 + headless shell)实测 addInitScript / CDP addScriptToEvaluateOnNewDocument 都不执行,
 * 只好拦 HTML 响应往 `<head>` 里塞 `<script>`。代价很大:文档改由 Node 端代取(TLS 指纹和请求头都不是 Chrome 的),
 * 还要剥 CSP。2026-10-17 复测(patchright 1.63 + 完整版 Chromium):`context.addInitScript` 原生执行,
 * 早于页面脚本、不受 CSP 限制、iframe 里也有、请求是浏览器自己发的 —— 于是拦 HTML 注入整个删掉(见 document-gate.ts)。
 *
 * ⚠️ `page.evaluate` 跑在**隔离世界**,主世界设的 `window.X` 它看不见;判断脚本有没有执行要走 DOM 或事件(跨世界共享)。
 *
 * ## 为什么不再做指纹伪装(docs/architecture.md §12)
 *
 * 以前这里还改 navigator.webdriver / languages / plugins、补 window.chrome、包 permissions.query。
 * 体检(test/stealth-check.mjs)显示这些**全是破绽**:navigator 上多出自有属性、plugins 是普通数组、
 * webdriver 成了 undefined(真 Chrome 是 false)、函数 toString 不是原生。完整版 Chromium(有头 / 新无头)
 * 本来就是 webdriver=false、5 个 PDF 插件、完整的 window.chrome —— 什么都不改才最像真浏览器。
 *
 * ## console 捕获怎么做到不留痕迹
 *
 * patchright 禁用了 CDP Console 域(开了会被检测),page.on('console') 收不到页面日志,只能在主世界里接:
 * - console 方法用 `Proxy` 包:`Function.prototype.toString` 对 Proxy 照样给出 `[native code]`,`name` / `length` 透传;
 * - 记录时只存参数**引用**,不序列化 —— 真浏览器(没开开发者工具)不会去读日志对象的属性,
 *   当场 JSON.stringify 会触发对象上的 getter,这是检测 CDP / 自动化的经典手法;取日志时才有界地序列化;
 * - 不设全局变量、不插 DOM 节点;
 * - 取日志:隔离世界派发一个**随机名字**的 CustomEvent,主世界监听到后把日志 JSON(字符串能跨世界)
 *   放进应答事件的 detail 里同步派发回去。事件名每个服务进程随机生成,页面猜不到;
 *   用到的原生函数在注入那一刻先拿住,页面之后再改原型也影响不到。
 * - 早期日志先攒在闭包里(最多 500 条),等排空器来取,不会丢。
 */

import { randomBytes } from 'node:crypto';

/** 这次服务进程里请求 / 应答日志用的事件名(随机,页面猜不到) */
const EVT = 'e' + randomBytes(8).toString('hex');
const EVT_REQ = EVT + 'q';
const EVT_RES = EVT + 's';

/** 主世界脚本。每个文档执行一次(addInitScript 按文档执行),所以不需要防重复的全局标记 */
export const MAIN_WORLD_SRC = `(function(){
  var P = Proxy, R = Reflect, CE = CustomEvent, add = EventTarget.prototype.addEventListener,
      fire = EventTarget.prototype.dispatchEvent, keys = Object.keys, str = JSON.stringify, tag = Object.prototype.toString,
      isArr = Array.isArray, doc = document;
  var buf = [];
  function show(a, depth) {
    if (a === null || a === undefined) return String(a);
    var t = typeof a;
    if (t === 'string') return a;
    if (t !== 'object' && t !== 'function') return String(a);
    try {
      if (a instanceof Error) return (a.name || 'Error') + ': ' + a.message;
      if (t === 'function' || depth > 1) return tag.call(a);
      var ks = keys(a).slice(0, 50), o = isArr(a) ? [] : {};
      for (var i = 0; i < ks.length; i++) { var v = a[ks[i]]; o[ks[i]] = (v && typeof v === 'object') ? show(v, depth + 1) : v; }
      return str(o);
    } catch (e) { return tag.call(a); }
  }
  ['log','info','warn','error','debug'].forEach(function(m){
    var orig = console[m];
    if (typeof orig !== 'function') return;
    console[m] = new P(orig, { apply: function(target, self, args){
      if (buf.length >= 500) buf.shift();
      buf.push([m, args]);
      return R.apply(target, self, args);
    }});
  });
  add.call(doc, ${JSON.stringify(EVT_REQ)}, function(){
    var rows = buf.splice(0, buf.length).map(function(r){
      var parts = [];
      for (var i = 0; i < r[1].length; i++) parts.push(show(r[1][i], 0));
      return { type: r[0], text: parts.join(' ').slice(0, 5000) };
    });
    fire.call(doc, new CE(${JSON.stringify(EVT_RES)}, { detail: str(rows) }));
  });
})();`;

/**
 * 隔离世界排空器。由 Node 端在需要时 `page.evaluate` 执行:派发请求事件,同步收到主世界的应答,取走即清空。
 * 页面上没有这段脚本(非 HTML 文档等)时没人应答,返回空数组。
 */
export const DRAIN_SRC = `(function(){
  var got = '[]';
  function on(e){ got = typeof e.detail === 'string' ? e.detail : '[]'; }
  document.addEventListener(${JSON.stringify(EVT_RES)}, on);
  try { document.dispatchEvent(new CustomEvent(${JSON.stringify(EVT_REQ)})); }
  finally { document.removeEventListener(${JSON.stringify(EVT_RES)}, on); }
  try { return JSON.parse(got); } catch (e) { return []; }
})()`;
