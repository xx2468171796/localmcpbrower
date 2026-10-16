/**
 * 页面内交互工具:click / type / hover / select_option / fill_form / keyboard_press / drag_and_drop / file_upload / scroll。
 * 共同约定:selector 或 ref 都能穿透 iframe;每步有超时、honour 取消;失败带错误码(errors.ts)。
 */

import type { Frame, Page } from 'patchright';
import { getBrowserManager } from '../browser.js';
import { failFrom, failFromQuiet, ToolError } from '../errors.js';
import { PDF_DIR, SCREENSHOT_DIR } from '../paths.js';
import { resolveReadPath, uploadAllowRoots } from '../safe-path.js';
import { throwIfCancelled } from '../context.js';
import {
  ClickSchema, TypeSchema, HoverSchema, SelectOptionSchema, FillFormSchema, KeyboardPressSchema,
  DragAndDropSchema, FileUploadSchema, ScrollSchema,
} from '../schemas.js';
import type { ToolResult, ClickResult, TypeResult } from '../types.js';
import {
  type ActionEffects, DOWNLOAD_DIR, UPLOAD_DIR, isPasswordField, parseInput, resolveTarget, sig, targetFrame,
  withActionEffects,
} from './common.js';
import { withTimeout } from './timing.js';
import {
  HumanMiss, elementBox, humanClick, humanDrag, humanHover, humanizeActive, humanScroll, humanType, isCancelled,
} from '../humanize/index.js';

/**
 * 拟人开着就先走拟人路径,动手之前发现走不通(没有框、被挡、类型不合适……)退回原有实现;
 * 取消照常抛出。拟人关着时直接走原有实现,行为与以前完全一样。
 */
async function humanFirst(human: () => Promise<void>, fallback: () => Promise<void>): Promise<void> {
  if (!humanizeActive()) return fallback();
  try {
    await human();
    return;
  } catch (e) {
    // 只有 HumanMiss(动手之前就发现走不通)才退回;已经按下 / 敲过键之后出的错原样抛出,
    // 否则退回路径会再点一次 / 再填一遍(重复提交、联想搜索被触发两次)
    if (isCancelled(e) || !(e instanceof HumanMiss)) throw e;
  }
  throwIfCancelled();
  await fallback();
}

/** 三级点击:正常(等可见)→ force → DOM el.click();都不行抛出最后的错 */
async function clickInFrame(frame: Frame, selector: string): Promise<void> {
  try {
    await frame.waitForSelector(selector, { timeout: 3000, state: 'visible', ...sig() });
    await frame.click(selector, { timeout: 5000, noWaitAfter: true, ...sig() });
    return;
  } catch (e) {
    if (e instanceof ToolError && e.code === 'CANCELLED') throw e;
  }
  throwIfCancelled();
  try {
    await frame.click(selector, { force: true, timeout: 5000, noWaitAfter: true, ...sig() });
    return;
  } catch { /* 落到 DOM 点击 */ }
  throwIfCancelled();
  const found = await withTimeout(frame.evaluate((sel: string) => {
    let el: Element | null = null;
    try { el = document.querySelector(sel); } catch { return false; }
    if (!(el instanceof HTMLElement)) return false;
    el.click();
    return true;
  }, selector), 5000, 'DOM 点击');
  if (!found) throw new ToolError('ELEMENT_NOT_FOUND', `元素未找到: ${selector}`);
}

export async function click(input: unknown): Promise<ToolResult<ClickResult & ActionEffects>> {
  try {
    const args = parseInput(ClickSchema, input);
    const { selector, fromRef } = resolveTarget(args.selector, args.ref);
    const page = await getBrowserManager().getPage();
    const frame = await targetFrame(page, selector, fromRef, args.ref);
    const effects = await withActionEffects(page, () => humanFirst(
      () => humanClick(page, frame, selector),
      () => clickInFrame(frame, selector),
    ));
    return { success: true, data: { selector, clicked: true, ...effects } };
  } catch (error) {
    return failFrom(error);
  }
}

/** 填值:正常 fill → force fill → DOM 赋值并派发事件(值作参数传入,不拼进脚本文本) */
async function fillInFrame(frame: Frame, selector: string, text: string): Promise<void> {
  try {
    await frame.waitForSelector(selector, { timeout: 3000, state: 'visible', ...sig() });
    await frame.fill(selector, text, { timeout: 5000, ...sig() });
    return;
  } catch (e) {
    if (e instanceof ToolError && e.code === 'CANCELLED') throw e;
  }
  throwIfCancelled();
  try {
    await frame.fill(selector, text, { force: true, timeout: 5000, ...sig() });
    return;
  } catch { /* 落到 DOM 赋值 */ }
  throwIfCancelled();
  const found = await withTimeout(frame.evaluate(([sel, value]: [string, string]) => {
    let el: Element | null = null;
    try { el = document.querySelector(sel); } catch { return false; }
    if (!el) return false;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) el.value = value;
    else if (el instanceof HTMLElement && el.isContentEditable) el.textContent = value;
    else return false;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, [selector, text] as [string, string]), 5000, 'DOM 赋值');
  if (!found) throw new ToolError('ELEMENT_NOT_FOUND', `元素未找到或不可输入: ${selector}`);
}

/**
 * 输入文字:拟人开着时逐字敲(密码框不出错字),走不通退回 fill 三级;关着就是原来的 fill 三级。
 * humanChars = 逐字敲的前多少个字(fill_form 一次填很多字段,给得小些,免得整体太慢撞上期限)。
 */
async function typeInFrame(page: Page, frame: Frame, selector: string, text: string, humanChars?: number): Promise<void> {
  await humanFirst(async () => {
    const password = await isPasswordField(frame, selector);
    await humanType(page, frame, selector, text, { password, humanChars });
  }, () => fillInFrame(frame, selector, text));
}

export async function type(input: unknown): Promise<ToolResult<TypeResult & { length: number; password: boolean }>> {
  try {
    const args = parseInput(TypeSchema, input);
    const { selector, fromRef } = resolveTarget(args.selector, args.ref);
    const page = await getBrowserManager().getPage();
    const frame = await targetFrame(page, selector, fromRef, args.ref);
    await typeInFrame(page, frame, selector, args.text);
    // 不回显输入内容(密码框尤其不能):只给长度
    const password = await isPasswordField(frame, selector);
    return { success: true, data: { selector, typed: true, length: args.text.length, password } };
  } catch (error) {
    return failFromQuiet(error);
  }
}

export async function hover(input: unknown): Promise<ToolResult<{ hovered: boolean }>> {
  try {
    const args = parseInput(HoverSchema, input);
    const { selector, fromRef } = resolveTarget(args.selector, args.ref);
    const page = await getBrowserManager().getPage();
    const frame = await targetFrame(page, selector, fromRef, args.ref);
    await humanFirst(() => humanHover(page, frame, selector), async () => {
      try {
        await frame.hover(selector, { timeout: 5000, ...sig() });
      } catch (e) {
        if (e instanceof Error && /intercepts pointer events|not visible|outside of the viewport/i.test(e.message)) {
          // 被遮罩挡住 / 不在视口:force 悬停(直接把鼠标移到元素中心)
          await frame.hover(selector, { timeout: 5000, force: true, ...sig() });
        } else throw e;
      }
    });
    return { success: true, data: { hovered: true } };
  } catch (error) {
    return failFrom(error);
  }
}

/**
 * 选下拉项。原生 <select> 用 selectOption;不是原生的(Element / Ant Design 等自绘下拉)
 * 以前直接报「Element is not a <select> element」—— 改成先点开,再点文字匹配的选项。
 */
async function selectIn(frame: Frame, selector: string, value?: string, label?: string): Promise<string[]> {
  const isNative = await withTimeout(frame.locator(selector).first()
    .evaluate((el) => el instanceof HTMLSelectElement, undefined, { timeout: 5000 }), 6000, '定位下拉框');
  if (isNative) {
    const opt = value !== undefined ? { value } : { label: label ?? '' };
    return frame.selectOption(selector, opt, { timeout: 5000, ...sig() });
  }
  const text = label ?? value ?? '';
  await frame.click(selector, { timeout: 5000, ...sig() });
  const page = frame.page();
  // 自绘下拉的选项常被挂到 body 末尾(不在原容器里),所以在整页里找
  const option = page.getByRole('option', { name: text, exact: true })
    .or(page.locator(`[role=option]:has-text(${JSON.stringify(text)})`))
    .or(page.locator(`li:visible:text-is(${JSON.stringify(text)})`))
    .first();
  await option.click({ timeout: 5000, ...sig() }).catch(() => {
    throw new ToolError('ELEMENT_NOT_FOUND', `不是原生 <select>,点开后没找到文字为「${text}」的选项`);
  });
  return [text];
}

export async function selectOption(input: unknown): Promise<ToolResult<{ selected: boolean; values: string[] }>> {
  try {
    const { selector, value, label } = parseInput(SelectOptionSchema, input);
    // 用 !== undefined 判断:value="" 是合法的空选项(常见的「请选择」),不能当成没给
    if (value === undefined && label === undefined) throw new ToolError('INVALID_ARGS', 'value 或 label 至少要给一个');
    const page = await getBrowserManager().getPage();
    const frame = await targetFrame(page, selector, false);
    const values = await selectIn(frame, selector, value, label);
    return { success: true, data: { selected: true, values } };
  } catch (error) {
    return failFrom(error);
  }
}

/** fill_form 里每个文本字段逐字敲的字数上限(其余整段插入) */
const FORM_HUMAN_CHARS = 60;

type FormField = { selector: string; value: string; type: 'text' | 'select' | 'checkbox' | 'radio' };

async function fillField(page: Page, field: FormField): Promise<void> {
  const frame = await targetFrame(page, field.selector, false);
  if (field.type === 'select') {
    await selectIn(frame, field.selector, field.value);
  } else if (field.type === 'checkbox' || field.type === 'radio') {
    const want = field.type === 'radio' ? true : /^(true|1|yes|on|是)$/i.test(field.value.trim());
    // 自绘复选框的真 input 常被隐藏:正常勾不了就 force
    await frame.setChecked(field.selector, want, { timeout: 3000, ...sig() })
      .catch(() => frame.setChecked(field.selector, want, { timeout: 3000, force: true, ...sig() }));
  } else {
    await typeInFrame(page, frame, field.selector, field.value, FORM_HUMAN_CHARS);
  }
}

export async function fillForm(input: unknown): Promise<ToolResult<{ filled: number }>> {
  try {
    const { fields } = parseInput(FillFormSchema, input);
    const page = await getBrowserManager().getPage();
    let filled = 0;
    for (const [i, field] of fields.entries()) {
      throwIfCancelled();
      try {
        await fillField(page, field);
      } catch (e) {
        // 报清楚是哪一个字段失败、前面已填了几个;不带字段值(可能是密码)
        const base = failFromQuiet(e);
        throw new ToolError(base.code ?? 'INTERNAL', `第 ${i + 1} 个字段(${field.selector})填写失败,前 ${filled} 个已填好:${base.error}`);
      }
      filled++;
    }
    return { success: true, data: { filled } };
  } catch (error) {
    return failFromQuiet(error);
  }
}

/** 按键发给当前获得焦点的元素;回车提交表单引起的跳转会等到新页面就绪 */
export async function keyboardPress(input: unknown): Promise<ToolResult<{ key: string; pressed: boolean } & ActionEffects>> {
  try {
    const { key } = parseInput(KeyboardPressSchema, input);
    const page = await getBrowserManager().getPage();
    const effects = await withActionEffects(page, () => withTimeout(page.keyboard.press(key), 10_000, '按键'));
    return { success: true, data: { key, pressed: true, ...effects } };
  } catch (error) {
    return failFrom(error);
  }
}

/** 原有拖放:dragAndDrop;失败则退回逐步移动鼠标(部分拖拽库只认真实鼠标轨迹) */
async function dragInFrame(page: Page, frame: Frame, source: string, target: string): Promise<void> {
  try {
    await frame.dragAndDrop(source, target, { timeout: 5000, ...sig() });
  } catch (e) {
    if (e instanceof ToolError && e.code === 'CANCELLED') throw e;
    const from = await frame.locator(source).first().boundingBox({ timeout: 3000 });
    const to = await frame.locator(target).first().boundingBox({ timeout: 3000 });
    if (!from || !to) throw e;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
    await page.mouse.up();
  }
}

/** 拖放:拟人开着先走拟人拖动(曲线、慢一点),走不通或关着用原有实现 */
export async function dragAndDrop(input: unknown): Promise<ToolResult<{ dragged: boolean }>> {
  try {
    const { source, target } = parseInput(DragAndDropSchema, input);
    const page = await getBrowserManager().getPage();
    const frame = await targetFrame(page, source, false);
    await humanFirst(async () => {
      // 先把源元素滚进视口,再量目标;目标不在视口里(鼠标够不着)就退回原有实现
      const from = await elementBox(frame, source);
      const to = await frame.locator(target).first().boundingBox({ timeout: 3000, ...sig() });
      const vp = page.viewportSize();
      if (!to || to.width < 1 || to.height < 1) throw new ToolError('ELEMENT_NOT_FOUND', '拖放目标没有可放的区域');
      if (vp && (to.x + to.width < 0 || to.y + to.height < 0 || to.x > vp.width || to.y > vp.height)) {
        throw new ToolError('ELEMENT_NOT_FOUND', '拖放目标不在视口内');
      }
      await humanDrag(page, from, to);
    }, () => dragInFrame(page, frame, source, target));
    return { success: true, data: { dragged: true } };
  } catch (error) {
    return failFrom(error);
  }
}

/** 本机上传白名单(严格模式 / 设了 UPLOAD_ALLOW_DIRS 才生效) */
export function uploadRoots(): string[] | null {
  return uploadAllowRoots([UPLOAD_DIR, SCREENSHOT_DIR, PDF_DIR, DOWNLOAD_DIR]);
}

/**
 * 上传文件。目标是 input[type=file] 直接 setInputFiles;不是(点了才弹文件选择框的按钮)
 * 就点它、接住 filechooser 再塞文件 —— 以前这种情况直接报「Node is not an HTMLInputElement」。
 */
export async function fileUpload(input: unknown): Promise<ToolResult<{ uploaded: boolean; filePath: string }>> {
  try {
    const { selector, filePath } = parseInput(FileUploadSchema, input);
    const real = resolveReadPath(filePath, { allowRoots: uploadRoots() });
    const page = await getBrowserManager().getPage();
    const frame = await targetFrame(page, selector, false);
    const loc = frame.locator(selector).first();
    const isFileInput = await loc.evaluate((el) => el instanceof HTMLInputElement && el.type === 'file', undefined, { timeout: 5000 });
    if (isFileInput) {
      await loc.setInputFiles(real, { timeout: 10_000, ...sig() });
    } else {
      const chooser = page.waitForEvent('filechooser', { timeout: 10_000, ...sig() });
      await loc.click({ timeout: 5000, ...sig() });
      await (await chooser).setFiles(real, { timeout: 10_000 });
    }
    return { success: true, data: { uploaded: true, filePath: real } };
  } catch (error) {
    return failFrom(error);
  }
}

/**
 * 页面里滚动:窗口滚不动(整页滚动其实在某个 overflow:auto 的容器里,SPA 常见)时,
 * 改滚页面上最大的可滚动容器 —— 以前 window.scrollTo 在这类页面上什么都不做却报成功。
 */
const SCROLL_FN = ([x, y, sel]: [number | null, number | null, string | null]) => {
  const scrollable = (el: Element): boolean => {
    const s = getComputedStyle(el);
    return /(auto|scroll|overlay)/.test(s.overflowY + s.overflowX) && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
  };
  let box: Element | null = null;
  if (sel) {
    box = document.querySelector(sel);
    if (!box) return null;
  } else {
    const before = [window.scrollX, window.scrollY];
    window.scrollTo(x ?? window.scrollX, y ?? window.scrollY);
    if (window.scrollX !== before[0] || window.scrollY !== before[1] || (x ?? before[0]) === before[0] && (y ?? before[1]) === before[1]) {
      return { x: window.scrollX, y: window.scrollY, container: 'window' };
    }
    let best = 0;
    for (const el of Array.from(document.querySelectorAll('body *'))) {
      if (!scrollable(el)) continue;
      const area = el.clientWidth * el.clientHeight;
      if (area > best) { best = area; box = el; }
    }
    if (!box) return { x: window.scrollX, y: window.scrollY, container: 'window' };
  }
  box.scrollTo(x ?? box.scrollLeft, y ?? box.scrollTop);
  return { x: box.scrollLeft, y: box.scrollTop, container: sel ?? (box.id ? `#${box.id}` : box.tagName.toLowerCase()) };
};

/** 拟人滚窗口到 y:目标夹到可滚范围内;窗口本身滚不动(SPA 容器滚动)就什么都不做 */
async function humanWindowScroll(page: Page, y: number): Promise<void> {
  const st = await withTimeout(page.evaluate(() => ({
    y: window.scrollY,
    max: document.documentElement.scrollHeight - window.innerHeight,
  })), 5000, '读取滚动位置');
  if (st.max <= 0) return;
  const delta = Math.min(st.max, Math.max(0, y)) - st.y;
  if (Math.abs(delta) >= 1) await humanScroll(page, delta);
}

export async function scroll(input: unknown): Promise<ToolResult<{ scrolled: boolean; x?: number; y?: number; container?: string }>> {
  try {
    const { x, y, selector } = parseInput(ScrollSchema, input);
    const page = await getBrowserManager().getPage();
    if (selector && x === undefined && y === undefined) {
      // 只给 selector:把元素滚进视口(穿透 iframe,也会顺带滚动外层容器)
      const frame = await targetFrame(page, selector, false);
      await frame.locator(selector).first().scrollIntoViewIfNeeded({ timeout: 5000, ...sig() });
      return { success: true, data: { scrolled: true } };
    }
    if (!selector && y !== undefined && humanizeActive()) {
      // 拟人:窗口能滚时先用滚轮分格滚过去;落点由下面的原有逻辑精确校正(滚轮滚不动的容器页也由它兜底)
      await humanWindowScroll(page, y).catch((e: unknown) => { if (isCancelled(e)) throw e; });
    }
    // 给了 x/y(可同时给 selector = 在这个容器里滚)
    const frame = selector ? await targetFrame(page, selector, false) : page.mainFrame();
    const pos = await withTimeout(frame.evaluate(SCROLL_FN, [x ?? null, y ?? null, selector ?? null] as [number | null, number | null, string | null]), 5000, '滚动');
    if (!pos) throw new ToolError('ELEMENT_NOT_FOUND', `元素未找到: ${selector ?? ''}`);
    return { success: true, data: { scrolled: true, ...pos } };
  } catch (error) {
    return failFrom(error);
  }
}
