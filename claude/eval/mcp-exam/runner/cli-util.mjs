/** Small helpers shared by the exam entry points. Judge layer. */
import fs from 'node:fs';
import path from 'node:path';

export function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export async function stdinLines() {
  if (process.stdin.isTTY) return [];
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw.split(/\r?\n/).map((l) => l.trim());
}

export async function pool(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i], i);
    }
  }));
  return out;
}

/** Newest file in dir matching prefix / suffix (date-stamped names sort by date) */
export function latest(dir, prefix, suffix) {
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(suffix)).sort() : [];
  const last = files.at(-1);
  if (!last) throw new Error(`no ${prefix}*${suffix} in evolve/mcp-exam`);
  return path.join(dir, last);
}
