/**
 * 从堡垒机取资产(密码 / 账号 / 2FA 码 / 自定义字段),给 fill_secret / login_with_asset 用。
 *
 * - 身份:本机主人的堡垒机 MCP 密钥(baoleiEndpoint,和遥测、ai-kit 同一套查找顺序);托管工位由管理服务注入
 *   BAOLEI_MCP_URL + BAOLEI_MCP_TOKEN(该工位专属、只勾资产能力的 AI 密钥)。每次取用都是堡垒机里一次
 *   get_asset 调用,堡垒机自己记审计。
 * - 堡垒机 MCP 的 get_asset 只回人读的文字(2026-10 版本 3.2.0 没有 structuredContent),这里按行严格解析:
 *   只认开头的「字段: 值」区,解析不出就当取不到,绝不猜。
 * - 取到的值只在内存里过一遍,调用方填完即丢;本模块不打日志、不缓存明文。
 */

import os from 'node:os';
import { baoleiEndpoint, type TelemetryTarget } from '../telemetry.js';
import { ToolError } from '../errors.js';

export interface AssetInfo {
  id: string;
  name: string;
  address: string;
  account: string;
  tags: string[];
  /** reveal 时才有:secret 和各字段(加密字段也会解开) */
  secret?: string;
  fields: Record<string, string>;
}

const PLACEHOLDER = /^\((stored|encrypted|empty)[^)]*\)$/;
/** 头部区里不是「资产字段」的元数据键 */
const META_KEYS = new Set(['address', 'account', 'secret', 'spec', 'tags', 'note', 'shared with', 'external links', 'status', 'expires', 'project', 'owner']);

/** 解析 get_asset 的文字输出(reveal 或不 reveal 都可) */
export function parseAssetText(text: string): AssetInfo | null {
  const lines = text.split(/\r?\n/);
  const head = /^\s*Asset\s+(\d+)\s+·\s+[^·]+·\s+(.+?)(\s+·\s+project\s|\s+·\s+owner\s|$)/.exec(lines[0] ?? '');
  if (!head) return null;
  const info: AssetInfo = { id: head[1] ?? '', name: (head[2] ?? '').trim(), address: '', account: '', tags: [], fields: {} };
  for (const line of lines.slice(1)) {
    if (!line.trim() || /^\s*(Intro version|```)/.test(line)) break;
    const m = /^\s{2,}([^:：]+?):\s(.*)$/.exec(line);
    if (!m) continue;
    const key = (m[1] ?? '').trim();
    const value = (m[2] ?? '').trim();
    const placeholder = PLACEHOLDER.test(value);
    if (key === 'address') info.address = value;
    else if (key === 'account') info.account = value;
    else if (key === 'tags') info.tags = value.split(/\s*,\s*/).filter(Boolean);
    else if (key === 'secret') { if (!placeholder) info.secret = value; }
    else if (!META_KEYS.has(key) && !placeholder) info.fields[key] = value;
  }
  return info;
}

/** 解析 get_asset otp=true 的输出:「2FA code for X (acc): 12345678 — valid 29s more; next 87654321」 */
export function parseOtpText(text: string): { code: string; validSec: number; next?: string } | null {
  const m = /:\s*(\d{6,10})\s*[—-]+\s*valid\s+(\d+)s\b(?:.*?\bnext\s+(\d{6,10}))?/.exec(text);
  if (!m?.[1]) return null;
  return { code: m[1], validSec: Number(m[2]), next: m[3] };
}

/**
 * 资产登记的站点:从 address(可能写成「http://a:1（外网 http://b）」这种)和 tags 里抽出所有主机名。
 * 只认像网址 / 域名 / IP 的片段。
 */
export function assetHosts(info: Pick<AssetInfo, 'address' | 'tags'>): string[] {
  const hosts = new Set<string>();
  const add = (raw: string): void => {
    try {
      const h = new URL(raw.includes('://') ? raw : `http://${raw}`).hostname.toLowerCase();
      if (h && (h.includes('.') || h === 'localhost')) hosts.add(h);
    } catch { /* 不是网址 */ }
  };
  for (const m of info.address.matchAll(/[a-z][a-z0-9+.-]*:\/\/[^\s()（）,，;；<>"']+/gi)) add(m[0]);
  for (const m of info.address.matchAll(/(?:^|[\s(（,，])((?:[a-z0-9-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?=$|[\s/)）,，;；])/gi)) if (m[1]) add(m[1]);
  for (const t of info.tags) if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(t)) add(t);
  return [...hosts];
}

/** 资产地址里写了网址、且全是 https → 页面也必须是 https(防止降级到明文 http 的同名站点) */
export function requiresHttps(info: Pick<AssetInfo, 'address'>): boolean {
  const schemes = [...info.address.matchAll(/\b([a-z][a-z0-9+.-]*):\/\//gi)].map((m) => (m[1] ?? '').toLowerCase());
  return schemes.length > 0 && schemes.every((s) => s === 'https');
}

/** 页面主机名是否属于资产登记的站点(同名或子域名;IP 只认完全相同) */
export function hostMatches(pageHost: string, hosts: string[]): boolean {
  const h = pageHost.toLowerCase();
  return hosts.some((a) => h === a || (!/^\d+(\.\d+){3}$/.test(a) && h.endsWith(`.${a}`)));
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

/**
 * 堡垒机 2026-10 起 get_asset 附带的机器可读数据 `_meta["baolei/data"]`(资产权限版本)。
 * 「代填」路径下明文只在这里、不进文字;旧版堡垒机没有它,退回解析文字。
 */
export interface BaoleiAssetData {
  id?: string | number;
  name?: string;
  address?: string;
  account?: string;
  hosts?: string[];
  secret?: string;
  fields?: Record<string, string>;
  otp?: { code: string; remaining?: number; next?: string };
  pending?: { requestId?: string; status?: string; expiresAt?: string; retryAfter?: number };
}

interface CallResult { text: string; data: BaoleiAssetData | null; isError: boolean }

export class BaoleiAssets {
  constructor(
    private readonly target: TelemetryTarget | null = baoleiEndpoint(process.env, os.homedir()),
    private readonly fetcher: Fetcher = fetch,
    /** 资产要求「每次使用要主人批准」时,最多等多久(期间每 pollMs 重试一次) */
    private readonly approvalWaitMs = 90_000,
    private readonly pollMs = 5_000,
  ) {}

  get configured(): boolean {
    return this.target !== null;
  }

  /** useOn = 要填进去的页面(来源);新版堡垒机据此在服务端再核对站点、记审计 */
  async info(asset: string, reveal: boolean, useOn?: string): Promise<AssetInfo> {
    const r = await this.call({ asset, reveal }, useOn);
    if (r.data && (r.data.name || r.data.id !== undefined)) return fromData(r.data, asset);
    const info = parseAssetText(r.text);
    if (!info) throw new ToolError('SECRET_UNAVAILABLE', `堡垒机没有返回资产「${asset}」的信息:${firstLine(r.text)}`);
    return info;
  }

  async otp(asset: string, useOn?: string): Promise<string> {
    const r = await this.call({ asset, otp: true }, useOn);
    const o = r.data?.otp;
    const parsed = o?.code ? { code: o.code, validSec: o.remaining ?? 30, next: o.next } : parseOtpText(r.text);
    if (!parsed) throw new ToolError('SECRET_UNAVAILABLE', `资产「${asset}」取不到两步验证码:${firstLine(r.text)}`);
    // 快过期的码填进去也来不及提交,用下一个
    return parsed.validSec <= 3 && parsed.next ? parsed.next : parsed.code;
  }

  /**
   * get_asset,带上 use_on;处理三种新版堡垒机的答复:
   *   ASSET_USE_PENDING  资产要主人批准 → 每 pollMs 重试,最多等 approvalWaitMs(主人在手机上一批就接着填)
   *   ASSET_USE_DENIED   主人拒绝 → 停
   *   ASSET_USE_ORIGIN   堡垒机核对站点不符 → 拒填
   * 旧版堡垒机不认 use_on 时去掉它再试一次。
   */
  private async call(args: Record<string, unknown>, useOn?: string): Promise<CallResult> {
    const withUse = useOn ? { ...args, use_on: useOn } : args;
    let r = await this.rpc(withUse);
    if (r.isError && useOn && /use_on|unrecognized|unknown (key|arg)|invalid (arg|param)/i.test(r.text)) r = await this.rpc(args);
    const deadline = Date.now() + this.approvalWaitMs;
    while (r.isError && /^\s*ASSET_USE_PENDING/.test(r.text)) {
      if (Date.now() + this.pollMs > deadline) {
        const id = r.data?.pending?.requestId ?? /request=(\S+)/.exec(r.text)?.[1] ?? '';
        throw new ToolError('SECRET_PENDING_APPROVAL', `这个账号每次使用都要主人批准,已推送到主人手机(请求 ${id}),${Math.round(this.approvalWaitMs / 1000)} 秒内还没批;批准后再调一次即可,别换别的办法`);
      }
      await new Promise((res) => setTimeout(res, this.pollMs));
      r = await this.rpc(withUse);
    }
    if (!r.isError) return r;
    if (/^\s*ASSET_USE_DENIED/.test(r.text)) throw new ToolError('SECRET_UNAVAILABLE', '主人拒绝了这次使用这个账号;别重试,告诉用户');
    if (/^\s*ASSET_USE_ORIGIN/.test(r.text)) throw new ToolError('SECRET_ORIGIN_MISMATCH', `堡垒机核对站点不符,拒绝:${firstLine(r.text)}`);
    throw new ToolError('SECRET_UNAVAILABLE', `堡垒机拒绝:${firstLine(r.text)}`);
  }

  /** 调堡垒机 MCP 的 get_asset(无状态:一次 tools/call 即可) */
  private async rpc(args: Record<string, unknown>): Promise<CallResult> {
    if (!this.target) {
      throw new ToolError('SECRET_UNAVAILABLE', '这台机器没配堡垒机密钥(BAOLEI_MCP_URL + BAOLEI_MCP_TOKEN,或 ~/.claude.json 里的 baolei MCP),取不了资产');
    }
    const res = await this.fetcher(this.target.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.target.token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_asset', arguments: args } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new ToolError('SECRET_UNAVAILABLE', `堡垒机返回 HTTP ${res.status}`);
    const body = await res.text();
    const json = (res.headers.get('content-type') ?? '').includes('event-stream') ? lastSseData(body) : safeJson(body);
    const result = (json as { result?: { isError?: boolean; content?: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown> }; error?: { message?: string } } | null);
    if (!result || result.error) throw new ToolError('SECRET_UNAVAILABLE', `堡垒机报错:${result?.error?.message ?? '无法解析返回'}`);
    const text = result.result?.content?.find((c) => c.type === 'text')?.text ?? '';
    const data = (result.result?._meta?.['baolei/data'] ?? null) as BaoleiAssetData | null;
    return { text, data, isError: Boolean(result.result?.isError) || /^\s*❌/.test(text) };
  }
}

function fromData(d: BaoleiAssetData, ref: string): AssetInfo {
  return {
    id: String(d.id ?? ''),
    name: d.name ?? ref,
    address: d.address ?? '',
    account: d.account ?? '',
    tags: d.hosts ?? [],
    ...(d.secret ? { secret: d.secret } : {}),
    fields: d.fields ?? {},
  };
}

function lastSseData(body: string): unknown {
  const line = body.split('\n').filter((l) => l.startsWith('data:')).pop();
  return line ? safeJson(line.slice(5)) : null;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/** 报错时只带第一行(资产名 / 原因),绝不带后面可能含明文的内容 */
function firstLine(text: string): string {
  const l = text.trim().split(/\r?\n/)[0] ?? '';
  return l.replace(/\bsecret:.*$/i, '').slice(0, 160);
}
