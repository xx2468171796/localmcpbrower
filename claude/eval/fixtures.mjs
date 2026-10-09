/**
 * 考卷用的本地测试页(不连外网,结果稳定)。起两个端口:
 *   - main:  http://127.0.0.1:<A>   绝大多数页面
 *   - other: http://localhost:<B>   跨站 iframe 的内页(主机名不同 = 不同站点,Chromium 会放进独立进程)
 * 服务端记下每个路径被请求了几次(hits),下载 / 批量抓取类任务据此核对「真的发出了请求」。
 * 这个文件属于裁判层(.ankotti/evolve.json protected),AI 改进流程不得修改。
 */
import http from 'node:http';

const html = (title, body, head = '') =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`;

const ARTICLE_PARAS = [
  '考卷文章第一段：浏览器自动化评测需要固定的页面，外站改版会让结果随机失败。',
  'The second paragraph explains that deterministic fixtures make regressions visible and comparable across versions.',
  '第三段：正文抽取应当去掉导航、侧栏、页脚和广告，只留下标题与段落。',
  'A fourth paragraph adds enough words so that readability heuristics treat this block as the main article content.',
  '第五段：结尾标记 ARTICLE-END-MARKER 用来核对抽取是否完整。',
];

function mainPages(other) {
  return {
    '/': html('评测首页', '<h1>Eval Home</h1><a href="/form">表单</a> <a href="/list/1">列表</a> <a href="/article">文章</a>'),
    '/form': html('表单页', `
      <h1>表单</h1>
      <label for="name">姓名</label><input id="name" name="name">
      <label for="email">邮箱</label><input id="email" type="email">
      <select id="city"><option value="">请选择</option><option value="bj">北京</option><option value="sh">上海</option><option value="sz">深圳</option></select>
      <label><input type="checkbox" id="agree"> 同意</label>
      <textarea id="note"></textarea>
      <button id="submit" type="button">提交</button>
      <div id="out">未提交</div>
      <script>
        document.getElementById('submit').addEventListener('click', function () {
          var v = { name: document.getElementById('name').value, email: document.getElementById('email').value,
            city: document.getElementById('city').value, agree: document.getElementById('agree').checked,
            note: document.getElementById('note').value };
          document.getElementById('out').textContent = 'SUBMITTED:' + JSON.stringify(v);
        });
      </script>`),
    '/list/1': listPage(1),
    '/list/2': listPage(2),
    '/list/3': listPage(3),
    '/article': html('Eval Article Title', `
      <nav class="site-nav"><a href="/">首页</a> <a href="/form">表单</a> NAV-NOISE</nav>
      <aside class="sidebar">SIDEBAR-AD 广告位 广告位</aside>
      <article><h1>Eval Article Title</h1><p class="byline">By Eval Author</p>
        ${ARTICLE_PARAS.map((p) => `<p>${p}</p>`).join('\n')}
      </article>
      <footer>FOOTER-NOISE 版权所有</footer>`),
    '/frames': html('框架页', `
      <h1>Frames</h1>
      <iframe id="same" src="/frame-inner" width="400" height="120"></iframe>
      <iframe id="cross" src="${other}/cross-inner" width="400" height="120"></iframe>`),
    '/frame-inner': html('同源内页', `
      <button id="inner-btn" type="button">同源按钮</button><span id="inner-out">INNER-IDLE</span>
      <script>document.getElementById('inner-btn').onclick = function () { document.getElementById('inner-out').textContent = 'INNER-CLICKED'; };</script>`),
    '/upload': html('上传页', `
      <input type="file" id="file"><div id="file-out">NO-FILE</div>
      <script>
        document.getElementById('file').addEventListener('change', function (e) {
          var f = e.target.files[0]; var r = new FileReader();
          r.onload = function () { document.getElementById('file-out').textContent = 'FILE:' + f.name + ':' + r.result; };
          r.readAsText(f);
        });
      </script>`),
    '/download': html('下载页', '<a id="dl" href="/files/report.csv" download>下载报表</a><div id="dl-out">DL-PAGE</div>'),
    '/dynamic': html('动态页', `
      <div id="root">LOADING</div>
      <script>setTimeout(function () {
        document.getElementById('root').innerHTML = '<ul>' + ['甲', '乙', '丙'].map(function (t) { return '<li class="dyn">' + t + '</li>'; }).join('') + '</ul>';
      }, 700);
      setTimeout(function () { var s = document.getElementById('spinner'); if (s) s.remove(); }, 900);</script>
      <div id="spinner">SPINNER</div>`),
    '/links': html('链接页', `
      <div id="nav"><a href="/a">A 页</a><a href="/b">B 页</a></div>
      <div id="content"><a href="https://outside.example/x" title="外链">外链</a><a href="/docs/guide">指南</a><a href="/docs/api">接口</a></div>`),
    '/table': html('表格页', `
      <table id="t"><thead><tr><th>名称</th><th>价格</th></tr></thead><tbody>
      ${[['苹果', '3.5', 'p1'], ['香蕉', '2.0', 'p2'], ['樱桃', '18.8', 'p3'], ['榴莲', '66.6', 'p4']]
        .map(([n, p, id]) => `<tr class="row" data-id="${id}"><td class="n"><a href="/item/${id}">${n}</a></td><td class="p">${p}</td></tr>`).join('')}
      </tbody></table>`),
    '/a': html('Page A', '<h1>Alpha</h1><p class="v">VALUE-A</p>'),
    '/b': html('Page B', '<h1>Bravo</h1><p class="v">VALUE-B</p>'),
    '/c': html('Page C', '<h1>Charlie</h1><p class="v">VALUE-C</p>'),
    '/hover': html('悬停页', `
      <div id="menu" style="padding:20px;border:1px solid #ccc">菜单</div><div id="hover-out">HOVER-NO</div>
      <script>document.getElementById('menu').addEventListener('mouseenter', function () { document.getElementById('hover-out').textContent = 'HOVER-YES'; });</script>`),
    '/keys': html('键盘页', `
      <input id="k" autofocus><div id="key-out">NONE</div>
      <script>document.addEventListener('keydown', function (e) { document.getElementById('key-out').textContent = 'KEY:' + e.key; });</script>`),
    '/scroll': html('长页', `<div style="height:5000px">TOP</div><div id="bottom">BOTTOM</div>`),
    '/drag': html('拖拽页', `
      <div id="src" draggable="true" style="width:80px;height:40px;background:#cde">拖我</div>
      <div id="dst" style="width:200px;height:80px;margin-top:40px;background:#eee">放这</div>
      <script>var d = document.getElementById('dst');
        d.addEventListener('dragover', function (e) { e.preventDefault(); });
        d.addEventListener('drop', function (e) { e.preventDefault(); d.textContent = 'DROPPED'; });</script>`),
    '/console': html('日志页', `<script>console.log('EVAL-CONSOLE-LOG'); console.error('EVAL-CONSOLE-ERROR');</script><p>console</p>`),
    '/network': html('网络页', `<div id="net">WAIT</div>
      <script>fetch('/api/ping?from=network').then(function (r) { return r.json(); }).then(function (j) { document.getElementById('net').textContent = 'NET:' + j.pong; });</script>`),
    '/images': html('图片页', `<img id="img" src="/img/pixel.png" onload="document.getElementById('img-out').textContent='IMG-LOADED'" onerror="document.getElementById('img-out').textContent='IMG-BLOCKED'"><div id="img-out">IMG-WAIT</div>`),
    '/history/1': html('History One', '<a id="next" href="/history/2">下一页</a>'),
    '/history/2': html('History Two', '<p>second</p>'),
    '/big': html('大页面', Array.from({ length: 1500 }, (_, i) => `<p>段落 ${i} <a href="/p/${i}">链接${i}</a> <button>按钮${i}</button></p>`).join('')),
    '/refs': html('Ref 页', `
      <button id="r1" type="button">第一个按钮</button><button id="r2" type="button">第二个按钮</button>
      <input id="r-in" placeholder="ref 输入框"><div id="ref-out">REF-IDLE</div>
      <script>document.getElementById('r2').onclick = function () { document.getElementById('ref-out').textContent = 'REF-CLICKED-2'; };</script>`),
  };
}

function listPage(n) {
  const items = [1, 2, 3].map((i) => `<li class="item"><span class="t">第${n}页-条目${i}</span><a href="/detail/${n}-${i}">详情</a></li>`).join('');
  const next = n < 3 ? `<a class="next" href="/list/${n + 1}">下一页</a>` : '';
  return html(`列表第 ${n} 页`, `<ul>${items}</ul>${next}`);
}

const otherPages = {
  '/cross-inner': html('跨站内页', `
    <button id="cross-btn" type="button">跨站按钮</button><span id="cross-out">CROSS-IDLE</span>
    <input id="cross-input" placeholder="跨站输入">
    <script>document.getElementById('cross-btn').onclick = function () { document.getElementById('cross-out').textContent = 'CROSS-CLICKED'; };</script>`),
};

// 1x1 透明 PNG
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function serve(pages, hits) {
  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    const body = pages[url.pathname];
    if (body === undefined) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  });
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

/** 起两个测试站;返回 { main, other, hits, close } */
export async function startFixtures() {
  const hits = new Map();
  const mainServer = http.createServer();
  const otherServer = serve(otherPages, hits);
  const mainPort = await listen(mainServer, '127.0.0.1');
  const otherPort = await listen(otherServer, '127.0.0.1');
  const main = `http://127.0.0.1:${mainPort}`;
  const other = `http://localhost:${otherPort}`;
  const pages = mainPages(other);
  mainServer.on('request', (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
    if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ pong: 'PONG-42' })); return;
    }
    if (url.pathname === '/img/pixel.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PIXEL); return; }
    if (url.pathname === '/files/report.csv') {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' });
      res.end('name,value\nalpha,1\n'); return;
    }
    if (url.pathname === '/set-cookie') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'eval_srv=SRV-COOKIE; Path=/' });
      res.end(html('cookie', '<p>cookie set</p>')); return;
    }
    if (url.pathname === '/echo-cookie') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html('echo', `<pre id="cookie">${(req.headers.cookie ?? '').replace(/</g, '')}</pre>`)); return;
    }
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`User-agent: *\nSitemap: ${main}/sitemap.xml\n`); return;
    }
    if (url.pathname === '/sitemap.xml') {
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/a', '/b', '/c', '/article']
        .map((p) => `<url><loc>${main}${p}</loc></url>`).join('')}</urlset>`);
      return;
    }
    const body = pages[url.pathname];
    if (body === undefined) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  });
  return {
    main,
    other,
    hits,
    close: () => Promise.all([mainServer, otherServer].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); }))),
  };
}
