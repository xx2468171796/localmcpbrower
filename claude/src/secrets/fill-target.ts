/**
 * fill_secret 的「往哪个框里写」:找框、核对整条 frame 链的来源、在页面里原子地核对并写入。
 *
 * 防改道(2026-10 安全审计 C1):
 *   - 绑定到**一个 ElementHandle**,不用懒解析的 Locator —— 框所在文档一换(iframe 被父页面导航走、页面跳转),
 *     句柄就失效、写入失败,而不是悄悄写进新文档里同选择器的框;
 *   - 来源核对覆盖**每一层祖先 frame**(到顶层),每层都得是资产登记的站点;
 *   - 一次性填写:核对来源 / 祖先来源(location.ancestorOrigins)/ 元素类型 / 表单提交去向,和写值在**同一次** evaluate 里完成;
 *   - 逐字键入:每键一个字之前核对焦点仍在目标框、来源没变,不对就中止并清空已键入的部分。
 * evaluate 跑在隔离世界:页面主世界改不了这里用到的原生 setter / 原型(AGENTS.md 第 1 条)。
 */

import type { ElementHandle, Frame, Page } from 'patchright';
import { ToolError } from '../errors.js';

/** 资产字段对元素的要求:secret 只进密码框;otp 只进单行输入框;其它字段只进 <input> */
export type FieldKind = 'secret' | 'otp' | 'text';

export function fieldKind(field: string): FieldKind {
  const f = field.toLowerCase();
  return f === 'secret' ? 'secret' : f === 'otp' ? 'otp' : 'text';
}

export interface Target {
  frame: Frame;
  handle: ElementHandle;
}

/** 填写目标所在文档的来源,以及从父到顶层的各层祖先来源(和 location.ancestorOrigins 同序) */
export interface FrameChain {
  origin: string;
  ancestors: string[];
}

export async function locate(page: Page, t: { ref?: string; selector?: string }): Promise<Target> {
  const selector = t.ref ? `[data-mcp-ref="${t.ref}"]` : (t.selector ?? '');
  for (const frame of page.frames()) {
    const loc = frame.locator(selector).first();
    if (await loc.count().catch(() => 0) === 0) continue;
    const handle = await loc.elementHandle({ timeout: 1000 }).catch(() => null);
    if (handle) return { frame, handle };
  }
  throw new ToolError('ELEMENT_NOT_FOUND', t.ref ? `ref ${t.ref} 未找到(页面可能已重新渲染),请重新 snapshot` : `找不到元素:${selector}`);
}

/** 读来源:隔离世界里读 location.origin(about:blank / srcdoc 继承创建者、data: / 沙箱是 "null") */
export async function frameChain(t: Target): Promise<FrameChain> {
  const origin = await t.handle.evaluate((el) => el.ownerDocument?.defaultView?.location.origin ?? 'null', undefined).catch(() => 'null');
  const ancestors: string[] = [];
  for (let f = t.frame.parentFrame(); f; f = f.parentFrame()) {
    ancestors.push(await f.evaluate(() => location.origin).catch(() => 'null'));
  }
  return { origin, ancestors };
}

export type PageOp = 'check' | 'set' | 'clear' | 'mark';

interface PageOpArgs {
  op: PageOp;
  kind: FieldKind;
  origin: string;
  ancestors: string[];
  value: string;
  /** 逐字键入时:焦点必须在这个框上 */
  focus: boolean;
}

/**
 * 页面内执行(序列化后在隔离世界跑,不能引用外部变量)。返回 'ok' 或失败原因。
 * 核对:元素还挂在文档上 → 来源 / 祖先来源没变 → 元素类型合规 → 可编辑 → 表单不提交到别的来源 → (焦点)→ 写。
 */
function pageOp(el: Element, a: PageOpArgs): string {
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!el.isConnected || !win) return 'detached';
  if (win.location.origin !== a.origin) return 'origin';
  const anc = win.location.ancestorOrigins;
  if (anc && Array.from(anc).join('\n') !== a.ancestors.join('\n')) return 'origin';
  if (el.tagName !== 'INPUT') return 'element';
  const input = el as HTMLInputElement;
  const type = (input.getAttribute('type') || 'text').toLowerCase();
  const ac = (input.getAttribute('autocomplete') || '').toLowerCase();
  const typeOk = a.kind === 'secret'
    ? type === 'password' || /\b(current|new)-password\b/.test(ac)
    : a.kind === 'otp'
      ? ['text', 'tel', 'number', 'password'].includes(type)
      : ['text', 'email', 'tel', 'number', 'password', 'url', 'search'].includes(type);
  if (!typeOk) return 'element';
  if (input.disabled || input.readOnly) return 'readonly';
  if (input.form) {
    try {
      if (new URL(input.form.action, doc.baseURI).origin !== a.origin) return 'form';
    } catch {
      return 'form';
    }
  }
  if (a.focus && (doc.activeElement !== el || !doc.hasFocus())) return 'focus';
  if (a.op === 'check') return 'ok';
  if (a.op === 'mark') { input.setAttribute('data-ego-secret', '1'); return 'ok'; }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return 'internal';
  setter.call(input, a.op === 'set' ? a.value : '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  // 标记「这是资产填的」:snapshot 不显示它的值,录制器当敏感框(DOM 属性跨世界共享)
  if (a.op === 'set') input.setAttribute('data-ego-secret', '1');
  else input.removeAttribute('data-ego-secret');
  return 'ok';
}

const REASONS: Readonly<Record<string, [ToolError['code'], string]>> = {
  detached: ['ELEMENT_NOT_FOUND', '输入框已失效(页面或 iframe 已跳走 / 重新渲染),已停止填写'],
  origin: ['SECRET_ORIGIN_MISMATCH', '输入框所在页面或它的上层页面来源变了,已停止填写'],
  element: ['ELEMENT_NOT_ACTIONABLE', '这个元素不能填这个值:密码只填 type=password(或 autocomplete=current-password / new-password)的输入框,验证码只填单行输入框,其它字段只填 <input>;不填 textarea / contenteditable'],
  readonly: ['ELEMENT_NOT_ACTIONABLE', '输入框只读或被禁用'],
  form: ['SECRET_ORIGIN_MISMATCH', '输入框所在表单会提交到别的站点,拒绝填写'],
  focus: ['ELEMENT_NOT_ACTIONABLE', '键入途中焦点离开了目标输入框(可能被页面抢走),已中止并清空'],
  internal: ['INTERNAL', '页面环境异常,无法写入'],
};

/** 执行一次页面内核对 / 写入;不是 'ok' 就抛对应的 ToolError(固定文案,不含值) */
export async function runPageOp(t: Target, chain: FrameChain, kind: FieldKind, op: PageOp, value = '', focus = false): Promise<void> {
  const r = await t.handle.evaluate(pageOp, { op, kind, origin: chain.origin, ancestors: chain.ancestors, value, focus })
    .catch(() => 'detached');
  if (r === 'ok') return;
  const [code, msg] = REASONS[r] ?? REASONS['internal'] ?? ['INTERNAL', '写入失败'];
  throw new ToolError(code, msg);
}

/** 逐字键入:每个字之前核对焦点和来源;中途不对 → 清空已键入的部分再抛错 */
export async function typeChecked(t: Target, chain: FrameChain, kind: FieldKind, value: string, beforeKey: () => void): Promise<void> {
  const page = t.frame.page();
  await runPageOp(t, chain, kind, 'clear');
  await t.handle.focus();
  try {
    for (const ch of value) {
      beforeKey();
      await runPageOp(t, chain, kind, 'check', '', true);
      await page.keyboard.type(ch);
      await new Promise((r) => setTimeout(r, 35));
    }
    await runPageOp(t, chain, kind, 'check', '', true);
    await runPageOp(t, chain, kind, 'mark');
  } catch (e) {
    await runPageOp(t, chain, kind, 'clear').catch(() => { /* 文档已经没了,无从清 */ });
    throw e;
  }
}
