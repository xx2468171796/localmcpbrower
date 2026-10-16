/**
 * 打字节奏与滚轮分段(纯计算)。随机源由调用方注入,单测用固定种子复现。
 */

import { type Rand, chance, clamp, uniform } from './rng.js';

export interface TypingStep {
  /** 要输入的字符(按码点切分,emoji 等代理对不会被拆开) */
  char: string;
  /** 输入这个字符前等待的毫秒数 */
  delayMs: number;
  /** 有值 = 先错按这个键,停一下,按 Backspace 删掉,再输入 char */
  typoBefore?: string;
}

export interface TypingOptions {
  /** 不许出错字(密码框):一律 true 时完全不产生 typoBefore */
  noTypos?: boolean;
  /** 每个 ASCII 字母出错字的概率,默认 0.02 */
  typoRate?: number;
}

/** QWERTY 键盘上相邻的键(只覆盖小写字母;大写字母错按时保持大写) */
const ADJACENT: Record<string, string> = {
  q: 'wa', w: 'qeas', e: 'wrsd', r: 'etdf', t: 'ryfg', y: 'tugh', u: 'yihj', i: 'uojk', o: 'ipkl', p: 'ol',
  a: 'qwsz', s: 'awedxz', d: 'serfcx', f: 'drtgvc', g: 'ftyhbv', h: 'gyujnb', j: 'huikmn', k: 'jiolm', l: 'kop',
  z: 'asx', x: 'zsdc', c: 'xdfv', v: 'cfgb', b: 'vghn', n: 'bhjm', m: 'njk',
};

const PUNCT = /[.,;:!?。，；：！？、)\]}]/;

/** 单个字符前的停顿:基础 40–160ms(偏向中间),词边界 / 标点后偶尔长停,极少数「想一想」 */
function delayFor(prev: string | undefined, rand: Rand): number {
  // 两个均匀数的平均 → 三角分布,集中在 100ms 左右,两端少
  let d = 40 + 120 * ((rand() + rand()) / 2);
  if (prev === ' ' && chance(rand, 0.35)) d += uniform(rand, 80, 260);
  else if (prev !== undefined && PUNCT.test(prev) && chance(rand, 0.6)) d += uniform(rand, 150, 400);
  else if (chance(rand, 0.03)) d += uniform(rand, 250, 650);
  return Math.round(d);
}

function typoFor(char: string, rand: Rand): string | undefined {
  const lower = char.toLowerCase();
  const near = ADJACENT[lower];
  if (!near) return undefined;
  const pick = near[Math.floor(rand() * near.length)] ?? near.charAt(0);
  return char === lower ? pick : pick.toUpperCase();
}

/** 逐字输入计划。只对 ASCII 字母按概率安排错字(随后用 Backspace 改正);noTypos 时一个也不安排 */
export function typingPlan(text: string, rand: Rand, opts: TypingOptions = {}): TypingStep[] {
  const rate = opts.noTypos ? 0 : clamp(opts.typoRate ?? 0.02, 0, 0.5);
  const out: TypingStep[] = [];
  let prev: string | undefined;
  for (const char of Array.from(text)) {
    const step: TypingStep = { char, delayMs: prev === undefined ? Math.round(uniform(rand, 30, 120)) : delayFor(prev, rand) };
    if (rate > 0 && /^[A-Za-z]$/.test(char) && chance(rand, rate)) {
      const typo = typoFor(char, rand);
      if (typo !== undefined) step.typoBefore = typo;
    }
    out.push(step);
    prev = char;
  }
  return out;
}

/** 按键按下到抬起的时长 */
export function keyHoldMs(rand: Rand): number {
  return Math.round(uniform(rand, 25, 90));
}

export interface WheelStep {
  /** 这一格滚多少像素(整数,符号与 deltaY 一致) */
  dy: number;
  /** 这一格之前等待的毫秒数 */
  dt: number;
}

/** 滚轮格数上限:滚很远时每格变大,而不是滚几百格 */
const MAX_TICKS = 60;

/**
 * 滚轮分段:每格 60–120px、间隔 15–40ms,越到后面格子越小、间隔越长(减速)。
 * 各格之和恰好等于 deltaY(四舍五入的误差结转到下一格)。
 */
export function scrollPlan(deltaY: number, rand: Rand): WheelStep[] {
  const total = Math.round(Math.abs(deltaY));
  if (!Number.isFinite(total) || total === 0) return [];
  const sign = deltaY < 0 ? -1 : 1;
  const n = clamp(Math.ceil(total / uniform(rand, 85, 100)), 1, MAX_TICKS);
  // 权重从 1 线性降到约 0.55(减速),每格再抖一下
  const weights = Array.from({ length: n }, (_, i) => (1 - 0.45 * (n > 1 ? i / (n - 1) : 0)) * uniform(rand, 0.9, 1.1));
  const wsum = weights.reduce((s, w) => s + w, 0);
  const out: WheelStep[] = [];
  let carry = 0;
  let used = 0;
  for (let i = 0; i < n; i++) {
    const w = weights[i] ?? 1;
    const exact = (total * w) / wsum + carry;
    const px = i === n - 1 ? total - used : Math.round(exact);
    carry = exact - px;
    used += px;
    const progress = n > 1 ? i / (n - 1) : 1;
    out.push({ dy: sign * px, dt: Math.round(15 + 20 * progress * uniform(rand, 0.6, 1) + uniform(rand, 0, 5)) });
  }
  return out.filter((s) => s.dy !== 0);
}
