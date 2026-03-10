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

// New tool schemas
export const KeyboardPressSchema = z.object({
  key: z.string().min(1, 'key is required')
});

export const DragAndDropSchema = z.object({
  source: z.string().min(1, 'source selector is required'),
  target: z.string().min(1, 'target selector is required')
});

export const FileUploadSchema = z.object({
  selector: z.string().min(1, 'selector is required'),
  filePath: z.string().min(1, 'filePath is required')
});

export const NewTabSchema = z.object({
  url: z.string().optional()
});

export const TabIndexSchema = z.object({
  index: z.number().int().min(0)
});

export const InterceptRequestsSchema = z.object({
  urlPattern: z.string().min(1, 'urlPattern is required'),
  action: z.enum(['block', 'log', 'modify'])
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

// ============================================================
// 爬虫工具 Schema
// ============================================================

/** 提取页面所有链接 */
export const ExtractLinksSchema = z.object({
  selector: z.string().optional().describe('限定范围的 CSS 选择器，默认提取全页面链接'),
  filter: z.string().optional().describe('URL 过滤关键词，只返回包含该词的链接'),
  limit: z.number().int().positive().default(100).describe('最多返回链接数')
});

/** 提取结构化数据（列表/表格） */
export const ExtractDataSchema = z.object({
  itemSelector: z.string().min(1).describe('每条数据的容器选择器，如 .product-item, tr'),
  fields: z.array(z.object({
    name: z.string().min(1).describe('字段名'),
    selector: z.string().min(1).describe('相对于 itemSelector 的子选择器'),
    attribute: z.string().optional().describe('提取属性值，不填则提取文本'),
    type: z.enum(['text', 'html', 'attr']).default('text')
  })).describe('要提取的字段列表'),
  limit: z.number().int().positive().default(200).describe('最多提取条数')
});

/** 批量抓取多个 URL */
export const BatchFetchSchema = z.object({
  urls: z.array(z.string().url()).min(1).max(20).describe('要抓取的 URL 列表，最多 20 个'),
  waitFor: z.string().optional().describe('每个页面等待出现的选择器'),
  extractSelector: z.string().optional().describe('要提取内容的选择器，不填则返回 title+url'),
  delay: z.number().int().min(0).max(5000).default(500).describe('每次请求间隔毫秒，防止被封')
});

/** 分页爬取 */
export const CrawlPagesSchema = z.object({
  startUrl: z.string().url().describe('起始 URL'),
  nextPageSelector: z.string().describe('下一页按钮/链接的选择器'),
  itemSelector: z.string().describe('每条数据的容器选择器'),
  fields: z.array(z.object({
    name: z.string().min(1),
    selector: z.string().min(1),
    attribute: z.string().optional(),
    type: z.enum(['text', 'html', 'attr']).default('text')
  })).describe('要提取的字段'),
  maxPages: z.number().int().positive().max(50).default(5).describe('最多爬取页数'),
  delay: z.number().int().min(0).max(5000).default(800).describe('翻页间隔毫秒')
});

/** 等待并提取（适合动态加载内容） */
export const WaitAndExtractSchema = z.object({
  waitSelector: z.string().min(1).describe('等待出现的选择器（动态内容加载完成标志）'),
  extractSelector: z.string().min(1).describe('要提取内容的选择器'),
  attribute: z.string().optional().describe('提取属性，不填则提取文本'),
  timeout: z.number().int().positive().default(10000).describe('等待超时毫秒')
});

/** 设置请求拦截（屏蔽图片/广告加速加载） */
export const SetBlockRulesSchema = z.object({
  blockImages: z.boolean().default(true).describe('屏蔽图片请求（加速加载）'),
  blockMedia: z.boolean().default(true).describe('屏蔽视频/音频请求'),
  blockFonts: z.boolean().default(false).describe('屏蔽字体请求'),
  blockAds: z.boolean().default(true).describe('屏蔽广告域名'),
  customPatterns: z.array(z.string()).default([]).describe('自定义屏蔽 URL 模式')
});

export type ExtractLinksInput = z.infer<typeof ExtractLinksSchema>;
export type ExtractDataInput = z.infer<typeof ExtractDataSchema>;
export type BatchFetchInput = z.infer<typeof BatchFetchSchema>;
export type CrawlPagesInput = z.infer<typeof CrawlPagesSchema>;
export type WaitAndExtractInput = z.infer<typeof WaitAndExtractSchema>;
export type SetBlockRulesInput = z.infer<typeof SetBlockRulesSchema>;
