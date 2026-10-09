#!/usr/bin/env node
/**
 * 打发布包(给堡垒机发布中心登记,员工电脑上的 ai-kit 更新器下载安装,见 README「自动更新」)。
 *
 *   node scripts/pack-release.mjs [--version 2.4.0] [--out ../release] [--root <claude 目录>] [--commit <sha>]
 *
 * - 先 `npm run build`(要 dist/),并且要有 package-lock.json(按它 npm ci,员工电脑装到的依赖和构建机一模一样);
 * - 版本号:--version > 环境变量 ANKOTTI_RELEASE_VERSION(发布中心流水线的候选版本号)> package.json;
 *   写进包里的 package.json / package-lock.json,运行中的服务、遥测、/health 都报这个号;
 * - 包里只有运行要的东西(dist、bin、mcp.mjs、PM2 配置、package*.json、说明),不含 node_modules、storage、logs、源码、考卷;
 *   路径都在 claude/ 下,另带 release.json(版本、提交、打包时刻);
 * - 格式 tar.gz(ustar,超长路径用 pax 头),文件按路径排序、文件时间戳固定为 0。
 * 输出一行 JSON:{ version, file, sha256, size }。零依赖,只用 Node 自带模块。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 包里要带的(相对 claude/):目录整个带,文件不存在就跳过(必需的另查) */
export const INCLUDE = ['dist', 'bin', 'mcp.mjs', 'ecosystem.config.cjs', 'ecosystem.headless.config.cjs', 'start.bat', 'stop.bat', 'check-mcp-health.sh', 'install.sh', 'README.md', 'package.json', 'package-lock.json'];
const REQUIRED = ['dist/server.js', 'bin/shim.mjs', 'mcp.mjs', 'package.json', 'package-lock.json'];
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) throw new Error(`包里不放符号链接:${rel}`);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) walk(root, path.posix.join(rel, name), out);
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

export function pack({ root, version, out, commit }) {
  for (const f of REQUIRED) if (!fs.existsSync(path.join(root, f))) throw new Error(`缺 ${f}(先 npm install 生成锁文件、npm run build)`);
  if (!VERSION_RE.test(version)) throw new Error(`版本号不合法:${version}`);
  const rels = [];
  for (const inc of INCLUDE) if (fs.existsSync(path.join(root, inc))) walk(root, inc, rels);
  const files = rels.sort().map((rel) => {
    const data = fs.readFileSync(path.join(root, rel));
    return [`claude/${rel}`, rel === 'package.json' || rel === 'package-lock.json' ? stamp(data.toString('utf8'), version) : data];
  });
  const meta = { project: 'localmcpbrower', version, commit: commit ?? gitCommit(root), packedAt: new Date().toISOString() };
  files.unshift(['release.json', Buffer.from(JSON.stringify(meta, null, 2) + '\n')]);
  const gz = tarGz(files, 0);
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, `localmcpbrower-${version}.tgz`);
  fs.writeFileSync(file, gz);
  return { version, file, sha256: createHash('sha256').update(gz).digest('hex'), size: gz.length, files: files.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(arg('root') ?? path.join(HERE, '..'));
  const version = arg('version') ?? process.env.ANKOTTI_RELEASE_VERSION ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  try {
    console.log(JSON.stringify(pack({ root, version, out: path.resolve(arg('out') ?? path.join(root, '..', 'release')), commit: arg('commit') })));
  } catch (e) {
    console.error(`[pack] ${e.message}`);
    process.exit(1);
  }
}
