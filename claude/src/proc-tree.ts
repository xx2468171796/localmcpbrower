/**
 * Linux 下按 /proc 算一棵进程树的常驻内存(Chromium 是一堆子进程,只看主进程会严重低估)。
 * 只给管理接口的 /admin/metrics 用,偶尔调一次,同步读文件即可。
 */

import fs from 'node:fs';

/** 读 /proc 建「父 → 子」表 */
function childrenMap(): Map<number, number[]> {
  const map = new Map<number, number[]>();
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let stat: string;
    try { stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8'); } catch { continue; }
    // 第 2 段是带括号的进程名(可能含空格),父进程号在右括号之后第 2 个字段
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(after[1]);
    if (!Number.isFinite(ppid)) continue;
    const list = map.get(ppid) ?? [];
    list.push(Number(name));
    map.set(ppid, list);
  }
  return map;
}

function rssOf(pid: number): number {
  try {
    const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
    return m?.[1] ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

/** 以 root 为根的整棵树:总 RSS(字节)和进程数;根进程不存在返回 null */
export function linuxTreeRss(root: number): { rss: number; count: number } | null {
  if (!fs.existsSync(`/proc/${root}`)) return null;
  const kids = childrenMap();
  let rss = 0;
  let count = 0;
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    rss += rssOf(pid);
    count++;
    for (const c of kids.get(pid) ?? []) stack.push(c);
  }
  return { rss, count };
}
