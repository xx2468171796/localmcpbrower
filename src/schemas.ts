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

/** 滚动工具输入 Schema */
export const ScrollSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  selector: z.string().optional()
});

/** 等待选择器工具输入 Schema */
export const WaitForSelectorSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空'),
  state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible'),
  timeout: z.number().default(30000)
});

/** 获取元素文本工具输入 Schema */
export const GetElementTextSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空')
});

/** 获取元素属性工具输入 Schema */
export const GetElementAttributeSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空'),
  attribute: z.string().min(1, 'attribute 不能为空')
});

/** 悬停工具输入 Schema */
export const HoverSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空')
});

/** 下拉选择工具输入 Schema */
export const SelectOptionSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空'),
  value: z.string().optional(),
  label: z.string().optional()
});

/** 表单填充工具输入 Schema */
export const FillFormSchema = z.object({
  fields: z.array(z.object({
    selector: z.string().min(1),
    value: z.string(),
    type: z.enum(['text', 'select', 'checkbox']).default('text')
  }))
});

/** 获取页面内容工具输入 Schema */
export const GetPageContentSchema = z.object({
  type: z.enum(['html', 'text']).default('html'),
  selector: z.string().optional()
});

/** PDF 导出工具输入 Schema */
export const PdfExportSchema = z.object({
  path: z.string().min(1, 'path 不能为空'),
  fullPage: z.boolean().default(true)
});

/** 获取 Cookie 工具输入 Schema */
export const GetCookiesSchema = z.object({
  name: z.string().optional()
});

/** 设置 Cookie 工具输入 Schema */
export const SetCookiesSchema = z.object({
  cookies: z.array(z.object({
    name: z.string(),
    value: z.string(),
    domain: z.string().optional(),
    path: z.string().optional(),
    expires: z.number().optional(),
    httpOnly: z.boolean().optional(),
    secure: z.boolean().optional()
  }))
});

/** 页面报告工具输入 Schema */
export const PageReportSchema = z.object({
  includeLinks: z.boolean().default(true),
  includeForms: z.boolean().default(true),
  includeImages: z.boolean().default(true)
});

/** 设置视口大小工具输入 Schema */
export const SetViewportSchema = z.object({
  width: z.number().min(320).max(7680),
  height: z.number().min(240).max(4320)
});

/** 导出类型推断 */
export type NavigateInput = z.infer<typeof NavigateSchema>;
export type ClickInput = z.infer<typeof ClickSchema>;
export type TypeInput = z.infer<typeof TypeSchema>;
export type ScreenshotInput = z.infer<typeof ScreenshotSchema>;
export type ExecuteJsInput = z.infer<typeof ExecuteJsSchema>;
export type ScrollInput = z.infer<typeof ScrollSchema>;
export type WaitForSelectorInput = z.infer<typeof WaitForSelectorSchema>;
export type GetElementTextInput = z.infer<typeof GetElementTextSchema>;
export type GetElementAttributeInput = z.infer<typeof GetElementAttributeSchema>;
export type HoverInput = z.infer<typeof HoverSchema>;
export type SelectOptionInput = z.infer<typeof SelectOptionSchema>;
export type FillFormInput = z.infer<typeof FillFormSchema>;
export type GetPageContentInput = z.infer<typeof GetPageContentSchema>;
export type PdfExportInput = z.infer<typeof PdfExportSchema>;
export type GetCookiesInput = z.infer<typeof GetCookiesSchema>;
export type SetCookiesInput = z.infer<typeof SetCookiesSchema>;
export type PageReportInput = z.infer<typeof PageReportSchema>;
export type SetViewportInput = z.infer<typeof SetViewportSchema>;
