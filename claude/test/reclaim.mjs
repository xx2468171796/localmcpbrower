// 资源回收回归(全部用临时 profile,不碰在跑的服务):
//   1. 空闲回收:工作区空闲超时后浏览器被关掉,再用时自动重开
//   2. 数量上限:同时开着的工作区浏览器超过上限,关掉最久没用的
//   3. 孤儿浏览器:服务被强杀后留下的浏览器,能被找出来杀掉
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reclaim-'));
process.env.USER_DATA_DIR = path.join(tmp, 'user_data');
process.env.HEADLESS = 'true';
process.env.MAX_OPEN_SPACES = '2';
const { getBrowserManager } = await import('../dist/browser.js');
const { killOrphanBrowsers } = await import('../dist/reclaim.js');
const bm = getBrowserManager();
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };

// 1. 空闲回收
await bm.getPage();
check('默认工作区浏览器已开', bm.isAlive());
const closed = await bm.reapIdle(Date.now() + 31 * 60_000);
check('空闲 31 分钟后被关掉', closed.includes('default') && !bm.isAlive(), `关了 ${closed.join(',') || '无'}`);
const p = await bm.getPage();
await p.goto('data:text/html,<title>back</title>');
check('再用时自动重开', bm.isAlive() && (await p.title()) === 'back');

// 2. 数量上限(上限 2:default + a 已开,再开 b 时关掉最久没用的)
await bm.createSpace('a');
await new Promise((r) => setTimeout(r, 50));
await bm.createSpace('b');
const openCount = bm.listSpaces().filter((s) => s.alive).length;
check('同时开着的不超过上限 2', openCount <= 2, `开着 ${openCount} 个`);
await bm.close();

// 3. 孤儿浏览器:模拟「服务异常退出、浏览器还在」——中间进程拉起一个脱离的浏览器后自己退出
const orphanDir = path.join(tmp, 'orphan_data');
const { chromium } = await import('patchright');
const exe = chromium.executablePath();
// --no-sandbox:Linux 上直接起 Chromium 不带它会起不来(服务本身也带)
const launchArgs = JSON.stringify(['--headless=new', '--no-sandbox', `--user-data-dir=${orphanDir}`, 'about:blank']);
execFileSync(process.execPath, ['-e', `require('child_process').spawn(${JSON.stringify(exe)}, ${launchArgs}, { detached: true, stdio: 'ignore' }).unref()`]);
await new Promise((r) => setTimeout(r, 2500));
const killed = await killOrphanBrowsers(orphanDir);
check('父进程已不在的浏览器被清理', killed.length === 1, `杀掉 ${killed.length} 个`);
await new Promise((r) => setTimeout(r, 1000));
const again = await killOrphanBrowsers(orphanDir);
check('清理后不再有残留', again.length === 0);
// 反例:父进程还活着的(别的窗口在用)不能动
const live = spawn(exe, ['--headless=new', '--no-sandbox', `--user-data-dir=${orphanDir}`, 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 2500));
const wrong = await killOrphanBrowsers(orphanDir);
check('父进程还活着的浏览器不动', wrong.length === 0 && live.exitCode === null);
live.kill();
await new Promise((r) => setTimeout(r, 1000));

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(results.every(Boolean) ? 0 : 1);
