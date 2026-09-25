// 验证取消：批量抓取中途取消后，浏览器应停下，不再跑完剩下的网址
import path from 'node:path';
const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
const c = new Client({ name: 'cancel-probe', version: '1' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), 'bin', 'shim.mjs'), 'headless'] }));
const urls = ['https://example.com/?1', 'https://example.org/?2', 'https://example.net/?3', 'https://example.com/?4', 'https://example.org/?5'];
const ac = new AbortController();
setTimeout(() => ac.abort(), 1500);
const t0 = Date.now();
try { await c.callTool({ name: 'batch_fetch', arguments: { urls, delay: 2000 } }, { signal: ac.signal }); console.log('没被取消？'); }
catch (e) { console.log('客户端取消于', Date.now() - t0, 'ms:', String(e.message).slice(0, 60)); }
await new Promise((r) => setTimeout(r, 10000));
const r = await c.callTool({ name: 'execute_js', arguments: { script: 'location.href' } });
const href = JSON.stringify(r.content?.[0]?.text ?? r).match(/example\.(com|org|net)\/\?\d/)?.[0];
console.log('10 秒后页面停在', href, href && !href.endsWith('5') ? '→ 取消生效（没跑完 5 个）' : '→ 取消未生效');
await c.close();
