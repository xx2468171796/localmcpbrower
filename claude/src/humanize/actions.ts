/**
 * 拟人操作的执行层:把 path.ts / timing.ts 算出的轨迹、节奏用 patchright 的 Page.mouse / keyboard 真正做出来。
 *
 * 约定:
 *  - 元素层面做不了(不可见、没有框、被别的元素挡住、不在视口、输入框类型不适合逐字敲、敲完值对不上)
 *    一律抛 HumanMiss —— 调用方(tools/interact.ts)接住后退回原来的可靠路径,拟人永远不让工具变得更不可靠;
 *  - 每一步之间都检查取消(throwIfCancelled + 可取消的 sleep),工具取消 / 期限照常生效;
 *  - 鼠标按下后无论如何都会抬起(finally),不会把按键卡在按下状态。
 */

import type { Frame, Locator, Page } from 'patchright';
import { currentSignal, throwIfCancelled } from '../context.js';
import { ToolError } from '../errors.js';
import { sleep } from '../tools/timing.js';
import { type Box, type PathOptions, type Point, mousePath, pointInBox } from './path.js';
import { type Rand, uniform } from './rng.js';
import { keyHoldMs, scrollPlan, typingPlan } from './timing.js';

/** 拟人路径在元素层面走不通:调用方应退回原有实现 */
export class HumanMiss extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HumanMiss';
  }
}

/** 这个错误是不是「调用方取消了」—— 取消不能被当成 HumanMiss 去走后备路径 */
export function isCancelled(e: unknown): boolean {
  return (e instanceof ToolError && e.code === 'CANCELLED') || currentSignal()?.aborted === true;
}

const rand: Rand = Math.random;
/** 每个页面上次鼠标停在哪(页面关掉就随 WeakMap 一起回收) */
const lastPos = new WeakMap<Page, Point>();

function sig(): { signal?: AbortSignal } {
  const s = currentSignal();
  return s ? { signal: s } : {};
}

/** 可取消的停顿 */
async function pause(ms: number): Promise<void> {
  throwIfCancelled();
  await sleep(ms, currentSignal());
}

/** 把元素层面的失败统一成 HumanMiss;取消原样抛出 */
async function orMiss<T>(work: Promise<T>, what: string): Promise<T> {
  try {
    return await work;
  } catch (e) {
    if (isCancelled(e)) {
      throwIfCancelled();
      throw e;
    }
    throw new HumanMiss(`${what}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
}

async function viewport(page: Page): Promise<{ width: number; height: number }> {
  const v = page.viewportSize();
  if (v) return v;
  return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
}

/** 鼠标起点:上次的位置;不知道(新页面)就取视口中部一个随机的、像人放着鼠标的位置 */
async function startPoint(page: Page): Promise<Point> {
  const known = lastPos.get(page);
  if (known) return known;
  const vp = await viewport(page);
  return { x: vp.width * uniform(rand, 0.25, 0.75), y: vp.height * uniform(rand, 0.3, 0.8) };
}

/** 沿拟人轨迹把鼠标移到 to(视口坐标) */
export async function moveMouse(page: Page, to: Point, opts: PathOptions = {}): Promise<void> {
  const from = await startPoint(page);
  for (const p of mousePath(from, to, rand, opts)) {
    await pause(p.dt);
    await page.mouse.move(p.x, p.y);
    lastPos.set(page, { x: p.x, y: p.y });
  }
}

/** 等元素可见并滚进视口;做不到就是 HumanMiss */
async function locate(frame: Frame, selector: string): Promise<Locator> {
  const loc = frame.locator(selector).first();
  await orMiss(loc.waitFor({ state: 'visible', timeout: 3000, ...sig() }), '元素不可见');
  await orMiss(loc.scrollIntoViewIfNeeded({ timeout: 3000, ...sig() }), '滚动到元素失败');
  return loc;
}

/**
 * 元素在主框架视口里的框。boundingBox 对 iframe 里的元素也给主框架坐标,page.mouse 正好用这个坐标系。
 * 宽或高不到 1px 当作没有框。
 */
export async function elementBox(frame: Frame, selector: string): Promise<Box> {
  const loc = await locate(frame, selector);
  return boxOf(loc);
}

async function boxOf(loc: Locator): Promise<Box> {
  const box = await orMiss(loc.boundingBox({ timeout: 3000, ...sig() }), '取元素位置失败');
  if (!box || box.width < 1 || box.height < 1) throw new HumanMiss('元素没有可点的区域');
  return box;
}

/**
 * 点 pt 时真正命中的是不是这个元素(或它的子孙 / 关联它的 label)。
 * 坐标换算:框是主框架坐标,elementFromPoint 要元素所在 frame 的坐标,差值就是 frame 的偏移。
 */
async function hits(loc: Locator, box: Box, pt: Point): Promise<boolean> {
  const arg = { px: pt.x - box.x, py: pt.y - box.y };
  return loc.evaluate((el, a) => {
    const r = el.getBoundingClientRect();
    const x = r.left + a.px;
    const y = r.top + a.py;
    const root = el.getRootNode();
    const scope: Pick<Document, 'elementFromPoint'> = root instanceof ShadowRoot
      ? (root as unknown as Pick<Document, 'elementFromPoint'>)
      : document;
    const hit = scope.elementFromPoint(x, y);
    if (!hit) return false;
    return hit === el || el.contains(hit) || (hit instanceof HTMLLabelElement && hit.control === el);
  }, arg, { timeout: 2000 }).catch(() => false);
}

/** 挑一个落点:框内随机点,在视口里且没被挡住;试几次都不行就是 HumanMiss */
async function aim(page: Page, loc: Locator): Promise<Point> {
  const box = await boxOf(loc);
  const vp = await viewport(page);
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  for (let i = 0; i < 4; i++) {
    throwIfCancelled();
    const pt = i < 3 ? pointInBox(box, rand) : center;
    if (pt.x < 0 || pt.y < 0 || pt.x >= vp.width || pt.y >= vp.height) continue;
    if (await hits(loc, box, pt)) return pt;
  }
  throw new HumanMiss('元素被遮挡或不在视口内');
}

/** 移到元素上(落点重新确认没被挡),返回落点 */
async function approach(page: Page, loc: Locator): Promise<Point> {
  const pt = await aim(page, loc);
  await moveMouse(page, pt);
  // 悬停可能弹出菜单 / 遮罩:落定后再确认一次,挡住了就别按下去(按下去会点错东西)
  if (!(await hits(loc, await boxOf(loc), pt))) throw new HumanMiss('移过去之后元素被遮挡');
  return pt;
}

/** 按下 → 停 40–120ms → 抬起;抬起放在 finally,取消也不会卡在按下状态 */
async function press(page: Page): Promise<void> {
  await page.mouse.down();
  try {
    await sleep(Math.round(uniform(rand, 40, 120)));
  } finally {
    await page.mouse.up();
  }
}

async function clickLocator(page: Page, loc: Locator): Promise<void> {
  await approach(page, loc);
  await pause(uniform(rand, 40, 140));
  await press(page);
}

/** 拟人点击:曲线移过去 → 稍停 → 按下抬起;落点是元素内的随机点 */
export async function humanClick(page: Page, frame: Frame, selector: string): Promise<void> {
  await clickLocator(page, await locate(frame, selector));
}

/** 拟人悬停:曲线移到元素内的随机点 */
export async function humanHover(page: Page, frame: Frame, selector: string): Promise<void> {
  await approach(page, await locate(frame, selector));
}

export interface HumanTypeOptions {
  /** 密码框:不安排错字 */
  password?: boolean;
  /** 前多少个字逐字敲,默认 200 */
  humanChars?: number;
}

/** 能逐字敲的输入框种类;其它(日期、颜色、文件……)交给原有的 fill */
const TYPABLE = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password']);

async function prepareField(loc: Locator): Promise<{ hasValue: boolean }> {
  const info = await orMiss(loc.evaluate((el, typable) => {
    if (el instanceof HTMLTextAreaElement) return { ok: !el.disabled && !el.readOnly, hasValue: el.value !== '' };
    if (el instanceof HTMLInputElement) {
      const ok = typable.includes(el.type.toLowerCase()) && !el.disabled && !el.readOnly;
      return { ok, hasValue: el.value !== '' };
    }
    if (el instanceof HTMLElement && el.isContentEditable) return { ok: true, hasValue: (el.textContent ?? '') !== '' };
    return { ok: false, hasValue: false };
  }, [...TYPABLE], { timeout: 2000 }), '读取输入框失败');
  if (!info.ok) throw new HumanMiss('这种输入框不适合逐字输入');
  return { hasValue: info.hasValue };
}

/** 确认焦点在输入框里;点击没把焦点带进去(被 label 之类接走)就直接 focus */
async function ensureFocus(loc: Locator): Promise<void> {
  const focused = await loc.evaluate((el) => el === document.activeElement || el.contains(document.activeElement), undefined, { timeout: 2000 })
    .catch(() => false);
  if (!focused) await orMiss(loc.focus({ timeout: 2000 }), '聚焦输入框失败');
}

/** 清掉原有内容:全选元素内的文字后按一次 Backspace(和人「全选删除」一样) */
async function clearField(page: Page, loc: Locator): Promise<void> {
  await orMiss(loc.evaluate((el) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { el.select(); return; }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }, undefined, { timeout: 2000 }), '全选原有内容失败');
  await pause(uniform(rand, 60, 160));
  await page.keyboard.press('Backspace', { delay: keyHoldMs(rand) });
}

/** 敲一个字符:可见字符走真实按键(带按住时长);控制字符(换行、Tab)直接插入,免得 Enter 提交表单、Tab 跳走焦点 */
async function typeChar(page: Page, char: string): Promise<void> {
  if (char.charCodeAt(0) < 0x20) await page.keyboard.insertText(char);
  else await page.keyboard.type(char, { delay: keyHoldMs(rand) });
}

async function typeSteps(page: Page, text: string, password: boolean): Promise<void> {
  for (const step of typingPlan(text, rand, { noTypos: password })) {
    await pause(step.delayMs);
    if (step.typoBefore !== undefined) {
      await typeChar(page, step.typoBefore);
      await pause(uniform(rand, 120, 320));
      await page.keyboard.press('Backspace', { delay: keyHoldMs(rand) });
      await pause(uniform(rand, 60, 160));
    }
    await typeChar(page, step.char);
  }
}

/**
 * 拟人输入:点进输入框 → 有旧内容先全选删除 → 按节奏逐字敲(偶尔敲错再退格改正,密码框不出错)。
 * 长文本只逐字敲前 humanChars 个字,剩下的用 keyboard.insertText 一次插入 ——
 * 几千字逐字敲要好几分钟,会撞上工具期限;开头一段有节奏已经足够像人。
 * 敲完在页面里比对最终值(值不回传,密码不出页面),对不上就是 HumanMiss,由调用方用 fill 兜底。
 */
export async function humanType(page: Page, frame: Frame, selector: string, text: string, opts: HumanTypeOptions = {}): Promise<void> {
  const loc = await locate(frame, selector);
  const { hasValue } = await prepareField(loc);
  await clickLocator(page, loc);
  await ensureFocus(loc);
  if (hasValue) await clearField(page, loc);
  const chars = Array.from(text);
  const limit = Math.max(0, opts.humanChars ?? 200);
  await typeSteps(page, chars.slice(0, limit).join(''), opts.password === true);
  const rest = chars.slice(limit).join('');
  if (rest) {
    await pause(uniform(rand, 80, 200));
    await page.keyboard.insertText(rest);
  }
  const same = await orMiss(loc.evaluate((el, want) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value === want;
    return (el.textContent ?? '') === want;
  }, text, { timeout: 2000 }), '核对输入结果失败');
  if (!same) throw new HumanMiss('逐字输入后的值与要求不一致');
}

/** 等窗口滚动停下来(滚轮滚动可能带平滑动画),最多 800ms */
async function settleScroll(page: Page): Promise<void> {
  let prev = Number.NaN;
  for (let i = 0; i < 8; i++) {
    await pause(100);
    const y = await page.evaluate(() => window.scrollY).catch(() => prev);
    if (y === prev) return;
    prev = y;
  }
}

/**
 * 拟人滚动:鼠标先在页面上(不在就移进来),然后分几格滚轮、减速停下。
 * 滚轮作用于鼠标下面的可滚动元素;要精确落到某个位置由调用方事后校正。
 */
export async function humanScroll(page: Page, deltaY: number): Promise<void> {
  if (!lastPos.get(page)) await moveMouse(page, await startPoint(page));
  for (const step of scrollPlan(deltaY, rand)) {
    await pause(step.dt);
    await page.mouse.wheel(0, step.dy);
  }
  await settleScroll(page);
}

/**
 * 拟人拖放:移到源元素内 → 按下 → 先小挪几像素(越过拖拽阈值)→ 比平常慢的曲线移到目标 → 停一下 → 抬起。
 * 两个框都是主框架视口坐标(elementBox 给的)。
 */
export async function humanDrag(page: Page, fromBox: Box, toBox: Box): Promise<void> {
  const start = pointInBox(fromBox, rand);
  const end = pointInBox(toBox, rand);
  await moveMouse(page, start);
  await pause(uniform(rand, 60, 160));
  await page.mouse.down();
  try {
    await pause(uniform(rand, 80, 200));
    const nudge = { x: start.x + uniform(rand, -4, 4), y: start.y + uniform(rand, 3, 6) };
    await page.mouse.move(nudge.x, nudge.y, { steps: 2 });
    lastPos.set(page, nudge);
    await moveMouse(page, end, { slow: 1.4 });
    await pause(uniform(rand, 60, 160));
  } finally {
    await page.mouse.up();
  }
}
