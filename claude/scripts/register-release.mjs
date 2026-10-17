#!/usr/bin/env node
/**
 * 把 pack-release.mjs 打出来的包登记到堡垒机发布中心(流程见 docs/memory/release.md)。
 *
 *   node scripts/register-release.mjs <版本> [--dir ../release] [--note "一句话说明"] [--dry-run]
 *
 * - 在 --dir 里找这个版本的包:localmcpbrower-<版本>.tgz(ai-kit 后备)、localmcpbrower-<os>-<arch>-<版本>.tgz(本机服务);
 *   sha256 / 大小现算,不信任何手抄的值;
 * - 每个包先 HEAD 安装源 https://baolei.zygskins.cn/dl/evolve/<项目>/<版本>/<文件>,取不到或大小不对就停(先上传,见 release.md);
 * - 登记走面板接口 POST /api/admin/releases:用本机 ~/.claude.json 里的 baolei MCP 密钥换一次性 AI 面板票据,
 *   密钥只在内存里,不打印;--dry-run 只列要登记的内容。
 * 新项目第一次登记直接是稳定版,已有稳定版的项目新版本先灰度(发布中心的规则)。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DL = (process.env.DOWNLOAD_SOURCE ?? 'https://baolei.zygskins.cn/dl').replace(/\/+$/, '');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** 目录里这个版本的包 → [{ project, file, path }](纯函数,测试用) */
export function findPacks(names, version) {
  const esc = version.replace(/[.+]/g, (c) => `\\${c}`);
  const re = new RegExp(`^(localmcpbrower(?:-[a-z]+-[a-z0-9_]+)?)-${esc}\\.tgz$`);
  return names.map((file) => ({ file, m: re.exec(file) })).filter((x) => x.m).map((x) => ({ project: x.m[1], file: x.file }));
}

async function panelCookie() {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8')).mcpServers?.baolei;
  const auth = cfg?.headers?.Authorization ?? cfg?.headers?.authorization;
  if (!cfg?.url || typeof auth !== 'string') throw new Error('~/.claude.json 里没有 baolei MCP(url + Authorization)');
  const origin = new URL(cfg.url).origin;
  const t = await fetch(`${origin}/api/auth/ai-ticket`, { method: 'POST', headers: { authorization: auth } });
  if (!t.ok) throw new Error(`换面板票据失败 HTTP ${t.status}`);
  const login = await fetch(`${origin}${(await t.json()).path}`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  if (!cookie.includes('zh_at=')) throw new Error(`票据登录失败 HTTP ${login.status}`);
  return { origin, cookie };
}

async function main() {
  const version = process.argv[2];
  if (!version || version.startsWith('--')) throw new Error('用法:node scripts/register-release.mjs <版本> [--dir ../release] [--note …] [--dry-run]');
  const dir = path.resolve(arg('dir') ?? path.join(HERE, '..', '..', 'release'));
  const packs = findPacks(fs.existsSync(dir) ? fs.readdirSync(dir) : [], version);
  if (!packs.length) throw new Error(`${dir} 里没有 ${version} 的包(先 node scripts/pack-release.mjs --version ${version} --platform all)`);
  const note = arg('note') ?? `localmcpbrower ${version}`;
  const items = packs.map((p) => {
    const buf = fs.readFileSync(path.join(dir, p.file));
    return { project: p.project, version, url: `${DL}/evolve/${p.project}/${version}/${p.file}`, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length, note };
  });
  for (const it of items) console.log(`${it.project}@${version}  ${it.sha256.slice(0, 16)}…  ${it.size} 字节  ${it.url}`);
  if (process.argv.includes('--dry-run')) return;
  for (const it of items) {
    const head = await fetch(it.url, { method: 'HEAD' });
    const len = Number(head.headers.get('content-length'));
    if (!head.ok || len !== it.size) throw new Error(`${it.url} 取不到或大小不对(HTTP ${head.status},${len} ≠ ${it.size}):先上传到 sz:/opt/baolei-dl/evolve/${it.project}/${version}/`);
  }
  const { origin, cookie } = await panelCookie();
  for (const it of items) {
    const res = await fetch(`${origin}/api/admin/releases`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(it) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`登记 ${it.project}@${version} 失败 HTTP ${res.status}:${body.message ?? ''}`);
    console.log(`已登记 ${it.project}@${version}:${body.status ?? 'ok'}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`[register] ${e.message}`);
    process.exitCode = 1;
  });
}
