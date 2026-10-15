// 路径收口的单测(src/safe-path.ts,跑构建产物 dist/safe-path.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  isInside, normalizeForCompare, parseRootList, realpathLoose, resolveReadPath, resolveWritePath,
  safeFileName, uploadAllowRoots, isStrictPaths,
} from '../../dist/safe-path.js';

const posix = { platform: 'posix', realpath: (p) => p };
const win = { platform: 'win32', realpath: (p) => p };
const denied = (fn) => assert.throws(fn, (e) => e.code === 'PATH_DENIED');

test('safeFileName: plain names pass, traversal / separators / drive colon rejected', () => {
  assert.equal(safeFileName('home-page'), 'home-page');
  assert.equal(safeFileName('  截图 1 '), '截图 1');
  for (const bad of ['../x', '..', 'a/b', 'a\\b', 'C:x', 'x\u0000', '', 'a..b', 'x'.repeat(201)]) denied(() => safeFileName(bad));
});

test('isInside: posix', () => {
  assert.equal(isInside('/data/pdf/a.pdf', '/data/pdf', 'posix'), true);
  assert.equal(isInside('/data/pdf', '/data/pdf/', 'posix'), true);
  assert.equal(isInside('/data/pdf2/a.pdf', '/data/pdf', 'posix'), false);
  assert.equal(isInside('/data/x', '/data/pdf', 'posix'), false);
});

test('isInside: windows is case-insensitive, knows drive letters and mixed separators', () => {
  assert.equal(isInside('D:\\Data\\PDF\\a.pdf', 'd:/data/pdf', 'win32'), true);
  assert.equal(isInside('E:\\data\\pdf\\a.pdf', 'D:\\data\\pdf', 'win32'), false);
  assert.equal(isInside('D:\\data\\pdfx\\a.pdf', 'D:\\data\\pdf', 'win32'), false);
  assert.equal(normalizeForCompare('C:\\', 'win32'), 'c:\\');
});

test('resolveWritePath: relative stays in base, traversal denied in every mode', () => {
  const pol = { baseDir: '/data/pdf', allowRoots: [], strict: false, extension: '.pdf' };
  assert.equal(resolveWritePath('report', pol, posix), '/data/pdf/report.pdf');
  assert.equal(resolveWritePath('sub/r.PDF', pol, posix), '/data/pdf/sub/r.PDF');
  denied(() => resolveWritePath('../../etc/x.pdf', pol, posix));
  denied(() => resolveWritePath('a/../../x.pdf', { ...pol, strict: true }, posix));
});

test('resolveWritePath: absolute outside roots allowed locally, denied in strict mode; extension forced', () => {
  const pol = { baseDir: '/data/pdf', allowRoots: ['/data/shots'], strict: false, extension: '.pdf' };
  assert.equal(resolveWritePath('/tmp/out.pdf', pol, posix), '/tmp/out.pdf');
  assert.equal(resolveWritePath('/home/u/.bashrc', pol, posix), '/home/u/.bashrc.pdf');
  const strict = { ...pol, strict: true };
  denied(() => resolveWritePath('/tmp/out.pdf', strict, posix));
  assert.equal(resolveWritePath('/data/shots/a.pdf', strict, posix), '/data/shots/a.pdf');
  assert.equal(resolveWritePath('D:\\DATA\\PDF\\a.pdf', { ...strict, baseDir: 'd:\\data\\pdf', allowRoots: [] }, win), 'D:\\DATA\\PDF\\a.pdf');
  denied(() => resolveWritePath('C:\\Windows\\a.pdf', { ...strict, baseDir: 'd:\\data\\pdf', allowRoots: [] }, win));
});

test('resolveWritePath: symlinked directory pointing outside is caught via realpath', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-path-'));
  const base = path.join(root, 'pdf');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(base); fs.mkdirSync(outside);
  const link = path.join(base, 'link');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    fs.rmSync(root, { recursive: true, force: true });
    return; // 没权限建链接的环境跳过
  }
  try {
    assert.throws(() => resolveWritePath('link/x.pdf', { baseDir: base, allowRoots: [], strict: false, extension: '.pdf' }),
      (e) => e.code === 'PATH_DENIED');
    assert.equal(realpathLoose(path.join(link, 'new', 'x.pdf')), path.join(fs.realpathSync.native(outside), 'new', 'x.pdf'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveReadPath: allowlist, relative paths, missing files', () => {
  const stat = (p) => (p.endsWith('.txt') ? { isFile: () => true } : p.endsWith('dir') ? { isFile: () => false } : null);
  assert.equal(resolveReadPath('/any/where/a.txt', { allowRoots: null }, posix, stat), '/any/where/a.txt');
  assert.equal(resolveReadPath('/data/uploads/a.txt', { allowRoots: ['/data/uploads'] }, posix, stat), '/data/uploads/a.txt');
  denied(() => resolveReadPath('/home/u/.ssh/id_rsa.txt', { allowRoots: ['/data/uploads'] }, posix, stat));
  denied(() => resolveReadPath('/data/uploads/../secret.txt', { allowRoots: ['/data/uploads'] }, posix, stat));
  denied(() => resolveReadPath('a.txt', { allowRoots: null }, posix, stat));
  assert.throws(() => resolveReadPath('/x/missing.bin', { allowRoots: null }, posix, stat), (e) => e.code === 'INVALID_ARGS');
  assert.throws(() => resolveReadPath('/x/dir', { allowRoots: null }, posix, stat), (e) => e.code === 'INVALID_ARGS');
  assert.equal(resolveReadPath('d:\\Data\\Uploads\\A.txt', { allowRoots: ['D:\\data\\uploads'] }, win, stat), 'd:\\Data\\Uploads\\A.txt');
});

test('upload allowlist: unrestricted locally, restricted when managed or UPLOAD_ALLOW_DIRS set', () => {
  const builtin = ['/data/uploads'];
  assert.equal(uploadAllowRoots(builtin, {}, 'posix'), null);
  assert.deepEqual(uploadAllowRoots(builtin, { DESK_ID: 'd1' }, 'posix'), ['/data/uploads']);
  assert.deepEqual(uploadAllowRoots(builtin, { UPLOAD_ALLOW_DIRS: '/a:/b' }, 'posix'), ['/data/uploads', '/a', '/b']);
  assert.deepEqual(parseRootList('C:\\a;D:\\b;', 'win32'), ['C:\\a', 'D:\\b']);
  assert.equal(isStrictPaths({ STRICT_PATHS: '1' }), true);
  assert.equal(isStrictPaths({}), false);
});
