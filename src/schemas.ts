/**
 * Zod 验证 Schema
 * @description 定义所有工具输入的验证规则
 */

import { z } from 'zod';

/** 导航工具输入 Schema */
export const NavigateSchema = z.object({
  url: z.string().url('必须是有效的 URL')
});

/** 点击工具输入 Schema */
export const ClickSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空')
});

/** 输入工具输入 Schema */
export const TypeSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空'),
  text: z.string()
});

/** 截图工具输入 Schema */
export const ScreenshotSchema = z.object({
  name: z.string().optional(),
  fullPage: z.boolean().default(false)
});

/** 执行 JS 工具输入 Schema */
export const ExecuteJsSchema = z.object({
  script: z.string().min(1, 'script 不能为空')
});

/** 导出类型推断 */
export type NavigateInput = z.infer<typeof NavigateSchema>;
export type ClickInput = z.infer<typeof ClickSchema>;
export type TypeInput = z.infer<typeof TypeSchema>;
export type ScreenshotInput = z.infer<typeof ScreenshotSchema>;
export type ExecuteJsInput = z.infer<typeof ExecuteJsSchema>;
