// 落盘位置回归(全部用临时目录,不碰在跑的服务):
//   1. 老位置(安装目录 storage/)的 profile、工作区、截图搬到数据目录,登录态文件跟着走;Windows 上跨盘搬
//   2. 浏览器和 patchright 的临时文件进数据目录下本服务自己的 tmp,不进系统临时目录
//   3. 每日清理删掉 2 天没动过的临时文件
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); };
const legacy = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-'));
// Windows 上把数据目录放到别的盘,覆盖跨盘复制那条路;没有别的盘或非 Windows 就同盘
const otherDrive = process.platform === 'win32' ? ['E:', 'D:', 'F:', 'G:'].find((d) => d !== os.tmpdir().slice(0, 2).toUpperCase() && fs.existsSync(d + '/')) : null;
const data = fs.mkdtempSync(path.join(otherDrive ? otherDrive + '/' : os.tmpdir(), 'localmcp-data-test-'));
fs.mkdirSync(path.join(legacy, 'user_data', 'Default'), { recursive: true });
fs.writeFileSync(path.join(legacy, 'user_data', 'Default', 'Cookies'), 'login-state');
fs.mkdirSync(path.join(legacy, 'user_data-spaces', 'shop'), { recursive: true });
fs.mkdirSync(path.join(legacy, 'screenshots'), { recursive: true });
fs.writeFileSync(path.join(legacy, 'screenshots', 'a.png'), 'png');
process.env.LOCALMCP_LEGACY_DIR = legacy;
process.env.LOCALMCP_DATA_DIR = data;
process.env.USER_DATA_DIR = path.join(legacy, 'user_data');
process.env.HEADLESS = 'true';
const systemTmp = os.tmpdir();

const { getBrowserManager } = await import('../dist/browser.js');
const { cleanDisk } = await import('../dist/reclaim.js');
const bm = getBrowserManager();
await bm.killOrphans();

check('profile 搬到数据目录,登录态文件还在', fs.readFileSync(path.join(data, 'user_data', 'Default', 'Cookies'), 'utf8') === 'login-state');
check('老 profile 目录已删', !fs.existsSync(path.join(legacy, 'user_data')));
check('工作区跟着搬', fs.existsSync(path.join(data, 'user_data-spaces', 'shop')) && !fs.existsSync(path.join(legacy, 'user_data-spaces')));
check('截图跟着搬', fs.existsSync(path.join(data, 'screenshots', 'a.png')));
check('没留下搬了一半的目录', !fs.readdirSync(data).some((n) => n.endsWith('.moving')));
const tmp = os.tmpdir();
check('临时目录改到数据目录下', tmp.startsWith(path.join(data, 'tmp')) && tmp !== systemTmp, tmp);

// 真开浏览器:能用,且临时文件落在新临时目录
const page = await bm.getPage();
await page.goto('data:text/html,<title>ok</title>');
check('浏览器在新位置正常工作', (await page.title()) === 'ok');
check('浏览器临时文件写进新临时目录', fs.readdirSync(tmp).length > 0, fs.readdirSync(tmp).slice(0, 3).join(', '));
await bm.close();

// 每日清理:2 天前的临时文件删掉,新的留着
const old = path.join(tmp, 'old-file');
const fresh = path.join(tmp, 'fresh-file');
fs.writeFileSync(old, 'x');
fs.writeFileSync(fresh, 'x');
const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
fs.utimesSync(old, threeDaysAgo, threeDaysAgo);
const r = cleanDisk({ userDataDir: path.join(data, 'user_data'), screenshotDir: path.join(data, 'screenshots'), inUse: new Set(), tmpDir: tmp });
check('2 天前的临时文件被清理,新的留着', !fs.existsSync(old) && fs.existsSync(fresh), `清了 ${r.tmp} 个`);

for (const d of [legacy, data]) fs.rmSync(d, { recursive: true, force: true });
process.exit(results.every(Boolean) ? 0 : 1);
