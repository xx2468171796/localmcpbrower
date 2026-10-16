/**
 * 往磁盘写文件的工具:take_screenshot / pdf_export。路径一律经 safe-path.ts 收口。
 */

import * as fs from 'fs';
import * as path from 'path';
import { getBrowserManager } from '../browser.js';
import { fail, failFrom } from '../errors.js';
import { PDF_DIR, SCREENSHOT_DIR } from '../paths.js';
import { isStrictPaths, parseRootList, resolveWritePath, safeFileName } from '../safe-path.js';
import { currentSignal } from '../context.js';
import { ScreenshotSchema, PdfExportSchema } from '../schemas.js';
import type { ToolResult, ScreenshotResult } from '../types.js';
import { DOWNLOAD_DIR, parseInput } from './common.js';
import { withTimeout } from './timing.js';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export async function takeScreenshot(input: unknown): Promise<ToolResult<ScreenshotResult & { base64?: string; format?: 'jpeg' | 'png' }>> {
  try {
    const { name, fullPage, format, quality } = parseInput(ScreenshotSchema, input);
    // name 只许是文件名:以前 "../../x" 能把截图写到截图目录外面
    const fileName = name !== undefined ? safeFileName(name) : `screenshot-${Date.now()}`;
    const page = await getBrowserManager().getPage();
    ensureDir(SCREENSHOT_DIR);
    const ext = format === 'png' ? 'png' : 'jpg';
    const filePath = path.join(SCREENSHOT_DIR, `${fileName}.${ext}`);

    // 等待字体就绪,但用 300ms 超时兜底,避免 document.fonts.ready 永不 resolve 导致挂起
    await withTimeout(page.evaluate('document.fonts && document.fonts.ready.then(() => true)'), 300, '等字体').catch(() => { /* 不等了 */ });

    const shotOpts = format === 'jpeg' ? { type: 'jpeg' as const, quality } : { type: 'png' as const };
    const signal = currentSignal();
    const base = { path: filePath, timeout: 10000, animations: 'disabled' as const, scale: 'css' as const, ...shotOpts, ...(signal ? { signal } : {}) };
    let buffer: Buffer;
    let shotFull = fullPage;
    try {
      buffer = await page.screenshot({ ...base, fullPage });
    } catch (e) {
      if (!fullPage) throw e;
      // 整页截图失败(超长页面 / 超出纹理上限)才退回当前视口;结果里如实标 fullPage=false
      buffer = await page.screenshot({ ...base, fullPage: false });
      shotFull = false;
    }
    return { success: true, data: { path: filePath, fullPage: shotFull, base64: buffer.toString('base64'), format } };
  } catch (error) {
    return failFrom(error);
  }
}

/** PDF 的输出规则(见 safe-path.ts):相对路径进 PDF_DIR;绝对路径严格模式下只许进输出目录 */
export function pdfTarget(requested: string): string {
  return resolveWritePath(requested, {
    baseDir: PDF_DIR,
    allowRoots: [SCREENSHOT_DIR, DOWNLOAD_DIR, ...parseRootList(process.env['OUTPUT_ALLOW_DIRS'])],
    strict: isStrictPaths(),
    extension: '.pdf',
  });
}

export async function pdfExport(input: unknown): Promise<ToolResult<{ path: string }>> {
  try {
    const { path: requested } = parseInput(PdfExportSchema, input);
    const pdfPath = pdfTarget(requested);
    const page = await getBrowserManager().getPage();
    ensureDir(path.dirname(pdfPath));
    try {
      await withTimeout(page.pdf({ path: pdfPath, printBackground: true, format: 'A4' }), 60_000, '导出 PDF', { signal: currentSignal() });
    } catch (e) {
      if (e instanceof Error && /headless/i.test(e.message)) {
        return fail('UNSUPPORTED', 'PDF 只能在无头模式下导出:当前工作区开着可见窗口,先调 hide_window 收起再导出');
      }
      throw e;
    }
    return { success: true, data: { path: pdfPath } };
  } catch (error) {
    return failFrom(error);
  }
}
