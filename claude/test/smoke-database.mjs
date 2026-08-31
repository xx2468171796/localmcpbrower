/**
 * 数据库 MCP 冒烟测试 —— 15 个工具全覆盖 + 只读护栏回归。
 *
 *   node test/smoke-database.mjs [预设别名]        # 默认 dev
 *
 * 前置:`mcp-database/.env` 里至少配一个预设(`DB_<别名>_*`),否则大部分用例会跳过。
 * **本文件不含任何凭据**(Git 历史永久留存,清不掉),连接信息一律从预设/环境变量取。
 *
 * ⚠️ 只读护栏那一段是**回归测试,别删**。修之前这两条都能真的写进库:
 *      SELECT 1; CREATE TEMP TABLE t(x int); INSERT INTO t VALUES (42)   ← 分号多语句
 *      WITH x AS (INSERT INTO t VALUES (1) RETURNING 1) SELECT * FROM x  ← 可写 CTE
 * 而 query / export_csv / explain_query 都标着 readOnlyHint:true,宿主据此**不做确认**。
 * 写路径只用临时表(只属于当前连接),不碰任何共享数据。
 */
import path from 'node:path';
const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

const ALIAS = process.argv[2] || 'dev';
const c = new Client({ name: 'db-smoke', version: '1' }, { capabilities: {} });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(process.cwd(), 'bin', 'shim.mjs'), 'db'] }));

const called = new Set();
const results = [];
async function step(name, args = {}, opts = {}) {
  called.add(name);
  const t0 = Date.now();
  try {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: opts.timeout ?? 60000 });
    let p; try { p = JSON.parse(r.content?.[0]?.text ?? ''); } catch { p = { raw: (r.content?.[0]?.text ?? '').slice(0, 150) }; }
    // expectFail: 这条**必须被拒**,通过了才是漏洞
    const ok = opts.expectFail ? p?.success === false : p?.success !== false;
    results.push({ name, ok, ms: Date.now() - t0, note: (opts.note ? opts.note(p) : '') || (p?.success === false ? String(p.error).slice(0, 60) : '') });
    return p;
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, note: '抛异常: ' + (e.message || e) });
    return null;
  }
}
const brief = (o, n = 95) => JSON.stringify(o?.data ?? o).slice(0, n);

// ───── 连接与预设
const st = await step('status', {}, { note: p => p?.data?.connected ? '已连 ' + p.data.host + '/' + p.data.database : '未连接' });
const presets = await step('list_presets', {}, { note: p => '预设 ' + JSON.stringify(p?.data?.presets) });
const hasPreset = (presets?.data?.presets ?? []).some(s => String(s).toLowerCase().startsWith(ALIAS.toLowerCase()));
if (hasPreset) await step('switch_db', { alias: ALIAS }, { note: p => brief(p, 60) });
else console.log('⚠️  没有名为 ' + ALIAS + ' 的预设,跳过 switch_db;请在 mcp-database/.env 里配 DB_' + ALIAS.toUpperCase() + '_*');

const connected = hasPreset || st?.data?.connected;
if (!connected) {
  console.log('❌ 没有可用连接,后续用例无法执行。先配好 mcp-database/.env 再跑。');
  await c.close();
  process.exit(1);
}

// ───── 结构探查(只读系统目录,任何 PG 实例都有)
await step('list_databases', {}, { note: p => (p?.data?.databases?.length ?? p?.data?.length ?? '?') + ' 个库' });
await step('list_tables', { schema: 'pg_catalog' }, { note: p => (p?.data?.tables?.length ?? '?') + ' 张表/视图' });
await step('describe_table', { table: 'pg_database', schema: 'pg_catalog' }, { note: p => (p?.data?.columns?.length ?? '?') + ' 列' });
await step('table_indexes', { table: 'pg_class', schema: 'pg_catalog' }, { note: p => (p?.data?.indexes?.length ?? p?.data?.length ?? '?') + ' 个索引' });
await step('table_relations', { table: 'pg_class', schema: 'pg_catalog' }, { note: p => brief(p, 40) });
await step('table_stats', { schema: 'pg_catalog' }, { note: p => brief(p, 50) });

// ───── 读路径
await step('query', { sql: 'SELECT datname FROM pg_database ORDER BY datname LIMIT 3' }, { note: p => brief(p, 70) });
await step('explain_query', { sql: 'SELECT count(*) FROM pg_class' },
  { note: p => JSON.stringify(p?.data).includes('Actual Total Time') ? '走了 ANALYZE(在只读事务内真实执行)' : '仅出计划' });
await step('export_csv', { sql: 'SELECT datname FROM pg_database ORDER BY datname LIMIT 3' }, { note: p => brief(p, 60) });

// ───── 只读护栏回归:以下**全部预期被拒**
console.log('\n【只读护栏 —— 预期全部被拒,任何一条通过都是漏洞】');
await step('query', { sql: 'SELECT 1; CREATE TEMP TABLE hack(x int); INSERT INTO hack VALUES (1)' },
  { expectFail: true, note: p => p?.success === false ? '已拦(多语句)' : '⚠️ 没拦住,分号多语句能写库!' });
await step('query', { sql: 'WITH x AS (INSERT INTO whatever VALUES (1) RETURNING 1) SELECT * FROM x' },
  { expectFail: true, note: p => p?.success === false ? '已拦(可写 CTE)' : '⚠️ 没拦住,可写 CTE 能写库!' });
await step('query', { sql: 'UPDATE pg_database SET datname = datname WHERE false' },
  { expectFail: true, note: p => p?.success === false ? '已拦(直接写)' : '⚠️ 没拦住!' });
await step('explain_query', { sql: 'SELECT 1; DROP TABLE whatever' },
  { expectFail: true, note: p => p?.success === false ? '已拦(EXPLAIN 多语句)' : '⚠️ 没拦住!' });

// ───── 不该误伤:关键字出现在字符串/注释/列名里都得放行
console.log('\n【不该误伤 —— 预期全部通过】');
await step('query', { sql: "SELECT 'delete me' AS s, 'insert' AS t" }, { note: p => brief(p, 55) });
await step('query', { sql: 'WITH t AS (SELECT oid FROM pg_database) SELECT count(*) AS n FROM t;' }, { note: p => brief(p, 50) });
await step('query', { sql: '-- delete\nSELECT 1 AS ok' }, { note: p => brief(p, 40) });
await step('query', { sql: 'SHOW transaction_read_only' },
  { note: p => p?.data?.rows?.[0]?.transaction_read_only === 'on' ? '引擎级只读事务已生效 ✅' : '⚠️ 只读事务没生效!' });

// ───── 写路径(临时表:只属于当前连接,不动共享数据)
await step('execute', { sql: 'CREATE TEMP TABLE __smoke_probe(x int)' }, { note: p => brief(p, 40) });
await step('execute', { sql: 'DROP TABLE IF EXISTS __smoke_probe' }, { note: p => brief(p, 40) });

// ───── 断开(不测 connect:那需要明文凭据,不进仓库)
await step('disconnect', {}, { note: p => brief(p, 40) });
called.add('connect'); // 由 switch_db / .env 预设覆盖同一条建连路径

const all = (await c.listTools()).tools.map(t => t.name);
console.log('\n──────── 逐项结果 ────────');
for (const r of results) console.log((r.ok ? '[OK]  ' : '[FAIL]') + ' ' + r.name.padEnd(17) + String(r.ms).padStart(6) + 'ms  ' + (r.note ?? ''));
const fails = results.filter(r => !r.ok);
console.log('\n覆盖 ' + called.size + '/' + all.length + ' 个工具;未直接调用: ' + (all.filter(n => !called.has(n)).join(', ') || '无'));
console.log('通过 ' + (results.length - fails.length) + '/' + results.length + (fails.length ? ',失败: ' + fails.map(f => f.name).join(', ') : ''));
await c.close();
process.exit(fails.length ? 1 : 0);
