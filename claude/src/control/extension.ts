/**
 * 自带扩展(第二层控制):加载、找到它的 Service Worker、以及录制 / 网络规则 / 标签页 / 下载这几个工具。
 *
 * 开关 BROWSER_EXTENSION:
 *   auto(默认)= 只在完整版 Chromium 里加载(有头窗口,本机弹窗和虚拟机工位都是);无头的 headless shell 不支持扩展,跳过;
 *   on  = 无头也加载(无头改用完整版 Chromium 的新无头模式,更重一点);
 *   off = 不加载。
 * MCP 调扩展不走消息协议:worker.evaluate() 直接调后台挂在 self.__desk 上的函数。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import type { BrowserContext, Worker } from 'patchright';
import { z } from 'zod';
import { getBrowserManager } from '../browser.js';
import { ToolError, fail, failFrom } from '../errors.js';
import type { ToolResult } from '../types.js';
import type { FlowStep } from './flow.js';

export type ExtensionMode = 'auto' | 'on' | 'off';

/** dist/control/extension.js → claude/extension */
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
  /** 要从启动参数里去掉的(本仓库自己加的和 patchright 默认加的 --disable-extensions) */
  removeArgs: string[];
  ignoreDefaultArgs: string[];
  /** 需要完整版 Chromium(channel: 'chromium');无头时意味着改用新无头模式 */
  needsFullChromium: boolean;
}

/** 给 BrowserManager 启动浏览器时用:返回 null = 这次不加载扩展 */
export function extensionLaunchPatch(headless: boolean, env: Record<string, string | undefined> = process.env): ExtensionLaunchPatch | null {
  const mode = extensionMode(env);
  if (mode === 'off' || (mode === 'auto' && headless)) return null;
  if (!fs.existsSync(path.join(EXTENSION_DIR, 'manifest.json'))) return null;
  return {
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
    removeArgs: ['--disable-extensions'],
    ignoreDefaultArgs: ['--disable-extensions'],
    needsFullChromium: true,
  };
}

/** 找扩展的后台 Service Worker;刚启动时它可能还没起来,最多等 timeoutMs */
export async function deskWorker(context: BrowserContext, timeoutMs = 5000): Promise<Worker> {
  const isOurs = (w: Worker): boolean => w.url().startsWith('chrome-extension://') && w.url().endsWith('/background.js');
  const found = context.serviceWorkers().find(isOurs);
  if (found) return found;
  const w = await context.waitForEvent('serviceworker', { predicate: isOurs, timeout: timeoutMs }).catch(() => null);
  if (!w) {
    throw new ToolError('UNSUPPORTED', '这个浏览器没有加载自带扩展(无头模式默认不加载;需要的话设 BROWSER_EXTENSION=on 后重启服务)');
  }
  return w;
}

async function callDesk<T>(fn: string, ...args: unknown[]): Promise<T> {
  const context = await getBrowserManager().getContext();
  const worker = await deskWorker(context);
  return worker.evaluate(
    ([name, a]) => {
      const desk = (self as unknown as { __desk: Record<string, (...x: unknown[]) => unknown> }).__desk;
      return desk[name as string]?.(...(a as unknown[]));
    },
    [fn, args] as const,
  ) as Promise<T>;
}

// ── 录制 → 流程 ──

export interface RawRecStep {
  type: 'click' | 'fill' | 'select' | 'press' | 'navigate';
  selector?: string;
  value?: string;
  label?: string;
  key?: string;
  url?: string;
  password?: boolean;
  text?: string;
  tabId?: number | null;
  top?: boolean;
}

/** 录到的原始操作 → run_flow 步骤(纯函数,单测见 extension.test.mjs) */
export function toFlowSteps(raw: RawRecStep[]): { steps: FlowStep[]; secretsToFill: number } {
  const steps: FlowStep[] = [];
  let secretsToFill = 0;
  const base = { retry: 0, continueOnError: false };
  for (const s of raw) {
    const prev = steps[steps.length - 1];
    if (s.type === 'navigate' && s.url) {
      if (prev?.tool === 'navigate' && prev.args?.['url'] === s.url) continue;
      steps.push({ ...base, tool: 'navigate', args: { url: s.url } });
    } else if (s.type === 'click' && s.selector) {
      steps.push({ ...base, tool: 'click', args: { selector: s.selector } });
    } else if (s.type === 'fill' && s.selector) {
      // 同一个框连续改了几次(或回车前后各记一次)只留最后一次
      if (prev && ['type', 'fill_secret'].includes(prev.tool) && prev.args?.['selector'] === s.selector) steps.pop();
      if (s.password) {
        secretsToFill++;
        steps.push({ ...base, tool: 'fill_secret', args: { asset: '<<填堡垒机资产 id 或名称>>', field: 'secret', selector: s.selector } });
      } else {
        steps.push({ ...base, tool: 'type', args: { selector: s.selector, text: s.value ?? '' } });
      }
    } else if (s.type === 'select' && s.selector) {
      steps.push({ ...base, tool: 'select_option', args: { selector: s.selector, ...(s.value !== undefined ? { value: s.value } : { label: s.label ?? '' }) } });
    } else if (s.type === 'press' && s.key) {
      steps.push({ ...base, tool: 'keyboard_press', args: { key: s.key } });
    }
  }
  return { steps, secretsToFill };
}

// ── 工具 ──

export const ExtDownloadsSchema = z.object({ limit: z.number().int().min(1).max(200).default(20) });
export const ExtBlockSchema = z.object({
  patterns: z.array(z.string().min(1).max(500)).max(500).default([]).describe('urlFilter 规则,如 ||doubleclick.net^、*.mp4'),
  resourceTypes: z.array(z.enum(['image', 'media', 'font', 'stylesheet', 'script', 'xmlhttprequest', 'sub_frame', 'websocket', 'ping', 'other'])).max(10).default([]),
});

export async function recordStart(): Promise<ToolResult<{ recording: boolean; startedAt: number }>> {
  try { return { success: true, data: await callDesk('recStart') }; } catch (e) { return failFrom(e); }
}

export async function recordStop(): Promise<ToolResult<{ steps: FlowStep[]; rawCount: number; secretsToFill: number; note: string }>> {
  try {
    const r = await callDesk<{ steps: RawRecStep[] }>('recStop');
    const { steps, secretsToFill } = toFlowSteps(r.steps ?? []);
    const note = secretsToFill > 0
      ? `录到 ${secretsToFill} 个密码框:没有记内容,已换成 fill_secret,请把 asset 改成对应的堡垒机资产后再回放`
      : '可直接交给 run_flow 回放';
    return { success: true, data: { steps, rawCount: (r.steps ?? []).length, secretsToFill, note } };
  } catch (e) {
    return failFrom(e);
  }
}

export async function recordStatus(): Promise<ToolResult<{ recording: boolean; steps: number; startedAt: number | null }>> {
  try { return { success: true, data: await callDesk('recStatus') }; } catch (e) { return failFrom(e); }
}

export async function extTabs(): Promise<ToolResult<unknown[]>> {
  try { return { success: true, data: await callDesk('tabs') }; } catch (e) { return failFrom(e); }
}

export async function extDownloads(input: unknown): Promise<ToolResult<unknown[]>> {
  const p = ExtDownloadsSchema.safeParse(input ?? {});
  if (!p.success) return fail('INVALID_ARGS', `参数验证失败: ${p.error.message}`);
  try { return { success: true, data: await callDesk('downloads', p.data.limit) }; } catch (e) { return failFrom(e); }
}

export async function extBlockRules(input: unknown): Promise<ToolResult<{ rules: number }>> {
  const p = ExtBlockSchema.safeParse(input ?? {});
  if (!p.success) return fail('INVALID_ARGS', `参数验证失败: ${p.error.message}`);
  try { return { success: true, data: await callDesk('setBlockRules', p.data.patterns, p.data.resourceTypes) }; } catch (e) { return failFrom(e); }
}
