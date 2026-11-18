#!/usr/bin/env node
/**
 * 把灰度中的版本转正(三个发布项目一起),或只看现在的状态。业主说转正时由 AI 直接跑(堡垒机 2026-11-19 起允许老板自己的 AI 转正)。
 *
 *   node scripts/promote-release.mjs <版本>            转正
 *   node scripts/promote-release.mjs <版本> --status   只看各项目里这个版本和稳定版的状态,不改
 */
import { panelCookie } from './register-release.mjs';

const PROJECTS = ['localmcpbrower', 'localmcpbrower-windows-x86_64', 'localmcpbrower-linux-x86_64'];

async function main() {
  const version = process.argv[2];
  if (!version || version.startsWith('--')) throw new Error('用法:node scripts/promote-release.mjs <版本> [--status]');
  const statusOnly = process.argv.includes('--status');
  const { origin, cookie } = await panelCookie();
  for (const project of PROJECTS) {
    const list = await (await fetch(`${origin}/api/admin/releases/${project}`, { headers: { cookie } })).json();
    const rows = Array.isArray(list) ? list : [];
    const row = rows.find((r) => r.version === version);
    const stable = rows.find((r) => r.status === 'stable')?.version ?? '无';
    if (!row) throw new Error(`${project} 里没有登记 ${version}`);
    if (statusOnly || row.status !== 'canary') {
      console.log(`${project}@${version}:${row.status}${row.status === 'canary' ? ` ${row.canaryPct}%` : ''}(稳定版 ${stable})`);
      continue;
    }
    const res = await fetch(`${origin}/api/admin/releases/${project}/${version}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'promote' }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`转正 ${project}@${version} 失败 HTTP ${res.status}:${body.message ?? ''}`);
    console.log(`已转正 ${project}@${version}(原稳定版 ${stable})`);
  }
}

main().catch((e) => {
  console.error(`[promote] ${e.message}`);
  process.exitCode = 1;
});
