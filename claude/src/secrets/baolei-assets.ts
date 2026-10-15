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

/** 页面主机名是否属于资产登记的站点(同名或子域名;IP 只认完全相同) */
export function hostMatches(pageHost: string, hosts: string[]): boolean {
  const h = pageHost.toLowerCase();
  return hosts.some((a) => h === a || (!/^\d+(\.\d+){3}$/.test(a) && h.endsWith(`.${a}`)));
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class BaoleiAssets {
  constructor(
    private readonly target: TelemetryTarget | null = baoleiEndpoint(process.env, os.homedir()),
    private readonly fetcher: Fetcher = fetch,
  ) {}

  get configured(): boolean {
    return this.target !== null;
  }

  async info(asset: string, reveal: boolean): Promise<AssetInfo> {
    const text = await this.call({ asset, reveal });
    const info = parseAssetText(text);
    if (!info) throw new ToolError('SECRET_UNAVAILABLE', `堡垒机没有返回资产「${asset}」的信息:${firstLine(text)}`);
    return info;
  }

  async otp(asset: string): Promise<string> {
    const text = await this.call({ asset, otp: true });
    const r = parseOtpText(text);
    if (!r) throw new ToolError('SECRET_UNAVAILABLE', `资产「${asset}」取不到两步验证码:${firstLine(text)}`);
    // 快过期的码填进去也来不及提交,用下一个
    return r.validSec <= 3 && r.next ? r.next : r.code;
  }

  /** 调堡垒机 MCP 的 get_asset(无状态:一次 tools/call 即可) */
  private async call(args: Record<string, unknown>): Promise<string> {
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
    const result = (json as { result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> }; error?: { message?: string } } | null);
    if (!result || result.error) throw new ToolError('SECRET_UNAVAILABLE', `堡垒机报错:${result?.error?.message ?? '无法解析返回'}`);
    const text = result.result?.content?.find((c) => c.type === 'text')?.text ?? '';
    if (result.result?.isError || /^\s*❌/.test(text)) throw new ToolError('SECRET_UNAVAILABLE', `堡垒机拒绝:${firstLine(text)}`);
    return text;
  }
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
