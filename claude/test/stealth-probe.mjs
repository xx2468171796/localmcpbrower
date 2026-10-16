/**
 * 隐身体检的探针页(stealth-check.mjs 用):一张本地页面,在页面自己的主世界里查一遍「看得出是自动化浏览器」的特征,
 * 结果写进 <pre id="out">(JSON)。服务端把收到的请求头一起写进页面,好比对「JS 里看到的」和「网络上发出去的」是否一致。
 *
 * 每项结果:{ id, ok, value, note }。ok=false 的就是破绽。只查真浏览器上有确定答案的项,
 * 环境相关、没有对错的(时区、核数)记 ok=null 只报数值。
 */

/** 页面里跑的检查脚本(纯字符串,放进带 nonce 的 <script>) */
const PROBE_SRC = String.raw`
(function () {
  var out = [];
  function add(id, ok, value, note) { out.push({ id: id, ok: ok, value: value, note: note || '' }); }
  function isNative(fn) {
    try { return /\{\s*\[native code\]\s*\}$/.test(Function.prototype.toString.call(fn)); } catch (e) { return false; }
  }
  var hdr = JSON.parse(document.getElementById('hdr').textContent);
  var ua = navigator.userAgent;

  // ── 自动化标记
  add('webdriver=false', navigator.webdriver === false, String(navigator.webdriver), '真 Chrome 是 false,不是 undefined');
  var wd = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
  add('webdriver getter 原生', !!(wd && wd.get && isNative(wd.get)), wd ? typeof wd.get : 'none');
  var own = Object.getOwnPropertyNames(navigator);
  add('navigator 无自有属性', own.length === 0, own.join(','), '在 navigator 实例上 defineProperty 会留下自有属性');
  add('plugins 是 PluginArray', navigator.plugins instanceof PluginArray, Object.prototype.toString.call(navigator.plugins));
  add('plugins 非空', navigator.plugins.length > 0, String(navigator.plugins.length));
  add('mimeTypes 非空', navigator.mimeTypes.length > 0, String(navigator.mimeTypes.length));
  add('window.chrome 完整', !!(window.chrome && typeof window.chrome.loadTimes === 'function' && typeof window.chrome.csi === 'function'),
    window.chrome ? Object.keys(window.chrome).join(',') : 'none', '新无头 / 有头有 loadTimes、csi;只补一个 {runtime:{}} 反而可疑');
  add('permissions.query 原生', isNative(navigator.permissions.query), '');
  add('console.log 原生', isNative(console.log), Function.prototype.toString.call(console.log).slice(0, 60));
  add('Function.toString 原生', isNative(Function.prototype.toString), '');

  // ── 注入痕迹
  var globals = Object.getOwnPropertyNames(window).filter(function (k) { return /mcp|__ego|playwright|patchright|cdc_|puppeteer/i.test(k); });
  add('无可疑全局变量', globals.length === 0, globals.join(','));
  add('无注入 DOM 节点', !document.querySelector('[id^="__mcp"]'), '');
  add('页面脚本数没多', document.scripts.length === 3, String(document.scripts.length), '本页自己只有 3 个 script(数据 + canary + 本脚本)');
  add('CSP 没被剥掉', !window.__cspCanaryRan, window.__cspCanaryRan ? '无 nonce 的内联脚本跑了' : '', '剥 CSP 会让站点的 CSP 失效,也会被察觉');

  // ── UA / Client Hints / 请求头一致性
  add('UA 不含 Headless', !/headless/i.test(ua) && !/headless/i.test(hdr['user-agent'] || ''), ua);
  add('JS UA = 请求头 UA', ua === hdr['user-agent'], hdr['user-agent']);
  var major = (ua.match(/Chrome\/(\d+)/) || [])[1];
  var brands = navigator.userAgentData ? navigator.userAgentData.brands : [];
  var bMajor = (brands.filter(function (b) { return /Chrom/.test(b.brand); })[0] || {}).version;
  add('UA 版本 = Client Hints 版本', !!major && major === bMajor, major + ' / ' + bMajor);
  var uaPlat = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux|X11/.test(ua) ? 'Linux' : '?';
  var chPlat = navigator.userAgentData ? navigator.userAgentData.platform : '?';
  var navPlat = navigator.platform;
  var navPlatOk = uaPlat === 'Windows' ? /^Win/.test(navPlat) : uaPlat === 'macOS' ? /^Mac/.test(navPlat) : /Linux/.test(navPlat);
  add('平台三处一致', uaPlat === chPlat && navPlatOk, uaPlat + ' / ' + chPlat + ' / ' + navPlat);
  add('请求头带 sec-ch-ua', !!hdr['sec-ch-ua'] && hdr['sec-ch-ua'].indexOf(bMajor) >= 0, hdr['sec-ch-ua'] || 'none');
  add('Accept-Encoding 与真 Chrome 一致', /zstd/.test(hdr['accept-encoding'] || ''), hdr['accept-encoding'] || '', '真 Chrome 123+ 发 gzip, deflate, br, zstd');
  var al = (hdr['accept-language'] || '').split(',')[0].split(';')[0];
  add('语言三处一致', al === navigator.languages[0] && al === navigator.language,
    al + ' / ' + navigator.languages.join(',') + ' / ' + navigator.language);

  // ── 无头特征
  var np = Notification.permission;
  navigator.permissions.query({ name: 'notifications' }).then(function (r) {
    add('通知权限前后一致', !(np === 'denied' && r.state === 'prompt'), np + ' / ' + r.state, '经典无头特征:denied 配 prompt');
    finish();
  }, function () { add('通知权限前后一致', false, 'query 失败'); finish(); });
  var earlyOuter = window.outerWidth + 'x' + window.outerHeight;
  add('屏幕不小于窗口', screen.width >= window.innerWidth && screen.height >= window.innerHeight, screen.width + 'x' + screen.height);
  add('有任务栏(availHeight < height)', screen.availHeight < screen.height, screen.availHeight + ' / ' + screen.height, '无头多为相等;仅供参考');

  // ── GPU / 字体 / emoji
  try {
    var gl = document.createElement('canvas').getContext('webgl');
    var dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    var r = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl ? 'no debug ext' : 'no webgl');
    add('WebGL 可用', !!gl, r);
    // 没显卡的机器(工位机 / 服务器)只能软件渲染,代码改不了(JS 改渲染器名又是谎言):只报不判,看到 SwiftShader 就知道这台机器有这个硬特征
    add('显卡渲染(软件渲染只报不判)', /swiftshader|llvmpipe|softpipe|software/i.test(r) ? null : !!gl, r);
  } catch (e) { add('WebGL 可用', false, String(e)); }
  var c = document.createElement('canvas').getContext('2d');
  function width(font, text) { c.font = font; return c.measureText(text).width; }
  var probeText = 'mmmmmmmmmmlli中文字体测试';
  var fonts = ['Arial', 'Times New Roman', 'Courier New', 'Segoe UI', 'Calibri', 'Microsoft YaHei', 'SimSun', 'PingFang SC', 'Noto Sans CJK SC', 'WenQuanYi Micro Hei'];
  var have = fonts.filter(function (f) {
    return ['monospace', 'serif', 'sans-serif'].some(function (b) { return width('32px "' + f + '",' + b, probeText) !== width('32px ' + b, probeText); });
  });
  add('常见字体', null, have.length + '/' + fonts.length + ': ' + have.join(','));
  // 「中」画出来和缺字的豆腐块(U+FFFF)像素不同 = 有中文字体(按宽度比会误判:两者常常一样宽)
  function glyph(ch) {
    var g = document.createElement('canvas'); g.width = g.height = 40;
    var x = g.getContext('2d'); x.font = '32px sans-serif'; x.textBaseline = 'top'; x.fillText(ch, 2, 2);
    return Array.prototype.join.call(x.getImageData(0, 0, 40, 40).data, ',');
  }
  add('有中文字体', glyph('中') !== glyph('￿'), '');
  var ec = document.createElement('canvas'); ec.width = ec.height = 40;
  var ex = ec.getContext('2d'); ex.font = '32px sans-serif'; ex.textBaseline = 'top'; ex.fillText('😀', 2, 2);
  var px = ex.getImageData(0, 0, 40, 40).data, colored = 0;
  for (var i = 0; i < px.length; i += 4) if (px[i + 3] > 0 && (Math.abs(px[i] - px[i + 1]) > 30 || Math.abs(px[i + 1] - px[i + 2]) > 30)) colored++;
  add('彩色 emoji', colored > 20, String(colored));

  // ── 环境数值(没有对错,只报)
  add('时区', null, Intl.DateTimeFormat().resolvedOptions().timeZone + ' / UTC' + (-new Date().getTimezoneOffset() / 60));
  add('核数 / 内存', null, navigator.hardwareConcurrency + ' / ' + navigator.deviceMemory);

  // ── CDP 泄漏:开了 Runtime.enable 的自动化会去序列化 console 参数,触发 stack 的 getter
  var leaked = false;
  var err = new Error('probe');
  Object.defineProperty(err, 'stack', { get: function () { leaked = true; return ''; } });
  console.debug(err);

  // ── Worker 里看到的和页面一致(按页面下发的 UA 覆盖管不到 Worker,检测站会专门去 Worker 里对比)
  var pending = 3;
  try {
    var sw = new SharedWorker('/probe-worker.js?shared');
    sw.port.onmessage = function (e) { add('SharedWorker UA = 页面 UA', e.data.ua === ua, e.data.ua); finish(); };
    sw.port.postMessage(1);
  } catch (e) { add('SharedWorker UA = 页面 UA', null, '不支持:' + e); finish(); }
  try {
    var w = new Worker('/probe-worker.js');
    w.onmessage = function (e) {
      var d = e.data, main = navigator.userAgentData;
      add('Worker UA = 页面 UA', d.ua === ua, d.ua);
      add('Worker 平台 = 页面平台', !!main && d.plat === main.platform, d.plat);
      main.getHighEntropyValues(['platformVersion', 'fullVersionList']).then(function (h) {
        // Linux 上真 Chrome 原生 platformVersion 就是空的,只在 Windows / macOS 上要求非空
        add('页面高熵 Client Hints 非空', (!!h.platformVersion || main.platform === 'Linux') && h.fullVersionList.length > 0,(h.platformVersion || '空') + ' | ' + h.fullVersionList.map(function (b) { return b.brand + '/' + b.version; }).join(','), '真 Chrome 有真实的系统版本和完整版本号');
        add('Worker 高熵 Client Hints = 页面', d.pv === h.platformVersion, (d.pv || '空') + ' / ' + (h.platformVersion || '空'), '自定义 UA 时 Worker 的高熵值可能为空');
        finish();
      });
    };
    w.postMessage(1);
  } catch (e) { add('Worker UA = 页面 UA', false, String(e)); finish(); }
  function finish() {
    if (--pending > 0) return;
    setTimeout(function () {
      add('无 CDP Runtime 泄漏', !leaked, String(leaked));
      add('窗口有边框(outer > inner)', window.outerWidth > 0 && window.outerHeight > window.innerHeight,
        window.outerWidth + 'x' + window.outerHeight + ' / inner ' + window.innerWidth + 'x' + window.innerHeight + ' / 解析时 ' + earlyOuter);
      var pre = document.createElement('pre'); pre.id = 'out'; pre.textContent = JSON.stringify(out);
      document.body.appendChild(pre);
    }, 300);
  }
})();`;

/** 生成探针页。nonce 固定(只是测试页);canary 是没带 nonce 的内联脚本:CSP 还在就不会跑(它也算在 document.scripts 里) */
export function probeHtml(headers) {
  const nonce = 'stealthprobe';
  const hdr = JSON.stringify(headers).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"><title>stealth probe</title>
<script type="application/json" id="hdr">${hdr}</script>
<script>window.__cspCanaryRan = true</script>
<script nonce="${nonce}">${PROBE_SRC}</script>
</head><body><h1>probe</h1></body></html>`;
}

/** 探针页起的 Worker:报回 Worker 里看到的 UA、平台、高熵 platformVersion */
export const PROBE_WORKER_JS = `function report(reply) {
  var d = navigator.userAgentData;
  d.getHighEntropyValues(['platformVersion']).then(function (h) {
    reply({ ua: navigator.userAgent, plat: d.platform, pv: h.platformVersion });
  });
}
onmessage = function () { report(postMessage); };
onconnect = function (e) { var p = e.ports[0]; p.onmessage = function () { report(function (m) { p.postMessage(m); }); }; };`;

/** 探针页的 CSP:只许带 nonce 的脚本和同源脚本文件(Worker),内联的 canary 被拦 */
export const PROBE_CSP = "script-src 'nonce-stealthprobe' 'self'";
