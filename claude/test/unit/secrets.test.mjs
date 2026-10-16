// 堡垒机资产解析与防外泄站点比对的单测(样例文字照 baolei 3.2.0 get_asset 的真实输出格式)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAssetText, parseOtpText, assetHosts, assetHostRules, hostMatches, isUseOnSchemaError, BaoleiAssets } from '../../dist/secrets/baolei-assets.js';
import { classifyError } from '../../dist/errors.js';

const REVEALED = `    Asset 430 · 服务 · ai-desk · 远程画面 Selkies 登录密码 · owner admin · 运行中
    address: https://192.168.110.239:8080
    account: admin
    secret: S3cret!pass
    只看密码（不能操作）: viewonly-123
    备用: (empty)
    spec: AI 专用桌面
    tags: ai-desk, selkies
    note: 说明: 带冒号
    shared with: nobody

\`\`\`markdown
## 用途
secret: not-a-field
\`\`\``;

const HIDDEN = REVEALED.replace('secret: S3cret!pass', 'secret: (stored; reveal=true to get it)').replace('viewonly-123', '(encrypted; reveal=true to get it)');

test('parseAssetText: revealed', () => {
  const a = parseAssetText(REVEALED);
  assert.equal(a.id, '430');
  assert.equal(a.name, 'ai-desk · 远程画面 Selkies 登录密码');
  assert.equal(a.address, 'https://192.168.110.239:8080');
  assert.equal(a.account, 'admin');
  assert.equal(a.secret, 'S3cret!pass');
  assert.equal(a.fields['只看密码（不能操作）'], 'viewonly-123');
  assert.equal('备用' in a.fields, false);
  assert.deepEqual(a.tags, ['ai-desk', 'selkies']);
  assert.equal('spec' in a.fields, false);
});

test('parseAssetText: hidden values are not mistaken for secrets; intro is ignored', () => {
  const a = parseAssetText(HIDDEN);
  assert.equal(a.secret, undefined);
  assert.equal(a.fields['只看密码（不能操作）'], undefined);
});

test('parseAssetText: garbage → null', () => {
  assert.equal(parseAssetText('❌ asset not found'), null);
  assert.equal(parseAssetText(''), null);
});

test('parseOtpText', () => {
  assert.deepEqual(parseOtpText('    2FA code for X · Y (acc:1): 12345678 — valid 29s more; next 87654321'), { code: '12345678', validSec: 29, next: '87654321' });
  assert.deepEqual(parseOtpText('2FA code for X (a): 123456 — valid 5s more'), { code: '123456', validSec: 5, next: undefined });
  assert.equal(parseOtpText('no otp configured'), null);
});

test('assetHosts: messy Chinese addresses; ports kept when written; tags never count', () => {
  assert.deepEqual(assetHosts({ address: 'http://192.168.110.246:3001（外网 http://s3.alonelife.top:32109）' }), ['192.168.110.246:3001', 's3.alonelife.top:32109']);
  assert.deepEqual(assetHosts({ address: 'http://127.0.0.1:5193/admin/（本地开发；上线后为 <域名>/admin/）' }), ['127.0.0.1:5193']);
  assert.deepEqual(assetHosts({ address: 'https://5fd.zygskins.cn', tags: ['yanzheng', 'AI测试通行码'] }), ['5fd.zygskins.cn']);
  assert.deepEqual(assetHosts({ address: '127.0.0.1:5432/ankotti_os_staging（sz 共享 PG）' }), ['127.0.0.1:5432']);
  assert.deepEqual(assetHosts({ address: '飞牛 /opt/baolei/.env 的 GITEA_TOKEN' }), []);
  // 自由填写的 tags 不算登记站点(谁都能往 tags 里写个域名)
  assert.deepEqual(assetHosts({ address: '', tags: ['shop.example.com', 'x'] }), []);
  assert.deepEqual(assetHosts({ address: 'https://*.example.com 和 example.com' }), ['*.example.com', 'example.com']);
});

test('assetHosts: data.hosts from the new bastion, including IPs / localhost (L5)', () => {
  assert.deepEqual(assetHosts({ address: '', hosts: ['192.168.1.5', 'localhost:8080', 'a.com', '*.b.com', '[::1]:3000'] }), ['192.168.1.5', 'localhost:8080', 'a.com', '*.b.com', '[::1]:3000']);
  assert.deepEqual(assetHosts({ address: 'http://localhost:5173/login' }), ['localhost:5173']);
});

const at = (u) => new URL(u);
test('hostMatches: exact host by default, *. for subdomains, ports when registered', () => {
  const rules = (address, hosts) => assetHostRules({ address, hosts });
  assert.equal(hostMatches(at('https://5fd.zygskins.cn/login'), rules('https://5fd.zygskins.cn')), true);
  assert.equal(hostMatches(at('https://www.example.com'), rules('https://example.com')), false);
  assert.equal(hostMatches(at('https://www.example.com'), rules('https://*.example.com')), true);
  assert.equal(hostMatches(at('https://example.com'), rules('https://*.example.com')), false);
  assert.equal(hostMatches(at('https://example.com.evil.io'), rules('', ['*.example.com', 'example.com'])), false);
  assert.equal(hostMatches(at('https://evilexample.com'), rules('', ['*.example.com'])), false);
  assert.equal(hostMatches(at('http://192.168.110.239:8080'), rules('https://192.168.110.239:8080')), true);
  assert.equal(hostMatches(at('http://192.168.110.239:9090'), rules('https://192.168.110.239:8080')), false);
  assert.equal(hostMatches({ hostname: '1.192.168.110.239', port: '', protocol: 'http:' }, rules('192.168.110.239')), false);
  assert.equal(hostMatches(at('http://192.168.110.239:1234'), rules('', ['192.168.110.239'])), true);
  assert.equal(hostMatches(at('http://localhost:3000'), rules('', ['localhost:3000'])), true);
  assert.equal(hostMatches(at('https://a.com'), rules('a.com:443')), true);
  assert.equal(hostMatches(at('https://a.com:8443'), rules('a.com:443')), false);
});

test('BaoleiAssets: not configured → SECRET_UNAVAILABLE', async () => {
  const b = new BaoleiAssets(null);
  assert.equal(b.configured, false);
  await assert.rejects(b.info('1', true), (e) => e.code === 'SECRET_UNAVAILABLE');
});

test('BaoleiAssets: parses SSE reply, uses next OTP near expiry, refuses error replies', async () => {
  const reply = (text) => async () => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  assert.equal((await new BaoleiAssets({ url: 'https://b/mcp', token: 't' }, reply(REVEALED)).info('430', true)).secret, 'S3cret!pass');
  assert.equal(await new BaoleiAssets({ url: 'https://b/mcp', token: 't' }, reply('2FA code for X (a): 11111111 — valid 2s more; next 22222222')).otp('1'), '22222222');
  await assert.rejects(new BaoleiAssets({ url: 'https://b/mcp', token: 't' }, reply('❌ no permission')).info('1', true), (e) => e.code === 'SECRET_UNAVAILABLE');
});

test('classifyError maps common patchright / Chinese errors', () => {
  assert.equal(classifyError('Timeout 30000ms exceeded.'), 'TIMEOUT');
  assert.equal(classifyError('page.goto: net::ERR_NAME_NOT_RESOLVED at https://x'), 'NAVIGATION_FAILED');
  assert.equal(classifyError('Target page, context or browser has been closed'), 'BROWSER_CLOSED');
  assert.equal(classifyError('ref e12 未找到(页面可能已重新渲染),请重新调用 snapshot 获取最新 ref'), 'ELEMENT_NOT_FOUND');
  assert.equal(classifyError('参数验证失败: url required'), 'INVALID_ARGS');
  assert.equal(classifyError('element is not visible'), 'ELEMENT_NOT_ACTIONABLE');
  assert.equal(classifyError('page.evaluate: ReferenceError: foo is not defined'), 'SCRIPT_ERROR');
  assert.equal(classifyError('something odd'), 'INTERNAL');
});

import { requiresHttps } from '../../dist/secrets/baolei-assets.js';
test('requiresHttps: only when every listed URL is https', () => {
  assert.equal(requiresHttps({ address: 'https://a.com/login' }), true);
  assert.equal(requiresHttps({ address: 'https://a.com（内网 http://10.0.0.1）' }), false);
  assert.equal(requiresHttps({ address: 'a.com' }), false);
});

// ── 2026-10 堡垒机「代填 / 审批」新接口 ──
const sse = (result) => new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const T = { url: 'https://b/mcp', token: 't' };

test('new bastion: values come from _meta["baolei/data"], text has no plaintext', async () => {
  const seen = [];
  const f = async (_u, init) => { seen.push(JSON.parse(init.body).params.arguments); return sse({ content: [{ type: 'text', text: 'Asset 9 · 账号 · X · used' }], _meta: { 'baolei/data': { id: 9, name: 'X', address: 'https://x.com', account: 'alice', hosts: ['x.com'], secret: 'S3', otp: { code: '123456', remaining: 2, next: '654321' } } } }); };
  const b = new BaoleiAssets(T, f);
  const info = await b.info('9', true, 'https://x.com/login');
  assert.equal(info.secret, 'S3');
  assert.equal(info.account, 'alice');
  assert.equal(seen[0].use_on, 'https://x.com/login');
  assert.equal(await b.otp('9', 'https://x.com/login'), '654321'); // 快过期用下一个
});

test('new bastion: pending approval polls until approved', async () => {
  let n = 0;
  const f = async () => (++n < 3
    ? sse({ isError: true, content: [{ type: 'text', text: 'ASSET_USE_PENDING request=r1 已推送' }], _meta: { 'baolei/data': { pending: { requestId: 'r1', status: 'pending' } } } })
    : sse({ content: [{ type: 'text', text: 'ok' }], _meta: { 'baolei/data': { id: 1, name: 'X', secret: 'S' } } }));
  const b = new BaoleiAssets(T, f, 2000, 10);
  assert.equal((await b.info('1', true, 'https://x.com')).secret, 'S');
  assert.equal(n, 3);
});

test('new bastion: pending times out with SECRET_PENDING_APPROVAL; denied and origin map to codes', async () => {
  const pending = async () => sse({ isError: true, content: [{ type: 'text', text: 'ASSET_USE_PENDING request=r2' }] });
  await assert.rejects(new BaoleiAssets(T, pending, 30, 10).info('1', true, 'https://x.com'), (e) => e.code === 'SECRET_PENDING_APPROVAL' && /r2/.test(e.message));
  const denied = async () => sse({ isError: true, content: [{ type: 'text', text: 'ASSET_USE_DENIED retryAfter=600' }] });
  await assert.rejects(new BaoleiAssets(T, denied).info('1', true, 'https://x.com'), (e) => e.code === 'SECRET_UNAVAILABLE' && /拒绝/.test(e.message));
  const origin = async () => sse({ isError: true, content: [{ type: 'text', text: 'ASSET_USE_ORIGIN 站点不符' }] });
  await assert.rejects(new BaoleiAssets(T, origin).info('1', true, 'https://evil.com'), (e) => e.code === 'SECRET_ORIGIN_MISMATCH');
});

test('old bastion rejecting use_on: retried without it', async () => {
  const seen = [];
  const f = async (_u, init) => {
    const a = JSON.parse(init.body).params.arguments;
    seen.push(a);
    return 'use_on' in a
      ? sse({ isError: true, content: [{ type: 'text', text: 'Input validation error: Unrecognized key: "use_on"' }] })
      : sse({ content: [{ type: 'text', text: REVEALED }] });
  };
  assert.equal((await new BaoleiAssets(T, f).info('430', true, 'https://x.com')).secret, 'S3cret!pass');
  assert.equal(seen.length, 2);
});

// ── H4:旧版不认 use_on 的回退只认窄的 schema 报错,绝不吞掉 ASSET_USE_* ──
test('isUseOnSchemaError: narrow signature only', () => {
  assert.equal(isUseOnSchemaError('Input validation error: Unrecognized key: "use_on"'), true);
  assert.equal(isUseOnSchemaError("Unrecognized key(s) in object: 'use_on'"), true);
  assert.equal(isUseOnSchemaError('unknown argument use_on'), true);
  assert.equal(isUseOnSchemaError('ASSET_USE_ORIGIN use_on https://evil.com 不是登记站点 unknown key use_on'), false);
  assert.equal(isUseOnSchemaError('ASSET_USE_PENDING request=r1 use_on=https://x.com'), false);
  assert.equal(isUseOnSchemaError('invalid argument: asset'), false);
  assert.equal(isUseOnSchemaError('use_on rejected'), false);
});

test('ASSET_USE_ORIGIN mentioning use_on is NOT retried without use_on', async () => {
  const seen = [];
  const f = async (_u, init) => {
    const a = JSON.parse(init.body).params.arguments;
    seen.push(a);
    return 'use_on' in a
      ? sse({ isError: true, content: [{ type: 'text', text: 'ASSET_USE_ORIGIN use_on=https://evil.com: unknown key use_on host' }] })
      : sse({ content: [{ type: 'text', text: REVEALED }] });
  };
  await assert.rejects(new BaoleiAssets(T, f).info('430', true, 'https://evil.com'), (e) => e.code === 'SECRET_ORIGIN_MISMATCH');
  assert.equal(seen.length, 1);
});

test('fallback without use_on happens at most once, and pending polls keep the effective args', async () => {
  const seen = [];
  const f = async (_u, init) => {
    seen.push(JSON.parse(init.body).params.arguments);
    return sse({ isError: true, content: [{ type: 'text', text: 'Input validation error: Unrecognized key: "use_on"' }] });
  };
  await assert.rejects(new BaoleiAssets(T, f).info('1', true, 'https://x.com'), (e) => e.code === 'SECRET_UNAVAILABLE');
  assert.equal(seen.length, 2);
  assert.equal('use_on' in seen[1], false);
});

// ── M1:等批准期间调用被取消 / 到期 → SECRET_PENDING_APPROVAL,不再继续轮询 ──
test('pending approval stops when the call signal aborts', async () => {
  let n = 0;
  const pending = async () => { n++; return sse({ isError: true, content: [{ type: 'text', text: 'ASSET_USE_PENDING request=r9' }] }); };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  const t0 = Date.now();
  await assert.rejects(new BaoleiAssets(T, pending, 60_000, 20).info('1', true, 'https://x.com', ac.signal), (e) => e.code === 'SECRET_PENDING_APPROVAL' && /r9/.test(e.message));
  assert.ok(Date.now() - t0 < 2000);
  const before = n;
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(n, before);
});

import { SECRET_TOOL_BUDGET_MS, APPROVAL_WAIT_MS } from '../../dist/secrets/baolei-assets.js';
import { deadlineFor } from '../../dist/desk/instrument.js';
test('fill_secret / login_with_asset deadline covers two approval waits', () => {
  assert.ok(SECRET_TOOL_BUDGET_MS >= APPROVAL_WAIT_MS * 2);
  assert.ok(deadlineFor('fill_secret', {}, 120_000) > SECRET_TOOL_BUDGET_MS);
  assert.ok(deadlineFor('login_with_asset', {}, 120_000) > SECRET_TOOL_BUDGET_MS);
});

import { browserEnv, isSensitiveEnvName } from '../../dist/browser-env.js';
test('browserEnv drops token / password / bastion / selkies variables only', () => {
  const env = browserEnv({ PATH: '/bin', HOME: '/h', DISPLAY: ':1', MCP_AUTH_TOKEN: 'a', ADMIN_TOKEN: 'b', BAOLEI_MCP_TOKEN: 'c', BAOLEI_MCP_URL: 'd', SELKIES_BASIC_AUTH_PASSWORD: 'e', SELKIES_PORT: '1', AWS_SECRET_ACCESS_KEY: 'f', OPENAI_API_KEY: 'g', DB_PASSWD: 'h', USER_DATA_DIR: '/p', X: undefined });
  assert.deepEqual(Object.keys(env).sort(), ['DISPLAY', 'HOME', 'PATH', 'USER_DATA_DIR']);
  assert.equal(isSensitiveEnvName('PLAYWRIGHT_BROWSERS_PATH'), false);
});

import { stripCallLog } from '../../dist/errors.js';
test('stripCallLog removes the Playwright call log (it echoes typed text)', () => {
  assert.equal(stripCallLog('locator.fill: Timeout 5000ms exceeded.\nCall log:\n  - fill("hunter2")'), 'locator.fill: Timeout 5000ms exceeded.');
  assert.equal(stripCallLog('plain error'), 'plain error');
});
