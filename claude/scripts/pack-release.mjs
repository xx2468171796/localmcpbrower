#!/usr/bin/env node
/**
 * 打发布包(给堡垒机发布中心登记,员工电脑上的本机服务 / ai-kit 更新器下载安装,见 README「自动更新」)。
 *
 *   node scripts/pack-release.mjs [--version 2.4.0] [--out ../release] [--root <claude 目录>] [--commit <sha>] [--no-deps]
 *                                 [--platform windows-x86_64 | linux-x86_64 | … | all]
 *
 * - 先 `npm run build`(要 dist/),并且要有 package-lock.json;
 * - 版本号:--version > 环境变量 ANKOTTI_RELEASE_VERSION(发布中心流水线的候选版本号)> package.json;
 *   写进包里的 package.json / package-lock.json,运行中的服务、遥测、/health 都报这个号;
 * - 包里只有运行要的东西(dist、bin、mcp.mjs、PM2 配置、package*.json、说明),不含 storage、logs、源码、考卷;
 *   3.0.3 起**自带生产依赖**(claude/node_modules,按锁文件在临时目录 `npm ci --omit=dev --ignore-scripts` 装出来,
 *   不是开发机自己的 node_modules):员工电脑解开就能跑,不再 npm install / 编译。生产依赖没有原生模块,
 *   Windows / Linux / macOS 同一个包;各平台只有 Chromium 不同,由 bin/install-browser.mjs 从公司下载节点装。
 *   node_modules/.bin 不带(各平台不一样,运行时也不用);--no-deps 打老式不带依赖的包;
 *   路径都在 claude/ 下,另带 release.json(版本、提交、打包时刻、deps = 带没带依赖);
 * - 格式 tar.gz(ustar,超长路径用 pax 头),文件按路径排序、文件时间戳固定为 0。
 * - 包根上有 manifest.json({ files: { 路径: sha256 } },本机服务解包后逐个核对)。
 * 每个包输出一行 JSON:{ project, version, file, sha256, size }。零依赖,只用 Node 自带模块。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 包里要带的(相对 claude/):目录整个带,文件不存在就跳过(必需的另查) */
// extension = 自带 Chrome 扩展(3.0 起,录制 / 浏览器内网络规则 / 全标签页):运行时按 dist 的相对位置加载,漏打包等于这些工具全失效
export const INCLUDE = ['dist', 'bin', 'extension', 'mcp.mjs', 'ecosystem.config.cjs', 'ecosystem.headless.config.cjs', 'start.bat', 'stop.bat', 'check-mcp-health.sh', 'install.sh', 'README.md', 'package.json', 'package-lock.json'];
const REQUIRED = ['dist/server.js', 'bin/shim.mjs', 'extension/manifest.json', 'mcp.mjs', 'package.json', 'package-lock.json'];
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

/** skip(rel) 为真的不进包(连同下面的东西) */
function walk(root, rel, out, skip = () => false) {
  if (skip(rel)) return;
  const abs = path.join(root, rel);
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) throw new Error(`包里不放符号链接:${rel}`);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) walk(root, path.posix.join(rel, name), out, skip);
  } else if (st.isFile()) {
    out.push(rel);
  }
}

/** 一个 512 字节的 ustar 头 */
function header(name, size, type, mtime) {
  const h = Buffer.alloc(512);
  const put = (str, off, len) => h.write(str, off, Math.min(len, Buffer.byteLength(str)), 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  put(name, 0, 100);
  put(oct(type === '5' ? 0o755 : 0o644, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(mtime, 12), 136, 12);
  h.fill(' ', 148, 156);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);

/** 一个文件的 tar 记录(路径超过 100 字节先发一个 pax 头) */
export function tarEntry(name, data, mtime = 0) {
  const parts = [];
  if (Buffer.byteLength(name) > 100) {
    const body = (len) => `${len} path=${name}\n`;
    let len = Buffer.byteLength(body(0));
    while (Buffer.byteLength(body(len)) !== len) len = Buffer.byteLength(body(len));
    const pax = Buffer.from(body(len));
    parts.push(header('PaxHeader', pax.length, 'x', mtime), pax, pad(pax.length));
  }
  parts.push(header(Buffer.byteLength(name) > 100 ? name.slice(0, 99) : name, data.length, '0', mtime), data, pad(data.length));
  return Buffer.concat(parts);
}

/** files: [[路径, Buffer]] → tar.gz Buffer */
export function tarGz(files, mtime = 0) {
  const body = Buffer.concat([...files.map(([n, d]) => tarEntry(n, d, mtime)), Buffer.alloc(1024)]);
  return zlib.gzipSync(body, { level: 9, mtime: 0 });
}

function stamp(json, version) {
  const v = JSON.parse(json);
  v.version = version;
  if (v.packages?.['']) v.packages[''].version = version;
  return Buffer.from(JSON.stringify(v, null, 2) + '\n');
}

function gitCommit(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return null;
  }
}

/**
 * 按锁文件在临时目录装一份干净的生产依赖,返回它所在的目录(里面有 node_modules/);用完调用方删。
 * 源用环境变量 npm_config_registry / NPM_REGISTRY(构建机设成公司下载节点),都没有就 npm 默认源。
 */
export function prodDeps(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmb-deps-'));
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(root, f), path.join(dir, f));
  const registry = process.env.npm_config_registry || process.env.NPM_REGISTRY;
  const args = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', ...(registry ? [`--registry=${registry}`] : [])];
  // Windows 上 npm 是 .cmd,要经 cmd.exe(参数里没有空格,不用加引号)
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', ['npm.cmd', ...args].join(' ')]] : ['npm', args];
  execFileSync(cmd, cmdArgs, { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true, timeout: 600_000 });
  return dir;
}

/** 依赖目录里要进包的文件(相对 depsDir;不带 .bin:Linux / macOS 上是符号链接,Windows 上是 .cmd,运行时都不用) */
function depFiles(depsDir) {
  const rels = [];
  walk(depsDir, 'node_modules', rels, (rel) => path.posix.basename(rel) === '.bin');
  return rels;
}

/** 本机服务认的平台名(和它给自己定的发布项目 local-host-<os>-<arch> 同一套) */
export const PLATFORMS = ['windows-x86_64', 'linux-x86_64', 'linux-aarch64', 'macos-x86_64', 'macos-aarch64'];

/** 发布项目名:不带平台 = ai-kit 更新器用的 localmcpbrower;带平台 = 本机服务用的 localmcpbrower-<os>-<arch> */
export function projectName(platform) {
  if (platform && !PLATFORMS.includes(platform)) throw new Error(`平台不认识:${platform}(可选 ${PLATFORMS.join(' / ')})`);
  return platform ? `localmcpbrower-${platform}` : 'localmcpbrower';
}

/** 包根上的 manifest.json:每个文件的 sha256(本机服务解包后逐个核对) */
function manifest(files) {
  return Buffer.from(JSON.stringify({ files: Object.fromEntries(files.map(([n, d]) => [n, createHash('sha256').update(d).digest('hex')])) }, null, 2) + '\n');
}

/**
 * depsDir = prodDeps() 装出来的目录(里面有 node_modules/);不传 = 不带依赖。
 * platform = 本机服务的平台名(见 PLATFORMS);内容各平台一样(依赖没有原生模块),只是发布项目分开登记。
 */
export function pack({ root, version, out, commit, depsDir = null, platform = null }) {
  for (const f of REQUIRED) if (!fs.existsSync(path.join(root, f))) throw new Error(`缺 ${f}(先 npm install 生成锁文件、npm run build)`);
  if (!VERSION_RE.test(version)) throw new Error(`版本号不合法:${version}`);
  const project = projectName(platform);
  const rels = [];
  for (const inc of INCLUDE) if (fs.existsSync(path.join(root, inc))) walk(root, inc, rels);
  const files = rels.sort().map((rel) => {
    const data = fs.readFileSync(path.join(root, rel));
    return [`claude/${rel}`, rel === 'package.json' || rel === 'package-lock.json' ? stamp(data.toString('utf8'), version) : data];
  });
  if (depsDir) for (const rel of depFiles(depsDir).sort()) files.push([`claude/${rel}`, fs.readFileSync(path.join(depsDir, rel))]);
  const meta = { project, version, commit: commit ?? gitCommit(root), packedAt: new Date().toISOString(), deps: Boolean(depsDir) };
  files.unshift(['release.json', Buffer.from(JSON.stringify(meta, null, 2) + '\n')]);
  files.unshift(['manifest.json', manifest(files)]);
  const gz = tarGz(files, 0);
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `${project}-${version}.tgz`);
  fs.writeFileSync(file, gz);
  return { project, version, file, sha256: createHash('sha256').update(gz).digest('hex'), size: gz.length, files: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(arg('root') ?? path.join(HERE, '..'));
  const version = arg('version') ?? process.env.ANKOTTI_RELEASE_VERSION ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  let depsDir = null;
  try {
    if (!process.argv.includes('--no-deps')) depsDir = prodDeps(root);
    const outDir = path.resolve(arg('out') ?? path.join(root, '..', 'release'));
    // --platform all = ai-kit 用的 localmcpbrower + 本机服务的 Windows / Linux 两个(依赖只装一次)
    const p = arg('platform');
    const platforms = p === 'all' ? [null, 'windows-x86_64', 'linux-x86_64'] : [p ?? null];
    for (const platform of platforms) console.log(JSON.stringify(pack({ root, version, out: outDir, commit: arg('commit'), depsDir, platform })));
  } catch (e) {
    console.error(`[pack] ${e.message}`);
    process.exitCode = 1;
  } finally {
    if (depsDir) fs.rmSync(depsDir, { recursive: true, force: true });
  }
}
