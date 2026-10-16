/**
 * 用堡垒机资产填表:AI 只说「用哪条资产、填哪个框」,明文由这里取、这里填,永远不回给 AI。
 *
 * 防外泄不变量:
 *   - 输入框所在页面**以及它上面每一层 frame**(到顶层)的站点都必须和资产登记的站点对得上(精确主机名;
 *     登记成 *.example.com 才认子域名;登记了端口就比端口),对不上拒填(SECRET_ORIGIN_MISMATCH);
 *   - https 站点的证书要能通过严格校验(tls-check.ts),否则拒填 —— 防中间人假冒站点;
 *   - 密码只填密码框、验证码只填单行输入框、其它字段只填 <input>;表单提交到别的来源的不填;
 *   - 写入绑定到一个元素句柄,核对和写入在同一次页面内调用里完成;逐字键入时每个字前都核对焦点(fill-target.ts)。
 */

import type { Page } from 'patchright';
import { z } from 'zod';
import { getBrowserManager } from '../browser.js';
import { currentSignal } from '../context.js';
import { ToolError, classifyError, fail, failFrom } from '../errors.js';
import type { ToolResult } from '../types.js';
import { BaoleiAssets, SECRET_TOOL_BUDGET_MS, assetHostRules, hostMatches, requiresHttps, ruleText, type AssetInfo } from './baolei-assets.js';
import { fieldKind, frameChain, locate, runPageOp, typeChecked, type FrameChain, type Target } from './fill-target.js';
import { originCertTrusted } from './tls-check.js';

const TargetSchema = z.object({
  ref: z.string().max(32).optional(),
  selector: z.string().max(2000).optional(),
}).refine((t) => Boolean(t.ref) !== Boolean(t.selector), 'ref 与 selector 二选一');

export const FillSecretSchema = z.object({
  asset: z.string().min(1).max(200).describe('资产 id 或名称(堡垒机 list_assets 查)'),
  field: z.string().min(1).max(100).default('secret').describe("填哪个值:secret(密码,默认,只能填密码框)/ account / otp(两步验证码)/ 资产里的自定义字段名"),
  ref: z.string().max(32).optional(),
  selector: z.string().max(2000).optional(),
  typing: z.boolean().default(false).describe('逐字键入(有些站点只认键盘事件);默认一次性填入'),
}).refine((t) => Boolean(t.ref) !== Boolean(t.selector), 'ref 与 selector 二选一');

export const LoginWithAssetSchema = z.object({
  asset: z.string().min(1).max(200),
  user: TargetSchema.optional().describe('账号输入框;不给就不填账号'),
  pass: TargetSchema.optional().describe('密码输入框'),
  otp: TargetSchema.optional().describe('两步验证码输入框'),
  submit: z.union([TargetSchema, z.literal('enter')]).optional().describe("提交按钮;'enter' = 在最后一个填的框里按回车;不给就只填不提交"),
  typing: z.boolean().default(false),
});

let assets: BaoleiAssets | null = null;
/** 懒建:进程启动时没配堡垒机、之后才配上,也能用上(测试可注入) */
export function setAssetSource(src: BaoleiAssets | null): void { assets = src; }
function source(): BaoleiAssets { return (assets ??= new BaoleiAssets()); }

/** 本次调用的截止信号:客户端取消,或超过本工具的总预算(等主人批准最多两次)—— 到了就不再往页面里写 */
function callSignal(): AbortSignal {
  const own = AbortSignal.timeout(SECRET_TOOL_BUDGET_MS);
  const outer = currentSignal();
  return outer ? AbortSignal.any([outer, own]) : own;
}

function stopIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolError('CANCELLED', '调用已取消或已到期,没有往页面里填写');
}

/** 只认 http(s) 的确定来源;不透明("null")/ 其它协议返回 null */
function httpOrigin(origin: string): URL | null {
  try {
    const u = origin === 'null' ? null : new URL(origin);
    return u && /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

/** 来源不确定的框直接拒,不去堡垒机取值(免得白白记一次「使用」) */
function requireOrigin(chain: FrameChain): URL {
  const u = httpOrigin(chain.origin);
  if (!u || chain.ancestors.some((a) => !httpOrigin(a))) {
    throw new ToolError('SECRET_ORIGIN_MISMATCH', '输入框所在页面(或它的上层页面)来源不确定(data: / 沙箱 iframe / srcdoc 等),拒绝填写');
  }
  return u;
}

/**
 * 目标文档和每一层祖先都要:属于资产登记的站点 + 需要时是 https + https 证书校验通过。
 * 挂了代理的工作区:代理能看到、改掉一切明文流量,只许填 https 页面;证书由浏览器自己严格校验(有代理时不忽略证书错误),
 * 不再从本进程直连去验 —— 直连会让登录站点在代理出口之外再看到一次本机真实 IP。
 */
async function assertChain(chain: FrameChain, info: AssetInfo): Promise<void> {
  const proxied = getBrowserManager().currentSpaceProxied();
  const rules = assetHostRules(info);
  if (rules.length === 0) {
    throw new ToolError('SECRET_ORIGIN_MISMATCH', `资产「${info.name}」没登记网址(address),不知道该填到哪个站点;请先在堡垒机里给它补上地址`);
  }
  for (const [i, origin] of [chain.origin, ...chain.ancestors].entries()) {
    const u = httpOrigin(origin);
    const where = i === 0 ? '输入框所在页面' : `第 ${i} 层上层页面`;
    if (!u || !hostMatches(u, rules)) {
      throw new ToolError('SECRET_ORIGIN_MISMATCH', `${where}「${origin}」不是资产「${info.name}」登记的站点(${rules.map(ruleText).join('、')}),拒绝填写`);
    }
    if (requiresHttps(info) && u.protocol !== 'https:') {
      throw new ToolError('SECRET_ORIGIN_MISMATCH', `资产「${info.name}」登记的是 https 站点,${where}是 ${u.protocol.replace(':', '')},拒绝填写`);
    }
    if (proxied) {
      if (u.protocol !== 'https:') {
        throw new ToolError('SECRET_ORIGIN_MISMATCH', `这个工作区挂了代理,${where}是明文 http,代理能看到填进去的内容,拒绝填写;换不挂代理的工作区`);
      }
      continue;
    }
    if (!(await originCertTrusted(u))) {
      throw new ToolError('SECRET_ORIGIN_MISMATCH', `${where}「${u.origin}」的 HTTPS 证书校验不通过(自签 / 过期 / 主机名不符,或网络被劫持),拒绝填写`);
    }
  }
}

/** 取到值以后的操作出错:Playwright 的报错末尾带调用日志,里面可能有值 —— 原文绝不外传,只给码和固定说明 */
async function guarded<T>(what: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    // 本模块自己抛的 ToolError 文案固定、不含值,原样给出(码更准)
    if (e instanceof ToolError) throw e;
    const code = classifyError(e instanceof Error ? e.message : String(e), e);
    throw new ToolError(code === 'INTERNAL' ? 'ELEMENT_NOT_ACTIONABLE' : code, `${what}失败(${code}):输入框可能只读、不可见、被遮挡或页面已跳走。为防泄露不附原始报错`);
  }
}

/** 兜底:任何错误信息里出现了取到的值,一律抹掉 */
function scrubbed(r: ReturnType<typeof failFrom>, values: string[]): ReturnType<typeof failFrom> {
  let error = r.error;
  for (const v of values) if (v.length >= 3) error = error.split(v).join('«已隐藏»');
  return { ...r, error };
}

async function valueOf(info: AssetInfo, field: string, assetRef: string, useOn: string, signal: AbortSignal): Promise<string> {
  const f = field.toLowerCase();
  if (f === 'otp') return source().otp(assetRef, useOn, signal);
  if (f === 'account') {
    if (!info.account) throw new ToolError('SECRET_UNAVAILABLE', `资产「${info.name}」没有账号`);
    return info.account;
  }
  const v = f === 'secret' ? info.secret : info.fields[field];
  if (!v) throw new ToolError('SECRET_UNAVAILABLE', `资产「${info.name}」里没有「${field}」的值`);
  return v;
}

interface Planned { field: string; target: Target; chain: FrameChain }

/** 先过站点检查,紧接着在页面里核对并写入;所有出错都经 guarded,原始报错(含值)不外传 */
async function put(p: Planned, info: AssetInfo, value: string, typing: boolean, signal: AbortSignal): Promise<void> {
  await assertChain(p.chain, info);
  await p.target.handle.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  const kind = fieldKind(p.field);
  await guarded('填写', async () => {
    if (typing) {
      await typeChecked(p.target, p.chain, kind, value, () => stopIfAborted(signal));
    } else {
      stopIfAborted(signal);
      await runPageOp(p.target, p.chain, kind, 'set', value);
    }
  });
}

async function plan(page: Page, field: string, t: { ref?: string; selector?: string }): Promise<Planned> {
  const target = await locate(page, t);
  return { field, target, chain: await frameChain(target) };
}

export async function fillSecret(input: unknown): Promise<ToolResult<{ asset: string; field: string; filled: number }>> {
  const parsed = FillSecretSchema.safeParse(input);
  if (!parsed.success) return fail('INVALID_ARGS', `参数验证失败: ${parsed.error.message}`);
  const { asset, field, typing } = parsed.data;
  const used: string[] = [];
  const signal = callSignal();
  try {
    const page = await getBrowserManager().getPage();
    const p = await plan(page, field, parsed.data);
    // 来源确定的才去堡垒机取,并带上 use_on:新版堡垒机在服务端再核对站点、记审计
    const useOn = requireOrigin(p.chain).href;
    const needsReveal = !['otp', 'account'].includes(field.toLowerCase());
    const info = await source().info(asset, needsReveal, useOn, signal);
    await assertChain(p.chain, info);
    const value = await valueOf(info, field, asset, useOn, signal);
    used.push(value);
    await put(p, info, value, typing, signal);
    return { success: true, data: { asset: info.name, field, filled: value.length } };
  } catch (e) {
    return scrubbed(failFrom(e), used);
  }
}

async function submitForm(page: Page, submit: z.infer<typeof LoginWithAssetSchema>['submit'], last: Planned | null): Promise<boolean> {
  if (submit === 'enter' && last) {
    await guarded('回车提交', () => last.target.handle.press('Enter', { timeout: 5000 }));
    return true;
  }
  if (submit && submit !== 'enter') {
    const btn = await locate(page, submit);
    await guarded('点击提交', () => btn.handle.click({ timeout: 10_000 }));
    return true;
  }
  return false;
}

export async function loginWithAsset(input: unknown): Promise<ToolResult<{ asset: string; filled: string[]; submitted: boolean }>> {
  const parsed = LoginWithAssetSchema.safeParse(input);
  if (!parsed.success) return fail('INVALID_ARGS', `参数验证失败: ${parsed.error.message}`);
  const { asset, user, pass, otp, submit, typing } = parsed.data;
  const used: string[] = [];
  const signal = callSignal();
  try {
    const page = await getBrowserManager().getPage();
    // 先把要填的框都找到并读好各自的 frame 链,用第一个框的来源作 use_on(每个框填之前仍各自核对整条链)
    const plans: Planned[] = [];
    for (const [field, target] of [['account', user], ['secret', pass], ['otp', otp]] as const) {
      if (target) plans.push(await plan(page, field, target));
    }
    const first = plans[0];
    if (!first) return fail('INVALID_ARGS', 'user / pass / otp 至少给一个输入框');
    for (const p of plans) requireOrigin(p.chain);
    const useOn = requireOrigin(first.chain).href;
    const info = await source().info(asset, Boolean(pass), useOn, signal);
    for (const p of plans) await assertChain(p.chain, info);
    const filled: string[] = [];
    let last: Planned | null = null;
    for (const p of plans) {
      const value = await valueOf(info, p.field, asset, useOn, signal);
      used.push(value);
      await put(p, info, value, typing, signal);
      filled.push(p.field);
      last = p;
    }
    const submitted = await submitForm(page, submit, last);
    if (submitted) await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    return { success: true, data: { asset: info.name, filled, submitted } };
  } catch (e) {
    return scrubbed(failFrom(e), used);
  }
}
