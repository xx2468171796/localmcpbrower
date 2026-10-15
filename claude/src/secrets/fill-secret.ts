/**
 * 用堡垒机资产填表:AI 只说「用哪条资产、填哪个框」,明文由这里取、这里填,永远不回给 AI。
 *
 * 防外泄不变量:输入框所在页面(含 iframe)的站点必须和资产登记的地址对得上,对不上拒填
 * (SECRET_ORIGIN_MISMATCH)—— 防止 AI 被页面内容诱导,把公司后台密码填进别的网站。
 */

import type { Frame, Locator, Page } from 'patchright';
import { z } from 'zod';
import { getBrowserManager } from '../browser.js';
import { ToolError, classifyError, fail, failFrom } from '../errors.js';
import type { ToolResult } from '../types.js';
import { BaoleiAssets, assetHosts, hostMatches, requiresHttps, type AssetInfo } from './baolei-assets.js';

const Target = z.object({
  ref: z.string().max(32).optional(),
  selector: z.string().max(2000).optional(),
}).refine((t) => Boolean(t.ref) !== Boolean(t.selector), 'ref 与 selector 二选一');

export const FillSecretSchema = z.object({
  asset: z.string().min(1).max(200).describe('资产 id 或名称(堡垒机 list_assets 查)'),
  field: z.string().min(1).max(100).default('secret').describe("填哪个值:secret(密码,默认)/ account / otp(两步验证码)/ 资产里的自定义字段名"),
  ref: z.string().max(32).optional(),
  selector: z.string().max(2000).optional(),
  typing: z.boolean().default(false).describe('逐字键入(有些站点只认键盘事件);默认一次性填入'),
}).refine((t) => Boolean(t.ref) !== Boolean(t.selector), 'ref 与 selector 二选一');

export const LoginWithAssetSchema = z.object({
  asset: z.string().min(1).max(200),
  user: Target.optional().describe('账号输入框;不给就不填账号'),
  pass: Target.optional().describe('密码输入框'),
  otp: Target.optional().describe('两步验证码输入框'),
  submit: z.union([Target, z.literal('enter')]).optional().describe("提交按钮;'enter' = 在最后一个填的框里按回车;不给就只填不提交"),
  typing: z.boolean().default(false),
});

let assets: BaoleiAssets | null = null;
/** 懒建:进程启动时没配堡垒机、之后才配上,也能用上(测试可注入) */
export function setAssetSource(src: BaoleiAssets | null): void { assets = src; }
function source(): BaoleiAssets { return (assets ??= new BaoleiAssets()); }

interface Found { frame: Frame; locator: Locator }

async function locate(page: Page, t: { ref?: string; selector?: string }): Promise<Found> {
  const selector = t.ref ? `[data-mcp-ref="${t.ref}"]` : (t.selector ?? '');
  for (const frame of page.frames()) {
    const loc = frame.locator(selector).first();
    if (await loc.count().catch(() => 0) > 0) return { frame, locator: loc };
  }
  throw new ToolError('ELEMENT_NOT_FOUND', t.ref ? `ref ${t.ref} 未找到(页面可能已重新渲染),请重新 snapshot` : `找不到元素:${selector}`);
}

/**
 * 输入框所在文档的真实来源必须属于资产登记的站点。
 * 读文档自己的 location.origin,不用 frame.url() / page.url():about:blank / srcdoc 继承创建者的来源
 * (可能是第三方 iframe),data: / blob: / 沙箱 iframe 是不透明来源("null")—— 后者一律拒填。
 * 资产登记的网址全是 https 时,页面也必须是 https。紧挨着填写前调用,缩小「查完被换页」的窗口。
 */
/** 输入框所在文档的真实来源;不透明 / 非 http(s) 返回 null(这种一律不去堡垒机取值,免得白白记一次「使用」) */
async function frameOrigin(found: Found): Promise<URL | null> {
  const origin = await found.locator.evaluate((el) => el.ownerDocument.defaultView?.location.origin ?? 'null', undefined, { timeout: 5000 }).catch(() => 'null');
  try {
    const u = origin === 'null' ? null : new URL(origin);
    return u && /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

async function requireOrigin(found: Found): Promise<URL> {
  const u = await frameOrigin(found);
  if (!u) throw new ToolError('SECRET_ORIGIN_MISMATCH', '输入框所在页面的来源不确定(data: / 沙箱 iframe / srcdoc 等),拒绝填写');
  return u;
}

async function assertOrigin(found: Found, info: AssetInfo): Promise<void> {
  const hosts = assetHosts(info);
  if (hosts.length === 0) {
    throw new ToolError('SECRET_ORIGIN_MISMATCH', `资产「${info.name}」没登记网址(address),不知道该填到哪个站点;请先在堡垒机里给它补上地址`);
  }
  const u = await frameOrigin(found);
  const origin = u?.origin ?? 'null';
  if (!u || !hostMatches(u.hostname, hosts)) {
    throw new ToolError('SECRET_ORIGIN_MISMATCH', `输入框所在页面「${origin}」不是资产「${info.name}」登记的站点(${hosts.join('、')}),拒绝填写`);
  }
  if (requiresHttps(info) && u.protocol !== 'https:') {
    throw new ToolError('SECRET_ORIGIN_MISMATCH', `资产「${info.name}」登记的是 https 站点,当前页面是 ${u.protocol.replace(':', '')},拒绝填写`);
  }
}

/** 取到值以后的操作出错:Playwright 的报错末尾带调用日志,里面有 fill("<值>") —— 原文绝不外传,只给码和固定说明 */
async function guarded<T>(what: string, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
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

async function valueOf(info: AssetInfo, field: string, assetRef: string, useOn: string): Promise<string> {
  const f = field.toLowerCase();
  if (f === 'otp') return source().otp(assetRef, useOn);
  if (f === 'account') {
    if (!info.account) throw new ToolError('SECRET_UNAVAILABLE', `资产「${info.name}」没有账号`);
    return info.account;
  }
  const v = f === 'secret' ? info.secret : info.fields[field];
  if (!v) throw new ToolError('SECRET_UNAVAILABLE', `资产「${info.name}」里没有「${field}」的值`);
  return v;
}

/** 先过站点检查、紧接着填;所有出错都经 guarded,原始报错(含值)不外传 */
async function put(found: Found, info: AssetInfo, value: string, typing: boolean): Promise<void> {
  await assertOrigin(found, info);
  await found.locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  await guarded('填写', async () => {
    if (typing) {
      await found.locator.fill('', { timeout: 10_000 });
      await found.locator.pressSequentially(value, { delay: 35, timeout: 30_000 });
    } else {
      await found.locator.fill(value, { timeout: 10_000 });
    }
  });
}

export async function fillSecret(input: unknown): Promise<ToolResult<{ asset: string; field: string; filled: number }>> {
  const parsed = FillSecretSchema.safeParse(input);
  if (!parsed.success) return fail('INVALID_ARGS', `参数验证失败: ${parsed.error.message}`);
  const { asset, field, typing } = parsed.data;
  const used: string[] = [];
  try {
    const page = await getBrowserManager().getPage();
    const found = await locate(page, parsed.data);
    // 来源不确定的框直接拒,不去堡垒机取值;确定的带上 use_on,新版堡垒机在服务端再核对站点、记审计
    const useOn = (await requireOrigin(found)).href;
    const needsReveal = !['otp', 'account'].includes(field.toLowerCase());
    const info = await source().info(asset, needsReveal, useOn);
    const value = await valueOf(info, field, asset, useOn);
    used.push(value);
    await put(found, info, value, typing);
    return { success: true, data: { asset: info.name, field, filled: value.length } };
  } catch (e) {
    return scrubbed(failFrom(e), used);
  }
}

export async function loginWithAsset(input: unknown): Promise<ToolResult<{ asset: string; filled: string[]; submitted: boolean }>> {
  const parsed = LoginWithAssetSchema.safeParse(input);
  if (!parsed.success) return fail('INVALID_ARGS', `参数验证失败: ${parsed.error.message}`);
  const { asset, user, pass, otp, submit, typing } = parsed.data;
  if (!user && !pass && !otp) return fail('INVALID_ARGS', 'user / pass / otp 至少给一个输入框');
  const used: string[] = [];
  try {
    const page = await getBrowserManager().getPage();
    // 先把要填的框都找到,用第一个框的来源作 use_on(每个框填之前仍各自核对站点)
    const plan: Array<[string, Found]> = [];
    for (const [field, target] of [['account', user], ['secret', pass], ['otp', otp]] as const) {
      if (target) plan.push([field, await locate(page, target)]);
    }
    const first = plan[0];
    if (!first) return fail('INVALID_ARGS', 'user / pass / otp 至少给一个输入框');
    const useOn = (await requireOrigin(first[1])).href;
    const info = await source().info(asset, Boolean(pass), useOn);
    const filled: string[] = [];
    let last: Found | null = null;
    for (const [field, found] of plan) {
      const value = await valueOf(info, field, asset, useOn);
      used.push(value);
      await put(found, info, value, typing);
      filled.push(field);
      last = found;
    }
    let submitted = false;
    if (submit === 'enter' && last) {
      const target = last;
      await guarded('回车提交', () => target.locator.press('Enter', { timeout: 5000 }));
      submitted = true;
    } else if (submit && submit !== 'enter') {
      const btn = await locate(page, submit);
      await guarded('点击提交', () => btn.locator.click({ timeout: 10_000 }));
      submitted = true;
    }
    if (submitted) await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    return { success: true, data: { asset: info.name, filled, submitted } };
  } catch (e) {
    return scrubbed(failFrom(e), used);
  }
}
