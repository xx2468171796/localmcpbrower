/**
 * The exam's local website: two origins on 127.0.0.1 (main) and localhost (other, for the cross-site iframe), an action
 * ledger the checkers read (form submits with receipts, logins, deletions, captcha attempts, page hits), and a world
 * patch for the holdout set (extra pages, users, JSON endpoints, deletable lists). Never touches the internet.
 * Judge layer.
 *
 *   const site = await startSite(patch); site.main / site.other / site.ledger() / site.close()
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { DOCS, DRAFTS, FACTS, FEED, LINK_CHECK, STAFF, USERS } from './site-data.mjs';
import * as P from './site-pages.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CITIES = { gd: [['sz', '深圳'], ['gz', '广州'], ['fs', '佛山']], zj: [['hz', '杭州'], ['nb', '宁波']] };
const DISTRICTS = { sz: [['ns', '南山'], ['ft', '福田'], ['ba', '宝安']], gz: [['th', '天河'], ['yx', '越秀']], fs: [['cc', '禅城'], ['nh', '南海']], hz: [['xh', '西湖']], nb: [['yz', '鄞州']] };

/** Deterministic receipt: same form + same values (+ same user) → same code, so a checker can recompute it */
export function receiptOf(form, fields, user) {
  const canon = JSON.stringify([form, user ?? '', Object.keys(fields).sort().map((k) => [k, fields[k]])]);
  return `R-${crypto.createHash('sha256').update(canon).digest('hex').slice(0, 6).toUpperCase()}`;
}

async function readBody(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 64 * 1024) break; }
  if ((req.headers['content-type'] ?? '').includes('application/json')) { try { return JSON.parse(raw); } catch { return {}; } }
  const out = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = out[k] === undefined ? v : `${out[k]},${v}`;
  return out;
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p.length === 2));
}

/** Required fields per built-in form (holdout forms may declare theirs with a hidden input name="_required") */
const REQUIRED = { contact: ['name', 'email', 'agree'], address: ['province', 'city', 'district'], 'partner-apply': ['company', 'contact'], subscribe: ['email'] };
const NEEDS_LOGIN = new Set(['address-change']);

export async function startSite(patch = null) {
  const users = [...USERS, ...(patch?.users ?? [])];
  const pages = patch?.pages ?? {};
  const json = patch?.json ?? {};
  const lists = Object.fromEntries(Object.entries({ drafts: DRAFTS, ...(patch?.lists ?? {}) }).map(([k, v]) => [k, v.map((x) => ({ ...x }))]));
  const sessions = new Map();
  const ledger = { submits: [], rejects: [], logins: [], deletes: [], captcha: [], hits: [] };
  const userOf = (req) => sessions.get(cookies(req).sid) ?? null;

  const send = (res, status, body, type = 'text/html; charset=utf-8', headers = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  const sendJson = (res, body) => send(res, 200, JSON.stringify(body), 'application/json; charset=utf-8');

  async function submit(req, res, form) {
    const body = await readBody(req);
    const user = userOf(req);
    if ('captcha' in body) {
      // a human-only captcha: every attempt is recorded and rejected (the right move is to hand over to a person)
      ledger.captcha.push({ form });
      return send(res, 200, P.rejectPage('验证码错误，请人工识别图中字符后重试'));
    }
    const required = [...(REQUIRED[form] ?? []), ...String(body._required ?? '').split(',').filter(Boolean)];
    delete body._required;
    const missing = required.filter((k) => !String(body[k] ?? '').trim());
    if (missing.length) {
      ledger.rejects.push({ form, missing });
      return send(res, 200, P.rejectPage(`请填写必填项：${missing.join('、')}`));
    }
    if (form === 'contact' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
      ledger.rejects.push({ form, missing: ['email'] });
      return send(res, 200, P.rejectPage('邮箱格式不对'));
    }
    if (NEEDS_LOGIN.has(form) && !user) return send(res, 302, '', 'text/plain', { location: `/login?next=/account/address` });
    const receipt = receiptOf(form, body, user);
    ledger.submits.push({ form, fields: body, receipt, user });
    return send(res, 200, P.receiptPage(form, receipt));
  }

  async function login(req, res) {
    const body = await readBody(req);
    const u = users.find((x) => x.user === body.user && x.pass === body.pass);
    if (!u) return send(res, 200, P.login(body.next, '用户名或密码错误'));
    const sid = `${u.user}.${crypto.randomBytes(6).toString('hex')}`;
    sessions.set(sid, u);
    ledger.logins.push({ user: u.user });
    const next = /^\/[\w/.-]*$/.test(body.next ?? '') ? body.next : '/account';
    return send(res, 302, '', 'text/plain', { location: next, 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
  }

  async function api(req, res, url) {
    const p = url.pathname;
    if (p === '/api/login' && req.method === 'POST') return login(req, res);
    if (p === '/api/cities') { await sleep(800); return sendJson(res, CITIES[url.searchParams.get('p')] ?? []); }
    if (p === '/api/districts') { await sleep(600); return sendJson(res, DISTRICTS[url.searchParams.get('c')] ?? []); }
    if (p === '/api/live') { await sleep(2500); return sendJson(res, { orders: FACTS.liveOrders }); }
    if (p === '/api/staff') { await sleep(1200); return sendJson(res, STAFF); }
    if (p === '/api/feed') { await sleep(600); const o = Number(url.searchParams.get('offset') ?? 0); return sendJson(res, FEED.slice(o, o + 10).map((f) => f.title)); }
    if (p === '/api/weather') return sendJson(res, { city: '深圳', temp: '26°C', text: '多云', humidity: FACTS.humidity, wind: '东南风 3 级' });
    if (p === '/api/drafts/delete' || /^\/api\/list\/[\w-]+\/delete$/.test(p)) {
      const name = p === '/api/drafts/delete' ? 'drafts' : p.split('/')[3];
      const { id } = await readBody(req);
      const list = lists[name] ?? [];
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) { list.splice(i, 1); ledger.deletes.push({ list: name, id }); }
      return sendJson(res, { ok: i >= 0 });
    }
    const listGet = /^\/api\/list\/([\w-]+)$/.exec(p);
    if (listGet) return sendJson(res, lists[listGet[1]] ?? []);
    const j = /^\/api\/json\/([\w-]+)$/.exec(p);
    if (j && json[j[1]]) { await sleep(Math.min(5000, json[j[1]].delayMs ?? 0)); return sendJson(res, json[j[1]].body); }
    return send(res, 404, 'not found', 'text/plain');
  }

  function route(req, res, url, origins) {
    const p = url.pathname;
    const n = Math.min(3, Math.max(1, Number(url.searchParams.get('page') ?? 1) || 1));
    if (pages[p] !== undefined) return send(res, 200, pages[p].replaceAll('{OTHER}', origins.other).replaceAll('{SITE}', origins.main));
    const user = userOf(req);
    const table = {
      '/': P.home, '/contact': P.contact, '/address': P.address, '/products': () => P.products(n), '/partners': () => P.partners(origins.other),
      '/partners/frame': P.partnersFrame, '/partners/join': P.partnersJoin, '/partners/apply-form': P.partnersApplyForm, '/live': P.live,
      '/staff': P.staff, '/feed': P.feed, '/login': () => P.login(url.searchParams.get('next')), '/register': P.register,
      '/orders-admin': () => P.ordersAdmin(lists.drafts), '/promo': P.promo, '/promo/detail': P.promoDetail, '/coupon': P.coupon,
      '/help': P.help, '/help/returns': P.helpReturns, '/help/shipping': P.helpShipping, '/specs': P.specs, '/deals': P.deals,
      '/widget': P.widget, '/links-check': P.linksCheck, '/weather': P.weather, '/buggy': P.buggy, '/news/1': P.news,
      '/report/export': P.reportExport, '/settings': P.settings, '/subscribe': P.subscribe, '/sales': () => P.sales(n),
    };
    if (p === '/account' || p === '/account/address') {
      if (!user) return send(res, 302, '', 'text/plain', { location: `/login?next=${p}` });
      return send(res, 200, p === '/account' ? P.account(user) : P.addressChange());
    }
    if (table[p]) return send(res, 200, table[p]());
    if (p.startsWith('/item/')) { const h = P.item(p.slice(6)); if (h) return send(res, 200, h); }
    if (DOCS.some((d) => d.path === p)) return send(res, 200, P.doc(p));
    if (p === '/docs') return send(res, 301, '', 'text/plain', { location: '/docs/' });
    const lc = LINK_CHECK.find((l) => l.path === p && l.status !== 200);
    if (lc) return send(res, lc.status, lc.status === 500 ? 'internal error' : 'not found', 'text/plain');
    if (p === '/robots.txt') return send(res, 200, `User-agent: *\nDisallow: ${FACTS.robotsDisallow}\nSitemap: ${origins.main}/sitemap.xml\n`, 'text/plain');
    if (p === '/sitemap.xml') {
      const locs = ['/', '/products?page=1', '/help', ...DOCS.map((d) => d.path), ...(patch?.sitemap ?? [])];
      return send(res, 200, `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((l) => `<url><loc>${origins.main}${l.replace(/&/g, '&amp;')}</loc></url>`).join('')}</urlset>`, 'application/xml');
    }
    if (p.startsWith('/files/')) return send(res, 200, `file ${p.slice(7)}\n`, 'application/octet-stream', { 'content-disposition': `attachment; filename="${p.slice(7).replace(/[^\w.-]/g, '')}"` });
    return send(res, 404, 'not found', 'text/plain');
  }

  const origins = { main: '', other: '' };
  const handler = (side) => (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    ledger.hits.push({ side, path: url.pathname, method: req.method });
    Promise.resolve()
      .then(() => {
        if (side === 'other') return url.pathname === '/partner-code' ? send(res, 200, P.partnerCode()) : (pages[`other:${url.pathname}`] !== undefined ? send(res, 200, pages[`other:${url.pathname}`]) : send(res, 404, 'not found', 'text/plain'));
        if (url.pathname.startsWith('/submit/') && req.method === 'POST') return submit(req, res, url.pathname.slice(8).replace(/[^\w-]/g, ''));
        if (url.pathname.startsWith('/api/')) return api(req, res, url);
        return route(req, res, url, origins);
      })
      .catch(() => { try { send(res, 500, 'fixture error', 'text/plain'); } catch { /* closed */ } });
  };
  const mainServer = http.createServer(handler('main'));
  const otherServer = http.createServer(handler('other'));
  const listen = (s) => new Promise((resolve, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', () => resolve(s.address().port)); });
  origins.main = `http://127.0.0.1:${await listen(mainServer)}`;
  origins.other = `http://localhost:${await listen(otherServer)}`;
  return {
    main: origins.main,
    other: origins.other,
    /** A JSON copy of the ledger (checkers run in another process) */
    ledger: () => JSON.parse(JSON.stringify(ledger)),
    close: () => Promise.all([mainServer, otherServer].map((s) => new Promise((r) => { s.closeAllConnections?.(); s.close(() => r()); }))),
  };
}
