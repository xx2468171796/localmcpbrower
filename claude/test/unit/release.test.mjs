// 自动更新相关的单测:活动计数(src/activity.ts)、shim 断线续接(bin/session-relay.mjs)、发布包(scripts/pack-release.mjs)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { Activity, packageVersion } from '../../dist/activity.js';
import { LineSplitter, REPLAY_ID_PREFIX, SessionRelay } from '../../bin/session-relay.mjs';
import { pack, tarGz } from '../../scripts/pack-release.mjs';
import { downloadHosts } from '../../bin/install-browser.mjs';

test('Activity: inFlight 随调用增减,lastCallAt 记开始和结束,结束函数重复调用只算一次', () => {
  let now = 1000;
  const a = new Activity(() => now);
  assert.deepEqual(a.snapshot(), { inFlight: 0, lastCallAt: null, calls: 0 });
  const end1 = a.begin();
  now = 2000;
  const end2 = a.begin();
  assert.deepEqual(a.snapshot(), { inFlight: 2, lastCallAt: 2000, calls: 2 });
  now = 3000;
  end1();
  end1();
  assert.deepEqual(a.snapshot(), { inFlight: 1, lastCallAt: 3000, calls: 2 });
  end2();
  assert.equal(a.snapshot().inFlight, 0);
});

test('packageVersion: 读 package.json,读不出给 0.0.0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '2.4.0-rc.1' }));
  assert.equal(packageVersion(path.join(dir, 'package.json')), '2.4.0-rc.1');
  assert.equal(packageVersion(path.join(dir, 'nope.json')), '0.0.0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LineSplitter: 跨块的行拼起来,不完整的尾巴留着', () => {
  const s = new LineSplitter();
  assert.deepEqual(s.push('{"a":1}\n{"b"'), ['{"a":1}']);
  assert.deepEqual(s.push(':2}\n'), ['{"b":2}']);
  assert.equal(s.rest, '');
});

test('SessionRelay: 断线时在途请求各回一条错误,重放开场请求换新 id 并吞掉它的回复', () => {
  const r = new SessionRelay();
  assert.equal(r.canResume(), false);
  r.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 'x' } }));
  assert.equal(r.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 0, result: {} })), true);
  r.fromClient(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  r.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assert.equal(r.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [] } })), true);
  r.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'navigate' } }));
  r.fromClient(JSON.stringify({ jsonrpc: '2.0', id: 'x3', method: 'tools/call', params: { name: 'snapshot' } }));
  // 服务发给客户端的请求(elicitation)照样转发,不当回复
  assert.equal(r.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'elicitation/create' })), true);

  const errors = r.failPending('test').map((l) => JSON.parse(l));
  assert.deepEqual(errors.map((e) => e.id), [2, 'x3']);
  assert.ok(errors.every((e) => e.error.code === -32603));
  assert.deepEqual(r.failPending('again'), []);

  assert.equal(r.canResume(), true);
  const [opening, ...notes] = r.replayLines();
  const o = JSON.parse(opening);
  assert.equal(o.method, 'initialize');
  assert.ok(String(o.id).startsWith(REPLAY_ID_PREFIX));
  assert.deepEqual(o.params, { protocolVersion: 'x' });
  assert.deepEqual(notes.map((l) => JSON.parse(l).method), ['notifications/initialized']);
  // 重放的回复吞掉,别的照转
  assert.equal(r.fromServer(JSON.stringify({ jsonrpc: '2.0', id: o.id, result: {} })), false);
  assert.equal(r.fromServer(JSON.stringify({ jsonrpc: '2.0', id: 5, result: {} })), true);
  // 解析不了的行照转
  assert.equal(r.fromClient('not json'), true);
  assert.equal(r.fromServer('not json'), true);
});

/** 测试用的最小 tar 读取(ustar + pax path) */
function untar(gz) {
  const buf = zlib.gunzipSync(gz);
  const out = new Map();
  let paxPath = null;
  for (let off = 0; off + 512 <= buf.length; ) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/s, '').trim(), 8);
    const type = String.fromCharCode(h[156]);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    assert.equal(parseInt(h.subarray(148, 156).toString('utf8'), 8), sum, `校验和:${name}`);
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      paxPath = /\d+ path=(.*)\n/.exec(data.toString('utf8'))?.[1] ?? null;
      continue;
    }
    out.set(paxPath ?? name, Buffer.from(data));
    paxPath = null;
  }
  return out;
}

test('tarGz: 超长路径走 pax 头,内容原样', () => {
  const long = `claude/dist/${'x'.repeat(120)}.js`;
  const files = untar(tarGz([['a.txt', Buffer.from('hi')], [long, Buffer.from('long')]]));
  assert.equal(files.get('a.txt').toString(), 'hi');
  assert.equal(files.get(long).toString(), 'long');
});

test('pack: 只带运行要的文件,版本号写进 package.json / 锁文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-'));
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  w('package.json', JSON.stringify({ name: 'claudemcp-browser', version: '2.4.0' }));
  w('package-lock.json', JSON.stringify({ name: 'claudemcp-browser', version: '2.4.0', packages: { '': { version: '2.4.0' } } }));
  w('dist/server.js', 'console.log(1)');
  w('bin/shim.mjs', '//');
  w('mcp.mjs', '//');
  w('extension/manifest.json', '{}');
  w('src/server.ts', 'secret source');
  w('storage/data-root.txt', 'E:/x');
  w('node_modules/x/index.js', '//');
  const out = path.join(root, 'out');
  const a = pack({ root, version: '2.4.1-rc.1', out, commit: 'abc' });
  const files = untar(fs.readFileSync(a.file));
  assert.deepEqual([...files.keys()].sort(), ['claude/bin/shim.mjs', 'claude/dist/server.js', 'claude/extension/manifest.json', 'claude/mcp.mjs', 'claude/package-lock.json', 'claude/package.json', 'manifest.json', 'release.json'], '开发机自己的 node_modules 不进包');
  assert.equal(JSON.parse(files.get('claude/package.json')).version, '2.4.1-rc.1');
  assert.equal(JSON.parse(files.get('claude/package-lock.json')).packages[''].version, '2.4.1-rc.1');
  assert.equal(JSON.parse(files.get('release.json')).commit, 'abc');
  assert.equal(JSON.parse(files.get('release.json')).deps, false);
  assert.equal(a.project, 'localmcpbrower');
  assert.match(a.sha256, /^[0-9a-f]{64}$/);
  // 带依赖 + 平台:依赖从 depsDir 来(不带 .bin),发布项目和文件名带平台,manifest 核得上每个文件
  const deps = path.join(root, 'deps');
  fs.mkdirSync(path.join(deps, 'node_modules', 'zod'), { recursive: true });
  fs.mkdirSync(path.join(deps, 'node_modules', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(deps, 'node_modules', 'zod', 'index.js'), 'zod');
  fs.writeFileSync(path.join(deps, 'node_modules', '.bin', 'tsc'), 'bin');
  // Linux 上 .bin 里是符号链接:要整个跳过,不能报「不放符号链接」(Windows 没权限建链接就只测普通文件)
  try { fs.symlinkSync('../zod/index.js', path.join(deps, 'node_modules', '.bin', 'zod')); } catch { /* 没权限建符号链接 */ }
  const b = pack({ root, version: '2.4.1-rc.1', out, commit: 'abc', depsDir: deps, platform: 'linux-x86_64' });
  assert.equal(b.project, 'localmcpbrower-linux-x86_64');
  assert.equal(path.basename(b.file), 'localmcpbrower-linux-x86_64-2.4.1-rc.1.tgz');
  const bf = untar(fs.readFileSync(b.file));
  assert.equal(bf.get('claude/node_modules/zod/index.js').toString(), 'zod');
  assert.ok(!bf.has('claude/node_modules/.bin/tsc'));
  assert.equal(JSON.parse(bf.get('release.json')).project, 'localmcpbrower-linux-x86_64');
  const m = JSON.parse(bf.get('manifest.json')).files;
  assert.deepEqual(Object.keys(m).sort(), [...bf.keys()].filter((k) => k !== 'manifest.json').sort());
  for (const [k, sha] of Object.entries(m)) assert.equal(createHash('sha256').update(bf.get(k)).digest('hex'), sha, k);
  assert.throws(() => pack({ root, version: '2.4.1', out, commit: 'abc', platform: 'windows-arm' }), /平台不认识/);
  assert.throws(() => pack({ root, version: 'bad version', out, commit: 'abc' }), /版本号不合法/);
  fs.rmSync(path.join(root, 'package-lock.json'));
  assert.throws(() => pack({ root, version: '2.4.1', out, commit: 'abc' }), /package-lock\.json/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('install-browser: 先按顺序试下载节点的 /playwright,公共源最后,重复的去掉', () => {
  assert.deepEqual(downloadHosts(['--mirror', 'http://a:18790/c.x/', '--mirror', 'http://b/c.y', '--mirror', 'http://a:18790/c.x']), [
    'http://a:18790/c.x/playwright',
    'http://b/c.y/playwright',
    'https://cdn.npmmirror.com/binaries/playwright',
  ]);
  assert.deepEqual(downloadHosts([]), ['https://cdn.npmmirror.com/binaries/playwright']);
});

test('host-switch: 参数、空闲、健康、数据目录(绝不放进版本目录)', async () => {
  const hs = await import('../../bin/host-switch.mjs');
  const a = hs.parseArgs(['--to', '/v/3.0.3', '--version', '3.0.3', '--idle-min', 'x']);
  assert.deepEqual(a, { to: '/v/3.0.3', version: '3.0.3', from: null, idleMin: 10, waitMin: 15, manager: 'ankotti-local' });
  const now = 1_000_000;
  assert.equal(hs.isIdle([{ inFlight: 0, lastCallAt: null }, null], now, 600_000), true);
  assert.equal(hs.isIdle([{ inFlight: 1, lastCallAt: null }], now, 600_000), false);
  assert.equal(hs.isIdle([{ inFlight: 0, lastCallAt: now - 60_000 }], now, 600_000), false);
  assert.equal(hs.isIdle([{ inFlight: 0, lastCallAt: now - 700_000 }], now, 600_000), true);
  assert.equal(hs.isIdle([{ browserSessions: 0 }], now, 600_000), false, '报不了活动的老版本不算空闲');
  assert.equal(hs.healthy({ status: 'ok', browserAlive: true, version: '3.0.3' }, '3.0.3', true), true);
  assert.equal(hs.healthy({ status: 'ok', browserAlive: true }, '3.0.3', true), false, '新版本必须报版本号');
  assert.equal(hs.healthy({ status: 'ok', browserAlive: true }, '2.3.0', false), true);
  const to = path.resolve('/c/3.0.3');
  const base = path.resolve('/home/u/.ankotti/browser-mcp');
  assert.equal(hs.pickDataRoot('E:/localmcp-data', null, to, base), 'E:/localmcp-data');
  assert.equal(hs.pickDataRoot(null, 'E:\localmcp-data', to, base), 'E:\localmcp-data');
  assert.equal(hs.pickDataRoot(null, path.join(to, 'claude', 'storage'), to, base), path.join(base, 'data'), '挑到版本目录里的不要');
  assert.equal(hs.pickDataRoot(null, null, to, base), path.join(base, 'data'));
});
