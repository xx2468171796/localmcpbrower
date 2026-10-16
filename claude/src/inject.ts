/**
 * 页面主世界脚本:只做一件事 —— **console 捕获**。由 browser.ts preparePage 按页面经 CDP Page.addScriptToEvaluateOnNewDocument 装上。
 *
 * ## 历史:注入通道
 *
 * 2026-08-31(patchright 1.62.2 + headless shell)实测 addInitScript / CDP addScriptToEvaluateOnNewDocument 都不执行,
 * 只好拦 HTML 响应往 `<head>` 里塞 `<script>`。代价很大:文档改由 Node 端代取(TLS 指纹和请求头都不是 Chrome 的),
 * 还要剥 CSP。2026-10-17 复测(patchright 1.63 + 完整版 Chromium):先 Page.enable 再 Page.addScriptToEvaluateOnNewDocument
 * 能原生执行(早于页面脚本、不受 CSP 限制、请求是浏览器自己发的)—— 于是拦 HTML 注入整个删掉(见 document-gate.ts)。
 * 不用 context.addInitScript:它也能执行,但会让跨站 iframe 加载失败(chrome-error),Turnstile / 支付组件都是跨站 iframe。
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
 * - console 方法用 `Proxy` 包:`Function.prototype.toString` 对 Proxy 给出 `[native code]`(但不带函数名,见 consoleCaptureEnabled),`name` / `length` 透传;
 * - 记录时只存参数**引用**,不序列化 —— 真浏览器(没开开发者工具)不会去读日志对象的属性,
 *   当场 JSON.stringify 会触发对象上的 getter,这是检测 CDP / 自动化的经典手法;取日志时也只读数据属性、不调 getter;
 * - 不设全局变量、不插 DOM 节点;
 * - 取日志:隔离世界派发一个**随机名字**的 CustomEvent,主世界监听到后把日志 JSON(字符串能跨世界)
 *   放进应答事件的 detail 里同步派发回去。事件名每个页面各自随机,页面猜不到、不同工作区之间也关联不起来;
 *   用到的原生函数在注入那一刻先拿住,页面之后再改原型也影响不到。
 * - 早期日志先攒在闭包里(最多 500 条),等排空器来取,不会丢。
 */

import { randomBytes } from 'node:crypto';

/**
 * 装不装 console 捕获(BROWSER_CONSOLE_CAPTURE=off 关掉)。已知取舍:Proxy 包过的 console.log 的 toString 是
 * `function () { [native code] }`,真 Chrome 是 `function log() { [native code] }` —— 一行就能查出来。
 * 别的路更糟:在我们的 CDP 会话上开 Runtime.enable 拿日志,页面一打日志就会调 Error.prepareStackTrace(经典 CDP 检测,
 * 2026-10-17 实测),所以默认仍装;对隐身要求最高的场景关掉它(get_console_logs 就拿不到页面日志了)。
 */
export function consoleCaptureEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return !/^(off|0|false|no)$/i.test((env['BROWSER_CONSOLE_CAPTURE'] ?? '').trim());
}

/**
 * 主世界脚本(每个页面一个随机事件名,见 browser.ts preparePage)。每个文档执行一次,不需要防重复的全局标记。
 * 取日志时只读对象自己的数据属性(属性描述符的 value),**不调用 getter**:真 Chrome 没开开发者工具时不会碰日志对象,
 * 调了 getter 就是检测点;而且 getter 在我们的请求事件里跑,能从 window.event 读到事件名。
 * 残余:页面传进来的 Proxy 对象,枚举键时它的 ownKeys / getOwnPropertyDescriptor 陷阱仍会被触发(见 docs/architecture.md §12)。
 */
export function mainWorldSrc(evt: string): string {
  const req = JSON.stringify(evt + 'q');
  const res = JSON.stringify(evt + 's');
  return `(function(){
  'use strict';
  var P = Proxy, R = Reflect, CE = CustomEvent, add = EventTarget.prototype.addEventListener,
      fire = EventTarget.prototype.dispatchEvent, keys = Object.keys, gopd = Object.getOwnPropertyDescriptor,
      proto = Object.getPrototypeOf, str = JSON.stringify, isArr = Array.isArray, Err = Error, doc = document;
  var buf = [];
  function own(o, k) {
    try { var d = gopd(o, k); return d && 'value' in d ? d.value : undefined; } catch (e) { return undefined; }
  }
  function inherited(o, k) {
    for (var p = o, i = 0; p && i < 10; p = proto(p), i++) { var v = own(p, k); if (v !== undefined) return v; }
    return undefined;
  }
  function show(a, depth) {
    if (a === null || a === undefined) return String(a);
    var t = typeof a;
    if (t === 'string') return a;
    if (t === 'function') return '[function]';
    if (t !== 'object') return String(a);
    try {
      if (a instanceof Err) return String(inherited(a, 'name') || 'Error') + ': ' + String(own(a, 'message') || '');
      if (depth > 1) return isArr(a) ? '[array]' : '[object]';
      var ks = keys(a).slice(0, 50), o = isArr(a) ? [] : {};
      for (var i = 0; i < ks.length; i++) {
        var d = gopd(a, ks[i]);
        var v = d && 'value' in d ? d.value : '[getter]';
        o[ks[i]] = (v && typeof v === 'object') ? show(v, depth + 1) : (typeof v === 'function' ? '[function]' : v);
      }
      return str(o);
    } catch (e) { return '[object]'; }
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
  add.call(doc, ${req}, function(){
    var rows = buf.splice(0, buf.length).map(function(r){
      var parts = [];
      for (var i = 0; i < r[1].length; i++) parts.push(show(r[1][i], 0));
      return { type: r[0], text: parts.join(' ').slice(0, 5000) };
    });
    fire.call(doc, new CE(${res}, { detail: str(rows) }));
  });
})();`;
}

/**
 * 隔离世界排空器。由 Node 端在需要时 `page.evaluate` 执行:派发请求事件,同步收到主世界的应答,取走即清空。
 * 页面上没有这段脚本(非 HTML 文档等)时没人应答,返回空数组。应答内容页面能伪造,Node 端还要校验 / 截断(drainPageLogs)。
 */
export function drainSrc(evt: string): string {
  const req = JSON.stringify(evt + 'q');
  const res = JSON.stringify(evt + 's');
  return `(function(){
  var got = '[]';
  function on(e){ got = typeof e.detail === 'string' ? e.detail.slice(0, 3000000) : '[]'; }
  document.addEventListener(${res}, on);
  try { document.dispatchEvent(new CustomEvent(${req})); }
  finally { document.removeEventListener(${res}, on); }
  try { return JSON.parse(got); } catch (e) { return []; }
})()`;
}

/** 给一个页面生成事件名(随机,页面猜不到;每页不同,不同工作区 / 代理之间也就关联不起来) */
export function newConsoleEvent(): string {
  return 'e' + randomBytes(8).toString('hex');
}
