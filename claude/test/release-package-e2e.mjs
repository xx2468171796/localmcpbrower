#!/usr/bin/env node
/**
 * 发布包端到端:按员工电脑上的走法验一遍「解开就能跑」——打包(带生产依赖)→ 解到空目录 → 只装 Chromium → 冒烟。
 * 全程不跑 npm install、不编译;冒烟用临时端口 / 临时 profile,不碰本机在用的服务。
 *
 *   node test/release-package-e2e.mjs [--platform windows-x86_64|linux-x86_64] [--mirror <下载节点入口>]...
 *
 * 先 npm run build。--mirror 原样传给 bin/install-browser.mjs(不给就只试公共源)。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pack, prodDeps } from '../scripts/pack-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const platform = argv.includes('--platform') ? argv[argv.indexOf('--platform') + 1] : process.platform === 'win32' ? 'windows-x86_64' : 'linux-x86_64';
const mirrors = argv.flatMap((a, i) => (a === '--mirror' && argv[i + 1] ? ['--mirror', argv[i + 1]] : []));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-pkg-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  ${detail}` : ''}`);
};

try {
  const t0 = Date.now();
  const deps = prodDeps(ROOT);
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const a = pack({ root: ROOT, version, out: path.join(work, 'out'), commit: 'e2e', depsDir: deps, platform });
  fs.rmSync(deps, { recursive: true, force: true });
  check('打包', fs.existsSync(a.file), `${a.project} ${(a.size / 1e6).toFixed(1)}MB ${a.files} 个文件 ${Date.now() - t0}ms`);

  const dir = path.join(work, 'installed');
  fs.mkdirSync(dir);
  // 相对路径:Git Bash 的 GNU tar 会把 C:\… 里的冒号当成远程主机
  execFileSync('tar', ['-xzf', path.relative(dir, a.file).replaceAll('\\', '/')], { cwd: dir, windowsHide: true });
  const claude = path.join(dir, 'claude');
  check('解开后自带依赖', fs.existsSync(path.join(claude, 'node_modules', 'patchright', 'cli.js')) && fs.existsSync(path.join(claude, 'node_modules', 'zod')));
  check('不带开发依赖', !fs.existsSync(path.join(claude, 'node_modules', 'typescript')) && !fs.existsSync(path.join(claude, 'node_modules', 'esbuild')));

  const t1 = Date.now();
  const ib = spawnSync(process.execPath, [path.join(claude, 'bin', 'install-browser.mjs'), ...mirrors], { encoding: 'utf8', timeout: 900_000, windowsHide: true });
  const ibLast = (ib.stdout || '').trim().split('\n').pop() ?? '';
  check('只装 Chromium', ib.status === 0, `${Date.now() - t1}ms ${ibLast.slice(0, 200)}`);

  const t2 = Date.now();
  const smoke = spawnSync(process.execPath, [path.join(claude, 'bin', 'release-smoke.mjs')], { cwd: claude, encoding: 'utf8', timeout: 240_000, windowsHide: true, env: { ...process.env, BROWSER_TELEMETRY: '0' } });
  const smokeLast = (smoke.stdout || smoke.stderr || '').trim().split('\n').pop() ?? '';
  check('冒烟(起服务、开页面、读标记)', smoke.status === 0, `${Date.now() - t2}ms ${smokeLast.slice(0, 200)}`);
} catch (e) {
  check('意外错误', false, String(e?.message ?? e).slice(0, 300));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exitCode = failed ? 1 : 0;
