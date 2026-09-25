// 页面崩溃后自愈（直接驱动 BrowserManager，用临时 profile，不碰在跑的服务）：
// 崩掉当前页 → 再要页面，应拿到一张新的好页，而不是把崩溃的那页捡回来
import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
process.env.USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-recovery-'));
process.env.HEADLESS = 'true';
const { getBrowserManager } = await import('../dist/browser.js');
const bm = getBrowserManager();
const p1 = await bm.getPage();
await p1.goto('chrome://crash').catch(() => {});
await new Promise((r) => setTimeout(r, 2000));
const p2 = await bm.getPage();
const same = p1 === p2;
const ok = await Promise.race([p2.goto('data:text/html,<title>ok</title>').then(() => p2.title()), new Promise((r) => setTimeout(() => r('hang'), 5000))]).catch((e) => 'err ' + e.message.split('\n')[0]);
console.log(`崩溃页已关闭=${p1.isClosed()} 拿到的是同一张崩溃页=${same} 新页可用=${ok}`);
await bm.close();   // 不关的话浏览器会一直留着(以前这里漏了)
process.exit(same || ok !== 'ok' ? 1 : 0);
