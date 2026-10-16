/**
 * 拟人操作用的随机数。纯计算模块(path.ts / timing.ts)一律把随机源当参数收进来:
 * 生产传 Math.random,单测传 seeded(种子) —— 同一个种子每次生成的轨迹 / 节奏都一样,断言可复现。
 */

/** 返回 [0, 1) 的随机数,签名与 Math.random 相同 */
export type Rand = () => number;

/** mulberry32:32 位状态的小 PRNG,够用于测试复现(不用于任何安全场景) */
export function seeded(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [min, max) 均匀分布 */
export function uniform(rand: Rand, min: number, max: number): number {
  return min + (max - min) * rand();
}

/** 近似正态(四个均匀数求和,Irwin–Hall),均值 0、标准差约 1,天然落在 [-3.46, 3.46] 内 */
export function gaussian(rand: Rand): number {
  return (rand() + rand() + rand() + rand() - 2) * Math.sqrt(3);
}

/** 以概率 p 返回 true */
export function chance(rand: Rand, p: number): boolean {
  return rand() < p;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}
