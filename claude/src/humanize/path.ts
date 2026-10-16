/**
 * 鼠标轨迹(纯计算):三次贝塞尔曲线 + 随机控制点 + 先加速后减速的节奏,长距离先略微冲过头再拉回。
 * 总时长按 Fitts 定律随距离增长(约 150–700ms),点数随距离增长。随机源由调用方注入。
 */

import { type Rand, clamp, gaussian, uniform } from './rng.js';

export interface Point { x: number; y: number }
/** 轨迹上的一个点;dt = 距上一个点的毫秒数(执行时先等 dt 再移过去) */
export interface PathPoint extends Point { dt: number }
export interface Box { x: number; y: number; width: number; height: number }

export interface PathOptions {
  /** 时长倍率(拖拽时手更慢,传 1.3 之类);默认 1 */
  slow?: number;
}

const MIN_MS = 150;
const MAX_MS = 700;
/** 超过这个距离才做「冲过头再拉回」 */
const OVERSHOOT_DIST = 300;

/** 先加速后减速(ease-in-out cubic) */
function easeInOut(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** Fitts 风格的总时长:a + b·log2(D/W + 1),带 ±10% 抖动,夹到 [150, 700] */
export function moveDuration(dist: number, rand: Rand): number {
  const base = 120 + 95 * Math.log2(dist / 20 + 1);
  return clamp(base * uniform(rand, 0.9, 1.1), MIN_MS, MAX_MS);
}

/** 点数随距离增长,至少 12 个(页面能收到足够多的 mousemove),最多 70 个 */
function stepCount(dist: number, rand: Rand): number {
  return Math.round(clamp(dist / 14 + uniform(rand, 10, 16), 12, 70));
}

/** 一段贝塞尔:随机控制点在连线两侧,偏移量与距离成比例 */
function segment(from: Point, to: Point, durationMs: number, steps: number, rand: Rand): PathPoint[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  // 连线的单位法向量:控制点往两侧偏,轨迹才是弧线而不是直线
  const nx = dist > 0 ? -dy / dist : 0;
  const ny = dist > 0 ? dx / dist : 0;
  const spread = Math.min(dist * 0.25, 160);
  const c1t = uniform(rand, 0.2, 0.45);
  const c2t = uniform(rand, 0.55, 0.8);
  const off1 = gaussian(rand) * spread * 0.5;
  // 两个控制点多数在同一侧(一条弧),偶尔异侧(S 形)
  const off2 = (rand() < 0.8 ? Math.sign(off1) || 1 : -(Math.sign(off1) || 1)) * Math.abs(gaussian(rand)) * spread * 0.4;
  const p1 = { x: from.x + dx * c1t + nx * off1, y: from.y + dy * c1t + ny * off1 };
  const p2 = { x: from.x + dx * c2t + nx * off2, y: from.y + dy * c2t + ny * off2 };
  const out: PathPoint[] = [];
  let prevT = 0;
  for (let i = 1; i <= steps; i++) {
    const tLinear = i / steps;
    const pt = i === steps ? { x: to.x, y: to.y } : bezier(from, p1, p2, to, easeInOut(tLinear));
    // 每段的时间片带一点抖动;最后把总和校正回 durationMs
    const slice = (tLinear - prevT) * durationMs * uniform(rand, 0.85, 1.15);
    prevT = tLinear;
    out.push({ x: pt.x, y: pt.y, dt: slice });
  }
  const sum = out.reduce((s, p) => s + p.dt, 0);
  const k = sum > 0 ? durationMs / sum : 0;
  for (const p of out) p.dt = Math.max(1, Math.round(p.dt * k));
  return out;
}

/**
 * 从 from 到 to 的鼠标轨迹(不含起点,最后一个点恰好是 to)。
 * 距离 > 300px 时先冲过目标 3–6% 再用几步拉回,像真人手腕的过冲修正。
 */
export function mousePath(from: Point, to: Point, rand: Rand, opts: PathOptions = {}): PathPoint[] {
  const slow = opts.slow ?? 1;
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  if (!Number.isFinite(dist)) throw new RangeError('mousePath: 坐标不是有限数');
  if (dist < 1) return [{ x: to.x, y: to.y, dt: Math.round(uniform(rand, 20, 40)) }];
  const total = moveDuration(dist, rand) * slow;
  if (dist <= OVERSHOOT_DIST) return segment(from, to, total, stepCount(dist, rand), rand);
  const ux = (to.x - from.x) / dist;
  const uy = (to.y - from.y) / dist;
  const over = dist * uniform(rand, 0.03, 0.06);
  const side = gaussian(rand) * 6;
  const peak = { x: to.x + ux * over - uy * side, y: to.y + uy * over + ux * side };
  const main = segment(from, peak, total * 0.85, stepCount(dist, rand), rand);
  const fix = segment(peak, to, total * 0.15, Math.round(uniform(rand, 4, 7)), rand);
  return [...main, ...fix];
}

/**
 * 元素框内的随机点:围绕中心近似正态分布(真人多点在中间附近,但不会正中),离边至少 2px。
 * 框比 4px 还窄时就取中心。
 */
export function pointInBox(box: Box, rand: Rand): Point {
  const axis = (start: number, size: number): number => {
    if (size <= 4) return start + size / 2;
    const v = start + size / 2 + gaussian(rand) * size / 7;
    return clamp(v, start + 2, start + size - 2);
  };
  return { x: axis(box.x, box.width), y: axis(box.y, box.height) };
}
