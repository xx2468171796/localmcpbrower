// 工作区身份与反检测相关纯函数的单测(src/identity.ts、src/desk/gate.ts isForeignNavigation,跑构建产物)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  acceptLanguages, contextOptions, defaultIdentity, effectiveTimezone, fitWindow, identityArgs, isProxyUrl,
  IdentityError, identityEnv, loadIdentity, maskProxy, needsGeo, patchIdentity, proxyAllowedForTool, proxyOption,
} from '../../dist/identity.js';
import { isForeignNavigation } from '../../dist/desk/gate.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'));

test('代理地址:格式校验、打码、拆账号', () => {
  for (const ok of ['http://1.2.3.4:8080', 'http://u:p@host:3128', 'socks5://host:1080', 'https://proxy.example.com']) assert.ok(isProxyUrl(ok), ok);
  for (const bad of ['ftp://x:1', 'host:8080', 'http://a b:1', 'http://x/path', 'socks5://u:p@host:1080', 'http://tok#en@proxy:8080', 'http://h:1/?x=1']) assert.ok(!isProxyUrl(bad), bad);
  assert.equal(maskProxy('socks5://user:pa%40ss@h:1080'), 'socks5://***@h:1080');
  assert.equal(maskProxy(null), null);
  assert.deepEqual(proxyOption('socks5://user:pa%40ss@h:1080'), { server: 'socks5://h:1080', username: 'user', password: 'pa@ss' });
  assert.deepEqual(proxyOption('http://h:8080'), { server: 'http://h:8080' });
});

test('默认身份:默认工作区 1920x1080 且吃 BROWSER_PROXY;别的工作区按种子挑分辨率、不吃代理', () => {
  const d = defaultIdentity(true, { BROWSER_PROXY: 'http://p:1' });
  assert.deepEqual(d.screen, { width: 1920, height: 1080 });
  assert.equal(d.proxy, 'http://p:1');
  assert.throws(() => defaultIdentity(true, { BROWSER_PROXY: 'not a proxy' }), (e) => e instanceof IdentityError);
  const other = defaultIdentity(false, { BROWSER_PROXY: 'http://p:1' }, () => 3);
  assert.deepEqual(other.screen, { width: 1536, height: 864 });
  assert.equal(other.proxy, null);
  assert.equal(other.locale, 'zh-CN');
});

test('身份落盘:没有就建、再读一样;坏了拒绝启动、显式给 proxy 才重建并留 0600 备份;换代理清掉出口记录', () => {
  const dir = tmp();
  const a = loadIdentity(dir, false, {});
  assert.deepEqual(loadIdentity(dir, false, {}), a);
  fs.writeFileSync(path.join(dir, 'identity.json'), '{broken');
  assert.throws(() => loadIdentity(dir, true, {}), (e) => e instanceof IdentityError && e.kind === 'broken');
  assert.throws(() => patchIdentity(dir, true, { humanize: true }), (e) => e instanceof IdentityError, '没给 proxy 不能悄悄重建');
  const rebuilt = patchIdentity(dir, true, { proxy: '' });
  assert.equal(rebuilt.proxyChanged, true);
  const backup = fs.readdirSync(dir).find((n) => n.startsWith('identity.json.broken-'));
  assert.ok(backup, '坏文件要留备份');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, backup)).mode & 0o777, 0o600);
  const withGeo = { ...loadIdentity(dir, true, {}), proxy: 'http://p:1', geo: { proxy: 'http://p:1', ip: '1.1.1.1', timezone: 'America/New_York', country: 'US', at: 1 } };
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify(withGeo));
  const same = patchIdentity(dir, true, { humanize: true });
  assert.equal(same.proxyChanged, false);
  assert.equal(same.identity.geo?.timezone, 'America/New_York');
  assert.equal(same.identity.humanize, true);
  const changed = patchIdentity(dir, true, { proxy: 'socks5://q:2' });
  assert.equal(changed.proxyChanged, true);
  assert.equal(changed.identity.geo, null);
  assert.equal(patchIdentity(dir, true, { proxy: '' }).identity.proxy, null);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'identity.json')).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('默认工作区以运维的 BROWSER_PROXY 为准;格式不对拒绝启动', () => {
  const dir = tmp();
  assert.equal(loadIdentity(dir, true, {}).proxy, null);
  const forced = loadIdentity(dir, true, { BROWSER_PROXY: 'http://10.0.0.2:3128' });
  assert.equal(forced.proxy, 'http://10.0.0.2:3128', '已有身份也要跟上后来配的 BROWSER_PROXY');
  assert.throws(() => loadIdentity(dir, true, { BROWSER_PROXY: 'not a proxy' }), (e) => e instanceof IdentityError && e.kind === 'env');
  const other = tmp();
  assert.equal(loadIdentity(other, false, { BROWSER_PROXY: 'http://10.0.0.2:3128' }).proxy, null, '别的工作区不吃 BROWSER_PROXY');
  fs.rmSync(other, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('经工具挂代理:只许本机 / 局域网或 BROWSER_PROXY_ALLOW 里的主机', () => {
  for (const ok of ['http://127.0.0.1:8080', 'http://u:p@192.168.1.5:3128', 'socks5://10.1.2.3:1080', 'http://172.20.0.1:80', 'http://localhost:3128']) assert.ok(proxyAllowedForTool(ok, {}), ok);
  for (const bad of ['http://attacker.example:8080', 'http://8.8.8.8:3128', 'http://172.32.0.1:80', 'ftp://127.0.0.1:1']) assert.ok(!proxyAllowedForTool(bad, {}), bad);
  assert.ok(proxyAllowedForTool('http://proxy.corp.example:3128', { BROWSER_PROXY_ALLOW: 'proxy.corp.example' }));
  assert.ok(proxyAllowedForTool('http://p.example:3128', { BROWSER_PROXY_ALLOW: 'p.example:3128' }));
  assert.ok(!proxyAllowedForTool('http://p.example:9999', { BROWSER_PROXY_ALLOW: 'p.example:3128' }));
});

test('时区跟出口:只认同一个代理查到的出口', () => {
  const base = defaultIdentity(true, {});
  assert.equal(effectiveTimezone(base), null);
  assert.equal(needsGeo(base), false);
  const p = { ...base, proxy: 'http://p:1' };
  assert.equal(needsGeo(p), true);
  const geo = { proxy: 'http://p:1', ip: '1.1.1.1', timezone: 'Asia/Tokyo', country: 'JP', at: 1 };
  assert.equal(effectiveTimezone({ ...p, geo }), 'Asia/Tokyo');
  assert.equal(needsGeo({ ...p, geo }), false);
  assert.equal(effectiveTimezone({ ...p, proxy: 'http://other:2', geo }), null);
  assert.deepEqual(contextOptions({ ...p, geo }), { proxy: { server: 'http://p:1' }, timezoneId: 'Asia/Tokyo' });
  assert.deepEqual(contextOptions(base), {});
});

test('启动参数:语言三处一致;屏幕只给无头;窗口收进屏幕', () => {
  assert.equal(acceptLanguages('zh-CN'), 'zh-CN,zh,en');
  assert.equal(acceptLanguages('en-US'), 'en-US,en');
  const id = { ...defaultIdentity(false, {}, () => 5), locale: 'zh-CN' };
  assert.deepEqual(identityArgs(id, false, 'win32'), ['--lang=zh-CN', '--accept-lang=zh-CN,zh,en']);
  assert.ok(identityArgs(id, true, 'win32').includes('--screen-info={0,0 1366x768 workAreaBottom=48}'));
  assert.ok(identityArgs(id, true, 'linux').some((a) => a.endsWith('workAreaTop=32}')));
  assert.deepEqual(fitWindow(1280, 800, { width: 1366, height: 768 }, true, 'win32'), { width: 1280, height: 720 });
  assert.deepEqual(fitWindow(1920, 1080, { width: 1920, height: 1080 }, true, 'linux'), { width: 1920, height: 1048 });
  assert.deepEqual(fitWindow(1280, 800, { width: 1366, height: 768 }, false), { width: 1280, height: 800 });
});

test('别的站点导航 / 嵌入到本服务:跨站、同站拒;地址栏直接开、同源、fetch 不管', () => {
  assert.ok(isForeignNavigation('cross-site', 'document'));
  assert.ok(isForeignNavigation('same-site', 'iframe'));
  assert.ok(isForeignNavigation('cross-site', 'object'));
  assert.ok(!isForeignNavigation('none', 'document'));
  assert.ok(!isForeignNavigation('same-origin', 'document'));
  assert.ok(!isForeignNavigation('cross-site', 'empty'));
  assert.ok(!isForeignNavigation(undefined, undefined));
});

test('挂代理:WebRTC 只走代理;时区跟出口时 Linux / macOS 设 TZ、Windows 不设', () => {
  const geo = { proxy: 'http://10.0.0.2:1', ip: '1.1.1.1', timezone: 'Asia/Tokyo', country: 'JP', at: 1 };
  const id = { ...defaultIdentity(false, {}, () => 0), proxy: 'http://10.0.0.2:1', geo };
  assert.ok(identityArgs(id, true, 'linux').includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.ok(!identityArgs(defaultIdentity(false, {}, () => 0), true, 'linux').some((a) => a.includes('webrtc')));
  assert.deepEqual(identityEnv(id, 'linux'), { TZ: 'Asia/Tokyo' });
  assert.deepEqual(identityEnv(id, 'win32'), {});
  assert.deepEqual(identityEnv(defaultIdentity(false, {}, () => 0), 'darwin'), {});
});
