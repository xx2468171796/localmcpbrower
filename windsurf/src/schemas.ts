/**
 * Zod 验证 Schema
 */

import { z } from 'zod';

export const NavigateSchema = z.object({
  url: z.string().url('必须是有效的 URL')
});

export const ClickSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空')
});

export const TypeSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空'),
  text: z.string()
});

export const ScreenshotSchema = z.object({
  name: z.string().optional(),
  fullPage: z.boolean().default(false)
});

export const ExecuteJsSchema = z.object({
  script: z.string().min(1, 'script 不能为空')
});

export const ScrollSchema = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  selector: z.string().optional()
});

export const WaitForSelectorSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空'),
  state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible'),
  timeout: z.number().default(30000)
});

export const GetElementTextSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空')
});

export const GetElementAttributeSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空'),
  attribute: z.string().min(1, 'attribute 不能为空')
});

export const HoverSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空')
});

export const SelectOptionSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空'),
  value: z.string().optional(),
  label: z.string().optional()
});

export const FillFormSchema = z.object({
  fields: z.array(z.object({
    selector: z.string().min(1),
    value: z.string(),
    type: z.enum(['text', 'select', 'checkbox']).default('text')
  }))
});

export const GetPageContentSchema = z.object({
  type: z.enum(['html', 'text']).default('html'),
  selector: z.string().optional()
});

export const PdfExportSchema = z.object({
  path: z.string().min(1, 'path 不能为空'),
  fullPage: z.boolean().default(true)
});

export const GetCookiesSchema = z.object({
  name: z.string().optional()
});

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

export const PageReportSchema = z.object({
  includeLinks: z.boolean().default(true),
  includeForms: z.boolean().default(true),
  includeImages: z.boolean().default(true)
});

export const SetViewportSchema = z.object({
  width: z.number().min(320).max(7680),
  height: z.number().min(240).max(4320)
});

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
