// 工作区身份与反检测相关纯函数的单测(src/identity.ts、src/desk/gate.ts isForeignNavigation,跑构建产物)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  acceptLanguages, contextOptions, defaultIdentity, effectiveTimezone, fitWindow, identityArgs, isProxyUrl,
  loadIdentity, maskProxy, needsGeo, patchIdentity, proxyOption,
} from '../../dist/identity.js';
import { isForeignNavigation } from '../../dist/desk/gate.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'identity-'));

test('代理地址:格式校验、打码、拆账号', () => {
  for (const ok of ['http://1.2.3.4:8080', 'http://u:p@host:3128', 'socks5://host:1080', 'https://proxy.example.com']) assert.ok(isProxyUrl(ok), ok);
  for (const bad of ['ftp://x:1', 'host:8080', 'http://a b:1', 'http://x/path', 'socks5://u:p@host:1080']) assert.ok(!isProxyUrl(bad), bad);
  assert.equal(maskProxy('socks5://user:pa%40ss@h:1080'), 'socks5://***@h:1080');
  assert.equal(maskProxy(null), null);
  assert.deepEqual(proxyOption('socks5://user:pa%40ss@h:1080'), { server: 'socks5://h:1080', username: 'user', password: 'pa@ss' });
  assert.deepEqual(proxyOption('http://h:8080'), { server: 'http://h:8080' });
});

test('默认身份:默认工作区 1920x1080 且吃 BROWSER_PROXY;别的工作区按种子挑分辨率、不吃代理', () => {
  const d = defaultIdentity(true, { BROWSER_PROXY: 'http://p:1' });
  assert.deepEqual(d.screen, { width: 1920, height: 1080 });
  assert.equal(d.proxy, 'http://p:1');
  assert.equal(defaultIdentity(true, { BROWSER_PROXY: 'not a proxy' }).proxy, null);
  const other = defaultIdentity(false, { BROWSER_PROXY: 'http://p:1' }, () => 3);
  assert.deepEqual(other.screen, { width: 1536, height: 864 });
  assert.equal(other.proxy, null);
  assert.equal(other.locale, 'zh-CN');
});

test('身份落盘:没有就建、坏了重建、再读一样;换代理清掉出口记录', () => {
  const dir = tmp();
  const a = loadIdentity(dir, false, {});
  assert.deepEqual(loadIdentity(dir, false, {}), a);
  fs.writeFileSync(path.join(dir, 'identity.json'), '{broken');
  assert.equal(loadIdentity(dir, true, {}).screen.width, 1920);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('identity.json.broken-')), '坏文件要留备份');
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
  fs.rmSync(dir, { recursive: true, force: true });
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
