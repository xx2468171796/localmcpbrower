/**
 * 拟人操作(humanize)入口:要不要拟人 + 执行函数。
 *
 * 要不要拟人由「解析器」决定:默认看环境变量 BROWSER_HUMANIZE(1 / true / on / yes = 开);
 * browser.ts 之后会注册按工作区身份判断的解析器(space_new { humanize })。本模块只管「怎么做得像人」,不管开关存在哪。
 */

export { HumanMiss, elementBox, humanClick, humanDrag, humanHover, humanScroll, humanType, isCancelled, moveMouse } from './actions.js';
export type { HumanTypeOptions } from './actions.js';
export type { Box, Point } from './path.js';

/** 环境变量的开关值:1 / true / on / yes(不分大小写)= 开 */
export function humanizeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|yes)$/i.test((env['BROWSER_HUMANIZE'] ?? '').trim());
}

let resolver: () => boolean = () => humanizeFromEnv();

/** 换掉「要不要拟人」的判断(按当前会话 / 工作区);传 null 恢复成只看环境变量 */
export function setHumanizeResolver(fn: (() => boolean) | null): void {
  resolver = fn ?? (() => humanizeFromEnv());
}

/** 当前调用要不要走拟人路径;解析器出错按「不拟人」处理(保持原有行为) */
export function humanizeActive(): boolean {
  try {
    return resolver();
  } catch {
    return false;
  }
}
