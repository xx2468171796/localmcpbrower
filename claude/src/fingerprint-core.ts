/**
 * 指纹环境(space_new { fingerprint: true })背后的浏览器核心:公司基建 powerbrowser-core
 * (仓库 admin/powerbrowser,接入说明 docs/core.md)。本服务把它当子进程拉起,它在回环口开一个带令牌的
 * 接口,负责指纹内核 + 每环境代理 + 页面伪装;本服务只管经调试端口接管页面。
 *
 * 约定(核心那边保证):
 *   - 启动后在 stdout 打一行 JSON:{ ready, port, token, ... };失败是 { ready:false, error }。
 *   - 我们一直攥着它的 stdin;本进程退出 = stdin 关闭,核心自己关掉所有浏览器再退出,不留孤儿进程。
 *   - 一个数据目录只能有一个核心(有头 / 无头两个服务各用各的目录)。
 *
 * 核心和授权文件放哪:环境变量 POWERBROWSER_CORE / POWERBROWSER_CORE_GRANT,
 * 否则 ~/.ankotti/browser-core/powerbrowser-core.exe 与 browser-mcp.grant(由本机服务 / 发布包放好)。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { browserEnv } from './browser-env.js';

const HOME_DIR = path.join(os.homedir(), '.ankotti', 'browser-core');
/** 第一次用要下载浏览器内核(约 190MB),握手等久一点 */
const HANDSHAKE_TIMEOUT_MS = 240_000;
const API_TIMEOUT_MS = 60_000;
/** 核心给环境起的名字前缀:一眼看出是哪个工作区的 */
const PROFILE_PREFIX = 'mcp-';

interface Handshake { port: number; token: string; version: string }
export interface OpenedProfile { profileId: string; cdpHttp: string }
/** 核心认的代理写法(本服务只放行 http / https / socks5,和普通工作区一致) */
export type CoreProxy =
  | { source: 'direct' }
  | { source: 'custom'; spec: { kind: 'http' | 'https' | 'socks5'; host: string; port: number; username?: string; password?: string } };

/** 把已经通过 isProxyUrl 校验的代理地址换成核心的写法;'' / null = 直连(纯函数) */
export function toCoreProxy(url: string | null | undefined): CoreProxy {
  const v = url?.trim();
  if (!v) return { source: 'direct' };
  const u = new URL(v);
  const kind = u.protocol.replace(':', '').toLowerCase() as 'http' | 'https' | 'socks5';
  const port = Number(u.port || (kind === 'https' ? 443 : kind === 'http' ? 80 : 1080));
  return {
    source: 'custom',
    spec: {
      kind, host: u.hostname.replace(/^\[|\]$/g, ''), port,
      ...(u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}),
    },
  };
}

/** 握手行解析(纯函数):不是 JSON 的行(日志)返回 null */
export function parseHandshake(line: string): Handshake | { error: string } | null {
  if (!line.trimStart().startsWith('{')) return null;
  let v: Record<string, unknown>;
  try { v = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (v['ready'] === false) return { error: String(v['error'] ?? '浏览器核心启动失败') };
  if (v['ready'] !== true || typeof v['port'] !== 'number' || typeof v['token'] !== 'string') return null;
  return { port: v['port'], token: v['token'], version: String(v['version'] ?? '') };
}

function locate(envName: string, fileName: string, what: string): string {
  const fromEnv = process.env[envName]?.trim();
  const file = fromEnv || path.join(HOME_DIR, fileName);
  if (!fs.existsSync(file)) {
    throw new Error(`这台电脑还没装指纹浏览器核心(找不到${what}:${file})。请管理员经本机服务下发,或设环境变量 ${envName}`);
  }
  return file;
}

export class FingerprintCore {
  private child: ChildProcess | null = null;
  private starting: Promise<Handshake> | null = null;
  private ready: Handshake | null = null;

  constructor(private readonly dataDir: string) {}

  /** 拉起核心(已在跑就直接用);并发调用合并成一次启动 */
  private start(): Promise<Handshake> {
    if (this.ready && this.child && this.child.exitCode === null) return Promise.resolve(this.ready);
    this.starting ??= this.spawnCore().finally(() => { this.starting = null; });
    return this.starting;
  }

  private spawnCore(): Promise<Handshake> {
    if (process.platform !== 'win32') return Promise.reject(new Error('指纹环境目前只支持 Windows'));
    const exe = locate('POWERBROWSER_CORE', 'powerbrowser-core.exe', '核心程序');
    const grant = locate('POWERBROWSER_CORE_GRANT', 'browser-mcp.grant', '授权文件');
    fs.mkdirSync(this.dataDir, { recursive: true });
    const child = spawn(exe, ['serve', '--data-dir', this.dataDir, '--grant', grant], {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: browserEnv(),
    });
    this.child = child;
    child.stdin?.on('error', () => { /* 核心先退了,exit 事件会处理 */ });
    return new Promise<Handshake>((resolve, reject) => {
      let settled = false;
      const done = (fn: () => void): void => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
      const timer = setTimeout(() => done(() => { child.kill(); reject(new Error('浏览器核心启动超时(首次使用要下载内核,稍后再试)')); }), HANDSHAKE_TIMEOUT_MS);
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (line) => {
        const hs = parseHandshake(line);
        if (!hs) return;
        if ('error' in hs) done(() => reject(new Error(`浏览器核心启动失败:${hs.error}`)));
        else done(() => { this.ready = hs; resolve(hs); });
      });
      child.once('error', (e) => done(() => reject(new Error(`浏览器核心起不来:${e.message}`))));
      child.once('exit', (code) => {
        if (this.child === child) { this.child = null; this.ready = null; }
        done(() => reject(new Error(`浏览器核心启动后就退出了(退出码 ${code ?? '无'})`)));
      });
    });
  }

  private async api<T>(method: string, route: string, body?: unknown): Promise<T> {
    const hs = await this.start();
    const res = await fetch(`http://127.0.0.1:${hs.port}/api/v1${route}`, {
      method,
      headers: { 'X-Api-Key': hs.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const json = await res.json() as { code: number | string; data?: T; message?: string };
    if (json.code !== 0) throw new Error(json.message ?? `浏览器核心返回错误 ${json.code}`);
    return json.data as T;
  }

  /** 按工作区名找到(没有就新建)对应的指纹环境,返回环境 ID。新建时带上代理;已有的不动它的设置 */
  async ensureProfile(space: string, proxy: CoreProxy): Promise<{ profileId: string; created: boolean }> {
    const name = `${PROFILE_PREFIX}${space}`;
    const found = await this.api<{ items: { id: string; name: string }[] }>('GET', `/profiles?search=${encodeURIComponent(name)}&pageSize=50`);
    const hit = found.items.find((p) => p.name === name);
    if (hit) return { profileId: hit.id, created: false };
    const made = await this.api<{ id: string }>('POST', '/profiles', { name, proxy, tags: ['browser-mcp'] });
    return { profileId: made.id, created: true };
  }

  async setProxy(profileId: string, proxy: CoreProxy): Promise<void> {
    await this.api('PATCH', `/profiles/${profileId}`, { proxy });
  }

  /** 打开环境(已开着就先关再开:上一次没关干净的,调试端口我们并不知道) */
  async open(profileId: string): Promise<OpenedProfile> {
    const running = await this.api<{ profileId: string }[]>('GET', '/running');
    if (running.some((r) => r.profileId === profileId)) await this.close(profileId);
    return this.api<OpenedProfile>('POST', `/profiles/${profileId}/open`);
  }

  async close(profileId: string): Promise<void> {
    if (!this.ready || !this.child) return;   // 核心没在跑 = 浏览器也没在跑
    await this.api('POST', `/profiles/${profileId}/close`).catch((e: unknown) => {
      console.warn(`[fingerprint-core] 关闭环境 ${profileId} 失败:${e instanceof Error ? e.message : String(e)}`);
    });
  }

  /** 退出钩子里同步调:关掉 stdin,核心自己收尾(关浏览器、落盘 cookie)后退出 */
  stopSync(): void {
    try { this.child?.stdin?.end(); } catch { /* 已经没了 */ }
  }
}
