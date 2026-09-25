/**
 * 工具结果排版:给 AI 读,也让旁边看着的人一眼看懂(照堡垒机 baolei 的 ToolText 做法)。
 *
 * 人在两个地方看结果(Claude Code 的 VSCode 插件):
 *   - 不展开:聊天里的小框按 Markdown 渲染,只露出头几行
 *   - 展开:纯文本原样显示
 * 所以:
 *   - 第一行状态:`✅ 成功 · 打开网页 · 0.42s`,紧接着就是结果
 *   - 整段排成「缩进 4 格的代码块」:小框里是等宽字体、不被当成排版;展开后只是整体缩进
 *   - 短字段一行一个、按中文宽度对齐;长文本(快照、正文、脚本结果)单独成段、保留真换行,不再是一行带 \n 的 JSON
 *   - 对象数组排成对齐的表,太宽就一条一段竖着排
 * 原始结构化结果放在 result._meta['localmcp/result'](AI 和界面都不显示),测试和程序从那里读。
 */

export const RAW_META_KEY = 'localmcp/result';

const ICON = { ok: '✅', fail: '❌' } as const;
const TABLE_WIDTH = 120;
const CELL_WIDTH = 50;
/** 短于这个宽度、且没有换行的字符串算「短字段」,和别的短字段一起对齐列出 */
const SHORT = 100;

/** 常见字段的中文名;没列出的原样显示 */
const LABEL: Record<string, string> = {
  url: '网址', title: '标题', error: '错误', content: '内容', markdown: '正文', text: '文本', html: 'HTML',
  snapshot: '页面快照', refCount: '元素数', truncated: '已截断', items: '数据', results: '结果', result: '结果',
  links: '链接', tabs: '标签页', index: '序号', active: '当前', status: '状态码', method: '方法', count: '数量',
  total: '总数', pages: '页数', selected: '已选中', filled: '已填', clicked: '已点击', path: '路径', value: '值',
  byline: '作者', excerpt: '摘要', length: '字数', textPreview: '预览', success: '成功', spaces: '工作区',
  name: '名称', reason: '原因', elapsedSec: '等待秒数', width: '宽', height: '高', format: '格式',
};
const label = (k: string) => LABEL[k] ?? k;

export function width(text: string): number {
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x20 || (c >= 0x300 && c <= 0x36f) || c === 0x200d || (c >= 0xfe00 && c <= 0xfe0f)) continue;
    w += wide(c) ? 2 : 1;
  }
  return w;
}

function wide(c: number): boolean {
  return (
    (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0x303e) || (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) || (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd)
  );
}

const padEnd = (t: string, w: number) => t + ' '.repeat(Math.max(0, w - width(t)));
const padStart = (t: string, w: number) => ' '.repeat(Math.max(0, w - width(t))) + t;

/** 整段排成缩进 4 格的代码块;开头结尾空行去掉 */
export function block(text: string): string {
  return text.replace(/^\s*\n/, '').replace(/\s+$/, '').split('\n').map((l) => (l ? `    ${l}` : '')).join('\n');
}

function indent(text: string, n = 2): string {
  const pad = ' '.repeat(n);
  return text.split('\n').map((l) => (l ? pad + l : '')).join('\n');
}

/** 对齐的纯文本表;太宽就竖排(一条一段,一个字段一行) */
export function table(columns: string[], rows: string[][]): string {
  const widths = columns.map((c, i) => Math.max(width(c), ...rows.map((r) => width(r[i] ?? ''))));
  const total = widths.reduce((a, b) => a + b, 0) + 2 * (columns.length - 1);
  const tooWide = total > TABLE_WIDTH || rows.some((r) => r.some((cell) => width(cell) > CELL_WIDTH));
  if (tooWide) {
    const kw = Math.max(...columns.map(width));
    return rows.map((r, n) => [`── 第 ${n + 1} 条 ──`, ...columns.map((c, i) => `${padEnd(c, kw)}  ${r[i] ?? ''}`)].join('\n')).join('\n');
  }
  const numeric = columns.map((_, i) => rows.every((r) => /^-?\d+(\.\d+)?$/.test(r[i] ?? '')));
  const line = (cells: string[]) =>
    cells.map((c, i) => (numeric[i] ? padStart(c, widths[i]!) : i === cells.length - 1 ? c : padEnd(c, widths[i]!))).join('  ').replace(/\s+$/, '');
  return [line(columns), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const scalarText = (v: unknown) => (v === null ? '—' : typeof v === 'boolean' ? (v ? '是' : '否') : String(v));
const isShort = (v: unknown) => isScalar(v) && (typeof v !== 'string' || (!v.includes('\n') && width(v) <= SHORT));
/** 表格单元格:压成一行,不截断(信息不能丢,太宽 table 会自己改竖排) */
const cell = (v: unknown) => (isScalar(v) ? scalarText(v) : JSON.stringify(v)).replace(/\s*\n\s*/g, ' ⏎ ');

/** 把任意数据排成人看得懂的文本 */
export function render(value: unknown, depth = 0): string {
  if (value === undefined) return '';
  if (isScalar(value)) return scalarText(value);
  if (Array.isArray(value)) return renderArray(value, depth);
  if (typeof value !== 'object') return String(value);
  if (depth >= 3) return JSON.stringify(value, null, 2);

  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
  const short = entries.filter(([, v]) => isShort(v));
  const long = entries.filter(([, v]) => !isShort(v));
  const out: string[] = [];
  if (short.length) {
    const kw = Math.max(...short.map(([k]) => width(label(k))));
    out.push(...short.map(([k, v]) => `${padEnd(label(k), kw)}  ${scalarText(v)}`));
  }
  for (const [k, v] of long) {
    const body = render(v, depth + 1);
    const n = Array.isArray(v) ? `(${v.length})` : '';
    out.push(`${out.length ? '\n' : ''}── ${label(k)}${n} ──`, body === '' ? '(空)' : body);
  }
  return out.join('\n');
}

function renderArray(arr: unknown[], depth: number): string {
  if (arr.length === 0) return '(空)';
  if (arr.every(isScalar)) return arr.map((v) => `- ${scalarText(v)}`).join('\n');
  if (arr.every((v) => v && typeof v === 'object' && !Array.isArray(v))) {
    const cols: string[] = [];
    for (const row of arr as Record<string, unknown>[]) for (const k of Object.keys(row)) if (!cols.includes(k)) cols.push(k);
    return table(cols.map(label), (arr as Record<string, unknown>[]).map((row) => cols.map((k) => (row[k] === undefined ? '' : cell(row[k])))));
  }
  return arr.map((v, i) => `[${i + 1}]\n${indent(render(v, depth + 1))}`).join('\n');
}

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/** 一次工具调用的完整文本:状态行 + 结果(或错误) */
export function formatResult(title: string, result: { success?: boolean; data?: unknown; error?: string }, ms: number): string {
  const ok = result.success !== false;
  const head = `${ok ? ICON.ok : ICON.fail} ${ok ? '成功' : '失败'} · ${title} · 耗时 ${seconds(ms)}`;
  // 失败时去掉 JS 调用栈(`    at eval …` 这类行),人和 AI 都只需要原因
  const error = (result.error ?? '未知错误').split('\n').filter((l) => !/^\s+at\s/.test(l)).join('\n');
  const body = ok ? render(result.data) : error;
  return block(body ? `${head}\n${body}` : head);
}
