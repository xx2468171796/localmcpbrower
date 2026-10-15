/**
 * Static and script-driven pages of the exam site (no external resources, deterministic). Dynamic behaviour lives in the
 * page scripts (delays, dialogs, popups, shadow DOM, hover / tab reveals) and in fixture-site.mjs (APIs, login, submits).
 * Judge layer.
 */
import { DOCS, FACTS, FEED, LINK_CHECK, PRODUCTS, SALES } from './site-data.mjs';

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export const page = (title, body, script = '') =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title>`
  + '<style>body{font-family:sans-serif;margin:16px}.hidden{display:none}#cookie-banner{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9}'
  + '#cookie-banner .box{background:#fff;margin:120px auto;width:320px;padding:16px}</style></head>'
  + `<body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

const yuan = (n) => `¥${Number(n).toLocaleString('en-US')}`;

const NAV = '<nav><a href="/">首页</a> · <a href="/products?page=1">商品</a> · <a href="/docs/">文档</a> · <a href="/help">帮助</a> · <a href="/login">登录</a></nav>';

export function home() {
  const links = [
    ['/contact', '联系我们'], ['/address', '收货地址'], ['/products?page=1', '全部商品'], ['/partners', '合作伙伴'],
    ['/partners/join', '申请成为合作伙伴'], ['/live', '实时看板'], ['/staff', '员工通讯录'], ['/feed', '动态'],
    ['/account', '我的账户'], ['/register', '注册'], ['/orders-admin', '草稿单管理'], ['/promo', '活动'], ['/coupon', '领券'],
    ['/specs', '产品参数'], ['/deals', '今日特价'], ['/widget', '库存组件'], ['/links-check', '友情链接'], ['/weather', '天气'],
    ['/buggy', '支付'], ['/news/1', '新闻'], ['/report/export', '报表导出'], ['/settings', '设置'], ['/subscribe', '订阅'],
    ['/sales?page=1', '销售报表'],
  ];
  return page('星河商城', `${NAV}<h1>星河商城（演示站）</h1><ul>${links.map(([h, t]) => `<li><a href="${h}">${t}</a></li>`).join('')}</ul>`);
}

export function contact() {
  return page('联系我们', `${NAV}<h1>联系我们</h1>
<form method="post" action="/submit/contact">
<p><label for="name">姓名 *</label> <input id="name" name="name"></p>
<p><label for="email">邮箱 *</label> <input id="email" name="email" type="email"></p>
<p><label for="phone">电话</label> <input id="phone" name="phone"></p>
<p><label for="city">城市</label> <select id="city" name="city"><option value="">请选择</option><option value="bj">北京</option><option value="sh">上海</option><option value="sz">深圳</option><option value="gz">广州</option></select></p>
<p>类型：<label><input type="radio" name="topic" value="consult" checked> 咨询</label> <label><input type="radio" name="topic" value="refund"> 退款</label> <label><input type="radio" name="topic" value="complaint"> 投诉</label></p>
<p><label for="message">留言</label><br><textarea id="message" name="message" rows="3" cols="40"></textarea></p>
<p><label><input type="checkbox" id="agree" name="agree" value="yes"> 我同意隐私政策 *</label></p>
<button type="submit" id="send">提交</button></form>`);
}

export function address() {
  return page('收货地址', `${NAV}<h1>新增收货地址</h1>
<form method="post" action="/submit/address">
<p>省份 <select id="province" name="province"><option value="">请选择省份</option><option value="gd">广东</option><option value="zj">浙江</option></select></p>
<p>城市 <select id="city" name="city" disabled><option value="">请先选省份</option></select></p>
<p>区县 <select id="district" name="district" disabled><option value="">请先选城市</option></select></p>
<p>详细地址 <input id="detail" name="detail" size="40"></p>
<button type="submit">保存地址</button></form>`, `
function fill(sel, items, ph){ sel.innerHTML = '<option value="">' + ph + '</option>' + items.map(function(i){ return '<option value="' + i[0] + '">' + i[1] + '</option>'; }).join(''); sel.disabled = false; }
document.getElementById('province').addEventListener('change', function(){
  var c = document.getElementById('city'); c.disabled = true; c.innerHTML = '<option>加载中…</option>';
  fetch('/api/cities?p=' + this.value).then(function(r){ return r.json(); }).then(function(j){ fill(c, j, '请选择城市'); });
});
document.getElementById('city').addEventListener('change', function(){
  var d = document.getElementById('district'); d.disabled = true; d.innerHTML = '<option>加载中…</option>';
  fetch('/api/districts?c=' + this.value).then(function(r){ return r.json(); }).then(function(j){ fill(d, j, '请选择区县'); });
});`);
}

export function products(n) {
  const per = 8;
  const rows = PRODUCTS.slice((n - 1) * per, n * per)
    .map((p) => `<tr class="product"><td class="sku">${p.sku}</td><td class="name"><a href="/item/${p.sku}">${esc(p.name)}</a></td><td class="cat">${p.category}</td><td class="price">${yuan(p.price)}</td><td class="stock">${p.stock}</td></tr>`).join('');
  const prev = n > 1 ? `<a class="prev" href="/products?page=${n - 1}">上一页</a>` : '';
  const next = n < 3 ? `<a class="next" href="/products?page=${n + 1}">下一页</a>` : '';
  return page(`全部商品 第 ${n} 页`, `${NAV}<h1>全部商品</h1><table id="products"><thead><tr><th>货号</th><th>名称</th><th>分类</th><th>价格</th><th>库存</th></tr></thead><tbody>${rows}</tbody></table>
<p class="pager">${prev} 第 ${n} / 3 页 ${next}</p>`);
}

export function item(sku) {
  const p = PRODUCTS.find((x) => x.sku === sku);
  if (!p) return null;
  return page(p.name, `${NAV}<h1>${esc(p.name)}</h1><p>货号 ${p.sku} · ${yuan(p.price)}</p><p class="badge">${p.presale ? '预售（10 月底发货）' : '现货'}</p>`);
}

export function partners(other) {
  return page('合作伙伴', `${NAV}<h1>合作伙伴</h1><p>合作资料都在下面的框里。</p>
<iframe id="docs-frame" src="/partners/frame" width="500" height="160"></iframe>
<iframe id="code-frame" src="${other}/partner-code" width="500" height="100"></iframe>`);
}

export const partnersFrame = () => page('合作资料', `<h3>合作资料下载</h3><ul>
<li><a href="/files/partner-guide.pdf">合作伙伴手册</a></li><li><a href="${FACTS.partnerPdf}">合作伙伴协议 PDF</a></li><li><a href="/files/brand-kit.zip">品牌素材包</a></li></ul>`);

export const partnerCode = () => page('合作码', `<p>本季度合作码：<b id="pcode">${FACTS.partnerCode}</b></p>`);

export const partnersJoin = () => page('申请成为合作伙伴', `${NAV}<h1>申请成为合作伙伴</h1><p>请在下面的框里填写申请表。</p>
<iframe id="apply-frame" src="/partners/apply-form" width="560" height="260"></iframe>`);

export const partnersApplyForm = () => page('申请表', `<form method="post" action="/submit/partner-apply">
<p>公司名称 <input name="company" id="company"></p><p>联系人 <input name="contact" id="contact"></p>
<p>合作类型 <select name="kind" id="kind"><option value="reseller">经销</option><option value="supplier">供货</option><option value="media">媒体</option></select></p>
<button type="submit">提交申请</button></form>`);

export const live = () => page('实时看板', `${NAV}<h1>实时看板</h1><p>今日订单：<span id="orders">--</span> <span id="state">加载中…</span></p>`,
  `fetch('/api/live').then(function(r){return r.json();}).then(function(j){document.getElementById('orders').textContent=j.orders;document.getElementById('state').textContent='已更新';});`);

export const staff = () => page('员工通讯录', `${NAV}<h1>员工通讯录</h1><p><input id="q" placeholder="输入姓名或部门"> <button id="search" type="button">搜索</button></p>
<p id="status">通讯录加载中…</p><table id="staff"><thead><tr><th>姓名</th><th>部门</th><th>电话</th><th>邮箱</th></tr></thead><tbody></tbody></table>`, `
var all = [];
function render(list){ document.querySelector('#staff tbody').innerHTML = list.map(function(s){ return '<tr class="person"><td class="name">' + s.name + '</td><td class="dept">' + s.dept + '</td><td class="phone">' + s.phone + '</td><td class="email">' + s.email + '</td></tr>'; }).join(''); }
function search(){ var q = document.getElementById('q').value.trim(); render(q ? all.filter(function(s){ return s.name.indexOf(q) >= 0 || s.dept.indexOf(q) >= 0; }) : all.slice(0, 5)); }
fetch('/api/staff').then(function(r){ return r.json(); }).then(function(j){ all = j; document.getElementById('status').textContent = '共 ' + j.length + ' 人，默认只显示前 5 人，请搜索'; search(); });
document.getElementById('search').addEventListener('click', search);
document.getElementById('q').addEventListener('keydown', function(e){ if (e.key === 'Enter') search(); });`);

export const feed = () => page('动态', `${NAV}<h1>动态</h1><ol id="feed">${FEED.slice(0, 10).map((f) => `<li class="feed-item">${esc(f.title)}</li>`).join('')}</ol>
<button id="more" type="button">加载更多</button>`, `
var offset = 10;
document.getElementById('more').addEventListener('click', function(){
  var b = this; b.disabled = true; b.textContent = '加载中…';
  fetch('/api/feed?offset=' + offset).then(function(r){ return r.json(); }).then(function(j){
    j.forEach(function(t){ var li = document.createElement('li'); li.className = 'feed-item'; li.textContent = t; document.getElementById('feed').appendChild(li); });
    offset += j.length; b.disabled = false; b.textContent = '加载更多'; if (offset >= 30) { b.remove(); }
  });
});`);

export const login = (next, error) => page('登录', `${NAV}<h1>登录</h1>${error ? `<p class="error">${esc(error)}</p>` : ''}
<form method="post" action="/api/login"><input type="hidden" name="next" value="${esc(next || '/account')}">
<p>用户名 <input id="user" name="user"></p><p>密码 <input id="pass" name="pass" type="password"></p><button type="submit" id="login-btn">登录</button></form>`);

export function account(u) {
  const rows = u.orders.map((o) => `<tr><td>${o.id}</td><td>${o.date}</td><td>¥${o.amount}</td><td>${o.status}</td></tr>`).join('');
  return page('我的账户', `${NAV}<h1>我的账户</h1><p>你好，${esc(u.name)}（${u.level}）</p><p>账户余额：<b id="balance">¥${u.balance}</b></p>
<h2>最近订单</h2><table id="orders"><thead><tr><th>订单号</th><th>日期</th><th>金额</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table>
<p>收货地址：${esc(u.address ?? '未填写')} <a href="/account/address">修改</a></p>`);
}

export const addressChange = () => page('修改收货地址', `${NAV}<h1>修改收货地址</h1><form method="post" action="/submit/address-change">
<p>收货人 <input name="receiver" id="receiver"></p><p>手机 <input name="phone" id="phone"></p><p>地址 <input name="address" id="address" size="40"></p>
<button type="submit">保存</button></form>`);

export const register = () => page('注册', `${NAV}<h1>注册新账号</h1><form method="post" action="/submit/register">
<p>用户名 <input name="username" id="username"></p><p>密码 <input name="password" id="password" type="password"></p><p>手机 <input name="phone" id="phone"></p>
<p>图形验证码（请人工识别图中字符） <canvas id="cap" width="120" height="40"></canvas> <input name="captcha" id="captcha"></p><button type="submit">注册</button></form>`, `
var c = document.getElementById('cap').getContext('2d'); var s = ''; var abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
for (var i = 0; i < 5; i++) s += abc[Math.floor(Math.random() * abc.length)];
c.fillStyle = '#eee'; c.fillRect(0, 0, 120, 40);
for (var k = 0; k < 30; k++) { c.strokeStyle = 'rgba(0,0,0,.3)'; c.beginPath(); c.moveTo(Math.random()*120, Math.random()*40); c.lineTo(Math.random()*120, Math.random()*40); c.stroke(); }
for (var j = 0; j < 5; j++) { c.save(); c.translate(10 + j * 22, 28); c.rotate((Math.random() - 0.5) * 0.8); c.font = '22px serif'; c.fillStyle = '#333'; c.fillText(s[j], 0, 0); c.restore(); }`);

export const ordersAdmin = (drafts) => page('草稿单管理', `${NAV}<h1>草稿单管理</h1><p id="count">共 ${drafts.length} 张草稿单</p>
<table id="drafts"><thead><tr><th>单号</th><th>客户</th><th>金额</th><th></th></tr></thead><tbody>${drafts.map((d) => `<tr class="draft"><td class="id">${d.id}</td><td>${esc(d.customer)}</td><td>¥${d.amount}</td><td><button type="button" class="del" data-id="${d.id}">删除</button></td></tr>`).join('')}</tbody></table>`, `
document.querySelectorAll('.del').forEach(function(b){ b.addEventListener('click', function(){
  var id = b.getAttribute('data-id');
  if (!confirm('确定删除草稿单 ' + id + '？')) { document.getElementById('count').textContent += '（已取消删除）'; return; }
  fetch('/api/drafts/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) }).then(function(){ location.reload(); });
}); });`);

export const promo = () => page('活动', `${NAV}<h1>双十一预热</h1><button id="open" type="button">查看活动详情（新窗口）</button>`,
  `document.getElementById('open').addEventListener('click', function(){ window.open('/promo/detail', '_blank'); });`);
export const promoDetail = () => page('活动详情', `<h1>活动详情</h1><p>专属优惠码：<b>${FACTS.promoCode}</b>，有效期至 11 月 11 日。</p>`);

export const coupon = () => page('领券', `${NAV}<h1>领券中心</h1><button id="get" type="button">领取优惠券</button><p id="msg"></p>`,
  `document.getElementById('get').addEventListener('click', function(){ alert('领取成功，优惠码 ${FACTS.couponCode}'); document.getElementById('msg').textContent = '已领取（优惠码见弹窗）'; });`);

export const help = () => page('帮助中心', `${NAV}<h1>帮助中心</h1><div id="more" style="display:inline-block;padding:8px;border:1px solid #999">更多服务 ▾
<ul id="more-menu" class="hidden"><li><a href="/help/shipping">配送说明</a></li><li><a href="/help/returns">退换货政策</a></li></ul></div>`,
  `var m = document.getElementById('more'); m.addEventListener('mouseenter', function(){ document.getElementById('more-menu').classList.remove('hidden'); });`);
export const helpReturns = () => page('退换货政策', `${NAV}<h1>退换货政策</h1><p>支持${FACTS.returnsDays}，运费由买家承担；定制商品除外。</p>`);
export const helpShipping = () => page('配送说明', `${NAV}<h1>配送说明</h1><p>满 99 元包邮，偏远地区除外。</p>`);

export const specs = () => page('产品参数', `${NAV}<h1>星河 X1 Pro 手机</h1><div role="tablist"><button role="tab" data-t="params">参数</button><button role="tab" data-t="box">包装清单</button><button role="tab" data-t="service">售后</button></div><div id="panel" role="tabpanel">请选择一个标签</div>`, `
var T = { params: '6.7 英寸屏，12GB 内存，5000mAh 电池', box: '手机、数据线、保护壳', service: '${FACTS.warranty}，电池保修 1 年' };
document.querySelectorAll('[role=tab]').forEach(function(b){ b.addEventListener('click', function(){ document.getElementById('panel').textContent = T[b.getAttribute('data-t')]; }); });`);

export const deals = () => page('今日特价', `${NAV}<h1>今日特价</h1><button id="show" type="button">查看今日特价</button><p id="deal"></p>
<div id="cookie-banner"><div class="box"><p>我们使用 Cookie 改善体验。</p><button id="accept" type="button">接受</button></div></div>`, `
document.getElementById('accept').addEventListener('click', function(){ document.getElementById('cookie-banner').remove(); window.__accepted = true; });
document.getElementById('show').addEventListener('click', function(){ document.getElementById('deal').textContent = window.__accepted ? '今日特价：降噪耳机 Q3 ${FACTS.dealPrice}' : '请先处理 Cookie 提示'; });`);

export const widget = () => page('库存组件', `${NAV}<h1>库存组件</h1><stock-widget sku="S-1005"></stock-widget>`, `
customElements.define('stock-widget', class extends HTMLElement { connectedCallback(){ var r = this.attachShadow({ mode: 'open' }); r.innerHTML = '<p>降噪耳机 Q3 当前库存 <b>${FACTS.widgetStock}</b> 件</p>'; } });`);

export const linksCheck = () => page('友情链接', `${NAV}<h1>站内链接</h1><ul>${LINK_CHECK.map((l) => `<li><a href="${l.path}">${l.label}</a></li>`).join('')}</ul>`);

export const weather = () => page('天气', `${NAV}<h1>天气</h1><p id="w">加载中…</p>`,
  `fetch('/api/weather?city=sz').then(function(r){return r.json();}).then(function(j){document.getElementById('w').textContent=j.city+' '+j.temp+' '+j.text;});`);

export const buggy = () => page('支付', `${NAV}<h1>支付</h1><p>支付暂不可用，请稍后再试。</p>`,
  `console.log('payment page loaded'); console.error('${FACTS.consoleError}: 支付通道未配置');`);

export const news = () => page('星河物流升级', `${NAV}<header>站点导航 广告位</header><article><h1>星河物流升级：新仓库启用</h1><p class="byline">2026-10-10 · 物流部</p>
<p>为了缩短华南地区的配送时间，星河商城今年持续投入仓储建设。</p><p>位于${FACTS.articleCity}的新仓库已于 10 月 8 日正式启用，面积 2.6 万平方米，可同时处理 1.2 万单。</p>
<p>启用后，广州、深圳两地的次日达比例预计从 82% 提升到 95%。</p><p>物流部表示，下一步将在成都选址建设西南仓。</p></article><footer>版权所有 星河商城</footer>`);

export const reportExport = () => page('报表导出', `${NAV}<h1>报表导出</h1><button id="gen" type="button">生成报表</button><p id="out"></p>`, `
document.getElementById('gen').addEventListener('click', function(){ document.getElementById('out').textContent = '正在生成，请稍候…';
  setTimeout(function(){ document.getElementById('out').innerHTML = '<a id="dl" href="/files/${FACTS.reportFile}">下载 ${FACTS.reportFile}</a>'; }, 3000); });`);

export const settings = () => page('设置', `${NAV}<h1>设置</h1><form method="post" action="/submit/settings">
<p>界面语言 <select id="lang" name="lang"><option value="zh-CN">简体中文</option><option value="en">English</option><option value="ja">日本語</option></select></p>
<p>时区 <select id="tz" name="tz"><option value="Asia/Shanghai">北京时间</option><option value="UTC">UTC</option></select></p><button type="submit">保存设置</button></form>`);

export const subscribe = () => page('订阅', `${NAV}<h1>订阅新品通知</h1><form method="post" action="/submit/subscribe">
<p>邮箱 <input name="email" id="email"></p><p>感兴趣的品类：${[['phone', '手机'], ['pc', '电脑'], ['home', '家电'], ['deals', '特价']].map(([v, t]) => `<label><input type="checkbox" name="interest" value="${v}"> ${t}</label>`).join(' ')}</p>
<p>频率：<label><input type="radio" name="freq" value="weekly" checked> 每周</label> <label><input type="radio" name="freq" value="monthly"> 每月</label></p><button type="submit">订阅</button></form>`);

export function sales(n) {
  const rows = SALES.slice((n - 1) * 4, n * 4).map((r) => `<tr><td>${r.region}</td><td>${r.month}</td><td class="amt">${r.amount.toLocaleString('en-US')}</td></tr>`).join('');
  const pager = [1, 2, 3].map((i) => (i === n ? `<b>${i}</b>` : `<a href="/sales?page=${i}">${i}</a>`)).join(' ');
  return page(`销售报表 第 ${n} 页`, `${NAV}<h1>2026 年第三季度销售额（元）</h1><table id="sales"><thead><tr><th>大区</th><th>月份</th><th>销售额</th></tr></thead><tbody>${rows}</tbody></table><p class="pager">${pager}</p>`);
}

export function doc(path) {
  const d = DOCS.find((x) => x.path === path);
  if (!d) return null;
  const toc = DOCS.slice(1).map((x) => `<li><a href="${x.path}">${x.title}</a></li>`).join('');
  return page(d.title, `${NAV}<aside><ul>${path === '/docs/' ? toc : ''}</ul></aside><main><h1>${d.title}</h1><p>${esc(d.body)}</p>${d.links.length ? `<p>下一篇：<a href="${d.links[0]}">继续阅读</a></p>` : ''}</main>`);
}

export const receiptPage = (form, receipt) => page('提交成功', `<h1>提交成功</h1><p>表单 ${esc(form)} 已受理，受理编号 <b id="receipt">${receipt}</b>。</p><p><a href="/">返回首页</a></p>`);
export const rejectPage = (msg) => page('提交失败', `<h1>提交失败</h1><p class="error">${esc(msg)}</p><p><a href="javascript:history.back()">返回修改</a></p>`);
