/**
 * 工具里不碰浏览器的纯函数:参数校验、URL 模式、sitemap 解析。单测直接跑(不 import browser / paths)。
 */

import type { z } from 'zod';
import { ToolError } from '../errors.js';

/** Zod 校验;失败抛 INVALID_ARGS(文字保留「参数验证失败」,老的按文字归类也认得) */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw new ToolError('INVALID_ARGS', `参数验证失败: ${r.error.message}`);
  return r.data;
}

/**
 * URL 模式 → 正则。写成 /.../ 或含正则专用记号(^ $ ( [ | \ + { 或 .*)按正则;否则按通配符(* 任意、? 单字符)。
 * 以前先试 new RegExp,"api/ping*" 这种通配写法恰好是合法正则(g 重复 0 次以上),语义就悄悄变了。
 */
export function patternToRegex(pattern: string): RegExp {
  const slashed = /^\/(.+)\/([a-z]*)$/i.exec(pattern);
  if (slashed?.[1]) {
    try { return new RegExp(slashed[1], slashed[2]); } catch { /* 当通配符处理 */ }
  }
  if (/[\^$()[\]|\\+{]|\.\*/.test(pattern)) {
    try { return new RegExp(pattern); } catch { /* 当通配符处理 */ }
  }
  return new RegExp(pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.'));
}

/** 解析 sitemap XML 中的 <loc>:认 CDATA,解 XML 实体(以前 &amp; 原样留在网址里) */
export function parseSitemapLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    if (!m[1]) continue;
    out.push(m[1].trim().replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
  }
  return out;
}
