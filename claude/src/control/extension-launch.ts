/**
 * 自带扩展的加载参数(只管「启动浏览器时加什么参数」,不依赖 BrowserManager,browser.ts 引用它不会成环)。
 *
 * 开关 BROWSER_EXTENSION:
 *   auto(默认)= 只在有头窗口里加载(本机弹窗和虚拟机工位都是);无头不加载(省内存,无头时也用不上录制);
 *   on  = 无头也加载;
 *   off = 不加载。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ExtensionMode = 'auto' | 'on' | 'off';

/** dist/control/extension-launch.js → claude/extension */
export const EXTENSION_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'extension');

export function extensionMode(env: Record<string, string | undefined> = process.env): ExtensionMode {
  const v = (env['BROWSER_EXTENSION'] ?? 'auto').trim().toLowerCase();
  if (/^(off|0|false|no)$/.test(v)) return 'off';
  if (/^(on|1|true|yes)$/.test(v)) return 'on';
  return 'auto';
}

export interface ExtensionLaunchPatch {
  /** 追加到启动参数 */
  args: string[];
  /** 要从本仓库自己的启动参数里去掉的 */
  removeArgs: string[];
  /** patchright 默认参数里要去掉的 */
  ignoreDefaultArgs: string[];
}

/** 返回 null = 这次不加载扩展 */
export function extensionLaunchPatch(headless: boolean, env: Record<string, string | undefined> = process.env): ExtensionLaunchPatch | null {
  const mode = extensionMode(env);
  if (mode === 'off' || (mode === 'auto' && headless)) return null;
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) return null;
  return {
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    removeArgs: ['--disable-extensions'],
    ignoreDefaultArgs: ['--disable-extensions'],
  };
}
