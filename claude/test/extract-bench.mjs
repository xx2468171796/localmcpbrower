// 正文提取测速：同一页面先打开，再单独计时 extract_article（不含导航）
import path from 'node:path';
const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
const c = new Client({ name: 'extract-bench', version: '1' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), 'bin', 'shim.mjs'), 'headless'] }));
const pages = ['https://en.wikipedia.org/wiki/Model_Context_Protocol', 'https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal', 'https://go.dev/blog/'];
for (const url of pages) {
  await c.callTool({ name: 'navigate', arguments: { url } });
  const t = Date.now();
  const r = await c.callTool({ name: 'extract_article', arguments: {} });
  const ms = Date.now() - t;
  const d = (r._meta?.['localmcp/result'] ?? JSON.parse(r.content[0].text));
  console.log(`${ms}ms`, d.success ? `ok ${d.data.title?.slice(0, 40)} · ${d.data.markdown.length} 字符` : `FAIL ${d.error}`);
}
await c.close();
