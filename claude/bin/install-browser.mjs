#!/usr/bin/env node
/**
 * 发布包解开后装 Chromium(本机服务 / ai-kit 更新器在冒烟之前跑它;包里已经带了生产依赖,不用 npm install)。
 *
 *   node bin/install-browser.mjs [--mirror <下载节点入口>]...   (退出码 0 = 装好了,最后一行是 JSON 结果)
 *
 * - --mirror 给公司下载节点的入口(@ankotti/jingxiang mirrorEntries 返回的那种,形如 http://节点:18790/c.xxx),
 *   可以给多个,按顺序试;浏览器从 <入口>/playwright 下。都不行最后才试公共源 npmmirror。
 * - 只装完整版 Chromium(--no-shell):3.0 起无头也用它,chromium-headless-shell 用不到,省 120MB。
 * - PLAYWRIGHT_SKIP_BROWSER_GC=1:老版本还在用旧浏览器,不让 patchright 删(Windows 上删不掉会卡住)。
 * - 已经装好的同一版本 patchright 自己会跳过,重复跑没关系。
 * - Linux 缺系统库时这里装不了(要 root):结果里 hint 给出要人跑的命令。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_HOST = 'https://cdn.npmmirror.com/binaries/playwright';

/** 要试的浏览器下载地址:各下载节点的 /playwright,最后是公共源(纯函数) */
export function downloadHosts(argv) {
  const mirrors = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--mirror' && argv[i + 1]) mirrors.push(argv[++i].replace(/\/+$/, ''));
  return [...new Set([...mirrors.map((m) => `${m}/playwright`), PUBLIC_HOST])];
}

function installFrom(host) {
  const cli = path.join(ROOT, 'node_modules', 'patchright', 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'install', 'chromium', '--no-shell'], {
    cwd: ROOT,
    env: { ...process.env, PLAYWRIGHT_DOWNLOAD_HOST: host, PLAYWRIGHT_SKIP_BROWSER_GC: '1' },
    encoding: 'utf8',
    timeout: 900_000,
    windowsHide: true,
  });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-1500) };
}

function main() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'patchright', 'cli.js'))) {
    console.log(JSON.stringify({ ok: false, error: '包里没有 node_modules(老式不带依赖的包),要先 npm ci --omit=dev' }));
    return 1;
  }
  const tried = [];
  for (const host of downloadHosts(process.argv.slice(2))) {
    const t0 = Date.now();
    const r = installFrom(host);
    if (r.ok) {
      console.log(JSON.stringify({ ok: true, host, ms: Date.now() - t0, tried }));
      return 0;
    }
    tried.push({ host, out: r.out.split('\n').filter(Boolean).slice(-3).join(' | ') });
  }
  const hint = process.platform === 'linux' ? `缺系统库时请人在终端跑一次:cd ${ROOT} && sudo node node_modules/patchright/cli.js install-deps chromium` : undefined;
  console.log(JSON.stringify({ ok: false, error: 'Chromium 装不上(下载节点和公共源都试过)', tried, hint }));
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
