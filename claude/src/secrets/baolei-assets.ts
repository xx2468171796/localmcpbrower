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
import { packageVersion } from '../activity.js';

export { assetHostRules, assetHosts, hostMatches, parseHostRule, requiresHttps, ruleText, type HostRule } from './asset-hosts.js';

/** 资产要求「每次使用要主人批准」时单次最多等多久;fill_secret / login_with_asset 的调用期限按它的两倍留(见 desk/instrument.ts) */
export const APPROVAL_WAIT_MS = 90_000;
/**
 * fill_secret / login_with_asset 一次调用的总预算:最多两次等批准(资产值 + 两步验证码)再加页面操作的余量。
 * 超过就不再往页面里写;调用期限(desk/instrument.ts deadlineFor)按它再留余量,保证先到的是本工具自己的
 * SECRET_PENDING_APPROVAL,而不是统一期限的 TIMEOUT(那时底层可能还在等、批下来后又去填)。
 */
export const SECRET_TOOL_BUDGET_MS = APPROVAL_WAIT_MS * 2 + 20_000;

export interface AssetInfo {
  id: string;
  name: string;
  address: string;
  account: string;
  /** 自由填写的标签:只作展示,**不参与**站点比对 */
  tags: string[];
  /** 新版堡垒机给的登记站点(data.hosts);旧版文字格式没有,站点只从 address 推 */
  hosts: string[];
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
  const info: AssetInfo = { id: head[1] ?? '', name: (head[2] ?? '').trim(), address: '', account: '', tags: [], hosts: [], fields: {} };
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

/**
 * 旧版堡垒机不认 use_on 时的报错特征:只认「未知 / 多余的键 …… use_on」这一种 schema 报错。
 * 不能放宽:新版的 ASSET_USE_* 答复(要批准 / 被拒 / 站点不符)文字里也可能带 use_on,
 * 被误当成「旧版不认」去掉 use_on 重试,就绕过了堡垒机的站点核对。
 */
const USE_ON_SCHEMA_ERROR = /\b(unrecognized|unknown|unexpected|additional)\b[^\n]{0,40}\b(keys?|propert(?:y|ies)|arg(?:ument)?s?|param(?:eter)?s?)\b[^\n]{0,40}\buse_on\b/i;

export function isUseOnSchemaError(text: string): boolean {
  return !/ASSET_USE_/.test(text) && USE_ON_SCHEMA_ERROR.test(text);
}

/** 可被取消的等待:取消时立即返回(由调用方决定抛什么) */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

function pendingError(r: CallResult, waitedSec: number, why: string): ToolError {
  const id = r.data?.pending?.requestId ?? /request=(\S+)/.exec(r.text)?.[1] ?? '';
  return new ToolError('SECRET_PENDING_APPROVAL', `这个账号每次使用都要主人批准,已推送到主人手机(请求 ${id}),${why}(已等 ${waitedSec} 秒);批准后再调一次即可,别换别的办法`);
}

export class BaoleiAssets {
  constructor(
    private readonly target: TelemetryTarget | null = baoleiEndpoint(process.env, os.homedir()),
    private readonly fetcher: Fetcher = fetch,
    /** 资产要求「每次使用要主人批准」时,最多等多久(期间每 pollMs 重试一次) */
    private readonly approvalWaitMs = APPROVAL_WAIT_MS,
    private readonly pollMs = 5_000,
  ) {}

  get configured(): boolean {
    return this.target !== null;
  }

  /** useOn = 要填进去的页面(来源);新版堡垒机据此在服务端再核对站点、记审计。signal = 本次工具调用的取消信号 */
  async info(asset: string, reveal: boolean, useOn?: string, signal?: AbortSignal): Promise<AssetInfo> {
    const r = await this.call({ asset, reveal }, useOn, signal);
    if (r.data && (r.data.name || r.data.id !== undefined)) return fromData(r.data, asset);
    const info = parseAssetText(r.text);
    if (!info) throw new ToolError('SECRET_UNAVAILABLE', `堡垒机没有返回资产「${asset}」的信息:${firstLine(r.text)}`);
    return info;
  }

  async otp(asset: string, useOn?: string, signal?: AbortSignal): Promise<string> {
    const r = await this.call({ asset, otp: true }, useOn, signal);
    const o = r.data?.otp;
    const parsed = o?.code ? { code: o.code, validSec: o.remaining ?? 30, next: o.next } : parseOtpText(r.text);
    if (!parsed) throw new ToolError('SECRET_UNAVAILABLE', `资产「${asset}」取不到两步验证码:${firstLine(r.text)}`);
    // 快过期的码填进去也来不及提交,用下一个
    return parsed.validSec <= 3 && parsed.next ? parsed.next : parsed.code;
  }

  /**
   * get_asset,带上 use_on;处理三种新版堡垒机的答复:
   *   ASSET_USE_PENDING  资产要主人批准 → 每 pollMs 重试,最多等 approvalWaitMs(主人在手机上一批就接着填);
   *                      期间调用被取消 / 到期 → SECRET_PENDING_APPROVAL
   *   ASSET_USE_DENIED   主人拒绝 → 停
   *   ASSET_USE_ORIGIN   堡垒机核对站点不符 → 拒填
   * 旧版堡垒机不认 use_on(只认窄的 schema 报错特征,见 isUseOnSchemaError)时去掉它重试一次。
   */
  private async call(args: Record<string, unknown>, useOn?: string, signal?: AbortSignal): Promise<CallResult> {
    let effective = useOn ? { ...args, use_on: useOn } : args;
    let r = await this.rpc(effective, signal);
    if (r.isError && useOn && isUseOnSchemaError(r.text)) {
      effective = args;
      r = await this.rpc(effective, signal);
    }
    const started = Date.now();
    const deadline = started + this.approvalWaitMs;
    while (r.isError && /^\s*ASSET_USE_PENDING/.test(r.text)) {
      const waited = Math.round((Date.now() - started) / 1000);
      if (Date.now() + this.pollMs > deadline) throw pendingError(r, waited, `${Math.round(this.approvalWaitMs / 1000)} 秒内还没批`);
      await pause(this.pollMs, signal);
      if (signal?.aborted) throw pendingError(r, waited, '这次调用已到期或被取消时还没批');
      r = await this.rpc(effective, signal);
    }
    if (!r.isError) return r;
    if (/^\s*ASSET_USE_DENIED/.test(r.text)) throw new ToolError('SECRET_UNAVAILABLE', '主人拒绝了这次使用这个账号;别重试,告诉用户');
    if (/^\s*ASSET_USE_ORIGIN/.test(r.text)) throw new ToolError('SECRET_ORIGIN_MISMATCH', `堡垒机核对站点不符,拒绝:${firstLine(r.text)}`);
    throw new ToolError('SECRET_UNAVAILABLE', `堡垒机拒绝:${firstLine(r.text)}`);
  }

  /** 调堡垒机 MCP 的 get_asset(无状态:一次 tools/call 即可) */
  private async rpc(args: Record<string, unknown>, signal?: AbortSignal): Promise<CallResult> {
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
        // 堡垒机的「服务代填」路径会拒绝空的或像 AI 对话客户端的 User-Agent(防明文进模型),这里明确自报是浏览器工位服务
        'user-agent': `localmcpbrower-desk/${packageVersion()}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_asset', arguments: args } }),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(15_000), signal]) : AbortSignal.timeout(15_000),
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
    tags: [],
    hosts: Array.isArray(d.hosts) ? d.hosts.filter((h): h is string => typeof h === 'string') : [],
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
