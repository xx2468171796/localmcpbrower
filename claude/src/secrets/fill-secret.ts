/**
 * 用堡垒机资产填表:AI 只说「用哪条资产、填哪个框」,明文由这里取、这里填,永远不回给 AI。
 *
 * 防外泄不变量:输入框所在页面(含 iframe)的站点必须和资产登记的地址对得上,对不上拒填
 * (SECRET_ORIGIN_MISMATCH)—— 防止 AI 被页面内容诱导,把公司后台密码填进别的网站。
 */

import type { Frame, Locator, Page } from 'patchright';
import { z } from 'zod';
import { getBrowserManager } from '../browser.js';
import { ToolError, fail, failFrom } from '../errors.js';
import type { ToolResult } from '../types.js';
import { BaoleiAssets, assetHosts, hostMatches, type AssetInfo } from './baolei-assets.js';

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

/** 输入框所在框架的站点必须属于资产登记的站点 */
function assertOrigin(found: Found, page: Page, info: AssetInfo): void {
  const hosts = assetHosts(info);
  if (hosts.length === 0) {
    throw new ToolError('SECRET_ORIGIN_MISMATCH', `资产「${info.name}」没登记网址(address),不知道该填到哪个站点;请先在堡垒机里给它补上地址`);
  }
  const raw = found.frame.url();
  const url = /^https?:/.test(raw) ? raw : page.url();
  let host = '';
  try { host = new URL(url).hostname; } catch { /* 下面按不匹配处理 */ }
  if (!host || !hostMatches(host, hosts)) {
    throw new ToolError('SECRET_ORIGIN_MISMATCH', `当前页面站点「${host || url}」不是资产「${info.name}」登记的站点(${hosts.join('、')}),拒绝填写`);
  }
}

async function valueOf(info: AssetInfo, field: string, assetRef: string): Promise<string> {
  const f = field.toLowerCase();
  if (f === 'otp') return source().otp(assetRef);
  if (f === 'account') {
    if (!info.account) throw new ToolError('SECRET_UNAVAILABLE', `资产「${info.name}」没有账号`);
    return info.account;
  }
  const v = f === 'secret' ? info.secret : info.fields[field];
  if (!v) throw new ToolError('SECRET_UNAVAILABLE', `资产「${info.name}」里没有「${field}」的值`);
  return v;
}

async function put(found: Found, value: string, typing: boolean): Promise<void> {
  await found.locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
  if (typing) {
    await found.locator.fill('', { timeout: 10_000 });
    await found.locator.pressSequentially(value, { delay: 35, timeout: 30_000 });
  } else {
    await found.locator.fill(value, { timeout: 10_000 });
  }
}

export async function fillSecret(input: unknown): Promise<ToolResult<{ asset: string; field: string; filled: number }>> {
  const parsed = FillSecretSchema.safeParse(input);
  if (!parsed.success) return fail('INVALID_ARGS', `参数验证失败: ${parsed.error.message}`);
  const { asset, field, typing } = parsed.data;
  try {
    const page = await getBrowserManager().getPage();
    const found = await locate(page, parsed.data);
    const needsReveal = !['otp', 'account'].includes(field.toLowerCase());
    const info = await source().info(asset, needsReveal);
    assertOrigin(found, page, info);
    const value = await valueOf(info, field, asset);
    await put(found, value, typing);
    return { success: true, data: { asset: info.name, field, filled: value.length } };
  } catch (e) {
    return failFrom(e);
  }
}

export async function loginWithAsset(input: unknown): Promise<ToolResult<{ asset: string; filled: string[]; submitted: boolean }>> {
  const parsed = LoginWithAssetSchema.safeParse(input);
  if (!parsed.success) return fail('INVALID_ARGS', `参数验证失败: ${parsed.error.message}`);
  const { asset, user, pass, otp, submit, typing } = parsed.data;
  if (!user && !pass && !otp) return fail('INVALID_ARGS', 'user / pass / otp 至少给一个输入框');
  try {
    const page = await getBrowserManager().getPage();
    const info = await source().info(asset, Boolean(pass));
    const filled: string[] = [];
    let last: Found | null = null;
    for (const [field, target] of [['account', user], ['secret', pass], ['otp', otp]] as const) {
      if (!target) continue;
      const found = await locate(page, target);
      assertOrigin(found, page, info);
      await put(found, await valueOf(info, field, asset), typing);
      filled.push(field);
      last = found;
    }
    let submitted = false;
    if (submit === 'enter' && last) { await last.locator.press('Enter', { timeout: 5000 }); submitted = true; }
    else if (submit && submit !== 'enter') { await (await locate(page, submit)).locator.click({ timeout: 10_000 }); submitted = true; }
    if (submitted) await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
    return { success: true, data: { asset: info.name, filled, submitted } };
  } catch (e) {
    return failFrom(e);
  }
}
