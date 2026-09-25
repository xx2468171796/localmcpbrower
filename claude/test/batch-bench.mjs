// batch_fetch 并发测速：8 个不同站点，concurrency 1 对比 4（delay 都是 500ms）
import path from 'node:path';
const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
const c = new Client({ name: 'batch-bench', version: '1' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), 'bin', 'shim.mjs'), 'headless'] }));
const urls = ['https://example.com/', 'https://example.org/', 'https://example.net/', 'https://www.iana.org/', 'https://go.dev/', 'https://nodejs.org/en', 'https://www.python.org/', 'https://www.rust-lang.org/'];
for (const concurrency of [1, 4]) {
  const t = Date.now();
  const r = await c.callTool({ name: 'batch_fetch', arguments: { urls, delay: 500, concurrency } });
  const d = (r._meta?.['localmcp/result'] ?? JSON.parse(r.content[0].text));
  const ok = d.data.results.filter((x) => x.success).length;
  const order = d.data.results.every((x, i) => x.url === urls[i]);
  console.log(`concurrency=${concurrency}: ${Date.now() - t}ms, 成功 ${ok}/${urls.length}, 顺序${order ? '一致' : '错乱'}`);
}
const tabs = await c.callTool({ name: 'list_tabs', arguments: {} });
console.log('结束后标签页数:', tabs._meta?.['localmcp/result']?.data?.tabs?.length ?? '?');
await c.close();
