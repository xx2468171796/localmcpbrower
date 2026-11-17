// 指纹环境接浏览器核心的纯函数单测(src/fingerprint-core.ts,跑构建产物)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseHandshake, toCoreProxy } from '../../dist/fingerprint-core.js';

test('握手行:就绪、失败、日志行', () => {
  assert.deepEqual(
    parseHandshake('{"ready":true,"version":"0.2.10","port":51234,"baseUrl":"http://127.0.0.1:51234","token":"abc","profileLimit":0}'),
    { port: 51234, token: 'abc', version: '0.2.10' },
  );
  assert.deepEqual(parseHandshake('{"ready":false,"error":"授权已过期"}'), { error: '授权已过期' });
  assert.equal(parseHandshake('2026-11-18 INFO starting'), null);
  assert.equal(parseHandshake('{not json'), null);
  // 缺端口 / 令牌的不算握手,继续等下一行
  assert.equal(parseHandshake('{"ready":true,"port":"51234","token":"abc"}'), null);
  assert.equal(parseHandshake('{"ready":true,"port":51234}'), null);
});

test('代理写法:直连、带账号、默认端口、IPv6', () => {
  assert.deepEqual(toCoreProxy(''), { source: 'direct' });
  assert.deepEqual(toCoreProxy(null), { source: 'direct' });
  assert.deepEqual(toCoreProxy('  '), { source: 'direct' });
  assert.deepEqual(toCoreProxy('socks5://host:1081'), { source: 'custom', spec: { kind: 'socks5', host: 'host', port: 1081 } });
  assert.deepEqual(toCoreProxy('http://u%40x:p%3Aw@1.2.3.4:3128'), {
    source: 'custom', spec: { kind: 'http', host: '1.2.3.4', port: 3128, username: 'u@x', password: 'p:w' },
  });
  assert.equal(toCoreProxy('https://proxy.example.com').spec.port, 443);
  assert.equal(toCoreProxy('http://proxy.example.com').spec.port, 80);
  assert.equal(toCoreProxy('socks5://proxy.example.com').spec.port, 1080);
  assert.equal(toCoreProxy('socks5://[::1]:1080').spec.host, '::1');
});
