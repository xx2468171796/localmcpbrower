// 堡垒机资产解析与防外泄站点比对的单测(样例文字照 baolei 3.2.0 get_asset 的真实输出格式)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAssetText, parseOtpText, assetHosts, hostMatches, BaoleiAssets } from '../../dist/secrets/baolei-assets.js';
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

test('assetHosts: messy Chinese addresses', () => {
  assert.deepEqual(assetHosts({ address: 'http://192.168.110.246:3001（外网 http://s3.alonelife.top:32109）', tags: [] }), ['192.168.110.246', 's3.alonelife.top']);
  assert.deepEqual(assetHosts({ address: 'http://127.0.0.1:5193/admin/（本地开发；上线后为 <域名>/admin/）', tags: [] }), ['127.0.0.1']);
  assert.deepEqual(assetHosts({ address: 'https://5fd.zygskins.cn', tags: ['yanzheng', 'AI测试通行码'] }), ['5fd.zygskins.cn']);
  assert.deepEqual(assetHosts({ address: '127.0.0.1:5432/ankotti_os_staging（sz 共享 PG）', tags: [] }), ['127.0.0.1']);
  assert.deepEqual(assetHosts({ address: '飞牛 /opt/baolei/.env 的 GITEA_TOKEN', tags: [] }), []);
  assert.deepEqual(assetHosts({ address: '', tags: ['shop.example.com', 'x'] }), ['shop.example.com']);
});

test('hostMatches: subdomains yes, lookalikes no, IPs exact', () => {
  assert.equal(hostMatches('5fd.zygskins.cn', ['5fd.zygskins.cn']), true);
  assert.equal(hostMatches('www.example.com', ['example.com']), true);
  assert.equal(hostMatches('example.com.evil.io', ['example.com']), false);
  assert.equal(hostMatches('evilexample.com', ['example.com']), false);
  assert.equal(hostMatches('192.168.110.239', ['192.168.110.239']), true);
  assert.equal(hostMatches('1.192.168.110.239', ['192.168.110.239']), false);
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
