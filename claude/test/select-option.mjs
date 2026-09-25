// select_option 回归：两者都不给要报错；value="" 要真的选中空选项
process.env.USER_DATA_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'select-'));
process.env.HEADLESS = 'true';
const { getBrowserManager } = await import('../dist/browser.js');
const tools = await import('../dist/tools.js');
const page = await getBrowserManager().getPage();
await page.setContent('<select id="s"><option value="">请选择</option><option value="a" selected>A</option></select>');
const none = await tools.selectOption({ selector: '#s' });
const empty = await tools.selectOption({ selector: '#s', value: '' });
const now = await page.$eval('#s', (el) => el.value);
console.log(`都不给 → ${none.success ? '误报成功' : '报错 ✓'}；value="" → ${empty.success && now === '' ? '选中空选项 ✓' : '没选中（当前 ' + JSON.stringify(now) + '）'}`);
await getBrowserManager().close();
process.exit(!none.success && now === '' ? 0 : 1);
