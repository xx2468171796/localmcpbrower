/**
 * Zod 验证 Schema
 */

import { z } from 'zod';

export const NavigateSchema = z.object({
  url: z.string().url('必须是有效的 URL')
    // 只认 http(s)。原来只校验 URL **语法**,于是 file:///C:/Windows/win.ini 能被打开
    // (实测 success:true)—— 描述写着"必须以 http(s):// 开头",schema 却没落实。
    // 这个服务只绑回环,风险不高,但描述与实现不一致本身就是坑。
    .refine((u) => /^https?:\/\//i.test(u), { message: '只允许 http:// 或 https://' })
    .describe('要打开的目标网址，必须以 http(s):// 开头')
});

export const ClickSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空').optional().describe('要点击元素的 CSS 选择器，与 ref 二选一（必须提供其一）'),
  ref: z.string().min(1).optional().describe('snapshot 工具返回的元素 ref 编号（如 e5），与 selector 二选一')
});

export const TypeSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空').optional().describe('目标输入框的 CSS 选择器，与 ref 二选一（必须提供其一）'),
  ref: z.string().min(1).optional().describe('snapshot 工具返回的元素 ref 编号（如 e5），与 selector 二选一'),
  text: z.string().describe('要输入的文本内容')
});

export const ScreenshotSchema = z.object({
  name: z.string().optional().describe('截图文件名（不含扩展名），不填则自动生成'),
  fullPage: z.boolean().default(false).describe('是否截取整页（含滚动区域），默认仅当前视口'),
  format: z.enum(['jpeg', 'png']).default('jpeg').describe('图片格式，jpeg 编码更快（默认），png 无损但更慢'),
  quality: z.number().min(1).max(100).default(80).describe('JPEG 压缩质量 1-100（仅 jpeg 格式生效），默认 80')
});

export const ExecuteJsSchema = z.object({
  script: z.string().min(1, 'script 不能为空').describe('要在页面上下文执行的 JavaScript 代码，返回值会被序列化返回')
});

/** run_script：一次跑完，脚本内可用 __ego.* 助手 */
export const RunScriptSchema = z.object({
  script: z.string().min(1, 'script 不能为空').describe('要在页面上下文一次性执行的 JS。可用 __ego 助手：__ego.snapshot()/click(selOrRef)/fill(selOrRef,val)/waitFor(sel,ms)/text(sel)/attr(sel,name)/exists(sel)/sleep(ms)/$(sel)/$$(sel)。支持顶层 await 与 return，返回值序列化回传。')
});

/** Task Space 名称参数 */
export const SpaceNameSchema = z.object({
  name: z.string().min(1, 'name 不能为空').describe('space 名称，仅字母/数字/下划线/连字符，长度 1-40')
});

export const ScrollSchema = z.object({
  x: z.number().optional().describe('水平滚动到的像素位置'),
  y: z.number().optional().describe('垂直滚动到的像素位置'),
  selector: z.string().optional().describe('滚动到该元素可见处的 CSS 选择器，与 x/y 二选一')
});

export const WaitForSelectorSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空').describe('要等待的元素 CSS 选择器'),
  state: z.enum(['visible', 'hidden', 'attached', 'detached']).default('visible').describe('等待元素达到的状态：可见/隐藏/已挂载/已移除'),
  timeout: z.number().default(30000).describe('等待超时毫秒数')
});

export const GetElementTextSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空').describe('目标元素的 CSS 选择器')
});

export const GetElementAttributeSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空').describe('目标元素的 CSS 选择器'),
  attribute: z.string().min(1, 'attribute 不能为空').describe('要读取的属性名，如 href、src、data-id')
});

export const HoverSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空').optional().describe('要悬停的元素 CSS 选择器，与 ref 二选一（必须提供其一）'),
  ref: z.string().min(1).optional().describe('snapshot 工具返回的元素 ref 编号（如 e5），与 selector 二选一')
});

export const SnapshotSchema = z.object({
  interactiveOnly: z.boolean().default(false).describe('仅输出可交互元素（链接/按钮/输入框等），默认 false 包含标题与可见文本'),
  maxChars: z.number().int().positive().optional().describe('输出字符上限，超出会被截断并标注，默认约 12000'),
  deep: z.boolean().default(false).describe('深度扫描，用 CDP 事件监听找出仅通过 addEventListener 绑定 click 的元素，较慢，默认关闭')
});

/** 站点 URL 发现 */
export const DiscoverUrlsSchema = z.object({
  url: z.url().describe('站点根/入口 URL，会从此页面及其 sitemap/robots.txt 发现地址'),
  maxUrls: z.number().int().positive().default(300).describe('最多返回的 URL 数量，默认 300'),
  sameDomainOnly: z.boolean().default(true).describe('仅保留与入口 URL 同域名的地址，默认 true'),
  includeSitemap: z.boolean().default(true).describe('是否解析 robots.txt 与 sitemap.xml 发现更多地址，默认 true')
});

export const ExtractArticleSchema = z.object({
  url: z.url().optional().describe('可选，提供则先跳转到该网址再提取，不填则提取当前页面')
});

export const SelectOptionSchema = z.object({
  selector: z.string().min(1, 'selector 不能为空').describe('下拉框 select 元素的 CSS 选择器'),
  value: z.string().optional().describe('要选中选项的 value 值'),
  label: z.string().optional().describe('要选中选项的可见文本，与 value 二选一')
});

export const FillFormSchema = z.object({
  fields: z.array(z.object({
    selector: z.string().min(1).describe('表单字段的 CSS 选择器'),
    value: z.string().describe('要填入的值'),
    type: z.enum(['text', 'select', 'checkbox']).default('text').describe('字段类型：文本框/下拉框/复选框')
  })).describe('要批量填写的表单字段列表')
});

export const GetPageContentSchema = z.object({
  type: z.enum(['html', 'text']).default('html').describe('返回格式：html 原始结构或 text 纯文本'),
  selector: z.string().optional().describe('限定范围的 CSS 选择器，不填则返回整页')
});

export const PdfExportSchema = z.object({
  path: z.string().min(1, 'path 不能为空').describe('PDF 输出文件的保存路径'),
  fullPage: z.boolean().default(true).describe('是否导出整页内容')
});

export const GetCookiesSchema = z.object({
  name: z.string().optional().describe('指定 Cookie 名称，不填则返回全部 Cookie')
});

export const SetCookiesSchema = z.object({
  cookies: z.array(z.object({
    name: z.string().describe('Cookie 名称'),
    value: z.string().describe('Cookie 值'),
    domain: z.string().optional().describe('Cookie 所属域名'),
    path: z.string().optional().describe('Cookie 生效路径'),
    expires: z.number().optional().describe('过期时间戳（秒）'),
    httpOnly: z.boolean().optional().describe('是否仅 HTTP 可访问'),
    secure: z.boolean().optional().describe('是否仅 HTTPS 传输')
  })).describe('要写入的 Cookie 列表')
});

export const PageReportSchema = z.object({
  includeLinks: z.boolean().default(true).describe('报告中是否包含链接清单'),
  includeForms: z.boolean().default(true).describe('报告中是否包含表单结构'),
  includeImages: z.boolean().default(true).describe('报告中是否包含图片清单')
});

export const SetViewportSchema = z.object({
  width: z.number().min(320).max(7680).describe('视口宽度像素（320-7680）'),
  height: z.number().min(240).max(4320).describe('视口高度像素（240-4320）')
});

// New tool schemas
export const KeyboardPressSchema = z.object({
  key: z.string().min(1, 'key is required').describe('要按下的键名，如 Enter、Tab、Escape、ArrowDown')
});

export const DragAndDropSchema = z.object({
  source: z.string().min(1, 'source selector is required').describe('被拖拽元素的 CSS 选择器'),
  target: z.string().min(1, 'target selector is required').describe('放置目标元素的 CSS 选择器')
});

export const FileUploadSchema = z.object({
  selector: z.string().min(1, 'selector is required').describe('input[type=file] 元素的 CSS 选择器'),
  filePath: z.string().min(1, 'filePath is required').describe('要上传文件的本地绝对路径')
});

export const NewTabSchema = z.object({
  url: z.string().optional().describe('新标签页打开的网址，不填则打开空白页')
});

export const TabIndexSchema = z.object({
  index: z.number().int().min(0).describe('标签页索引，从 0 开始')
});

export const InterceptRequestsSchema = z.object({
  urlPattern: z.string().min(1, 'urlPattern is required').describe('要匹配的 URL 模式（支持通配符）'),
  action: z.enum(['block', 'log', 'modify']).describe('匹配后的动作：拦截/记录/修改')
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
export type SnapshotInput = z.infer<typeof SnapshotSchema>;
export type ExtractArticleInput = z.infer<typeof ExtractArticleSchema>;
export type DiscoverUrlsInput = z.infer<typeof DiscoverUrlsSchema>;

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
    type: z.enum(['text', 'html', 'attr']).default('text').describe('提取方式：text 文本 / html 内部HTML / attr 属性')
  })).describe('要提取的字段列表'),
  limit: z.number().int().positive().default(200).describe('最多提取条数')
});

/** 批量抓取多个 URL */
export const BatchFetchSchema = z.object({
  // 与 NavigateSchema 同理:z.url() 只校验语法,不限 scheme
  urls: z.array(z.url().refine((u) => /^https?:\/\//i.test(u), { message: '只允许 http:// 或 https://' }))
    .min(1).max(20).describe('要抓取的 URL 列表，最多 20 个'),
  waitFor: z.string().optional().describe('每个页面等待出现的选择器'),
  extractSelector: z.string().optional().describe('要提取内容的选择器，不填则返回 title+url'),
  delay: z.number().int().min(0).max(5000).default(500).describe('每次请求间隔毫秒，防止被封')
});

/** 分页爬取 */
export const CrawlPagesSchema = z.object({
  startUrl: z.url().describe('起始 URL'),
  nextPageSelector: z.string().describe('下一页按钮/链接的选择器'),
  itemSelector: z.string().describe('每条数据的容器选择器'),
  fields: z.array(z.object({
    name: z.string().min(1).describe('字段名'),
    selector: z.string().min(1).describe('相对于 itemSelector 的子选择器'),
    attribute: z.string().optional().describe('提取属性值，不填则提取文本'),
    type: z.enum(['text', 'html', 'attr']).default('text').describe('提取方式：text 文本 / html 内部HTML / attr 属性')
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

/** wait_for_human:等人工在可见窗口里处理完(登录/验证码),靠盯页面变化判定 */
export const WaitForHumanSchema = z.object({
  appears: z.string().min(1).optional().describe('等这个 CSS 选择器出现'),
  disappears: z.string().min(1).optional().describe('等这个 CSS 选择器消失'),
  urlChanges: z.boolean().default(false).describe('等网址发生变化'),
  timeoutSec: z.number().int().min(5).max(1800).default(180).describe('最长等待秒数'),
}).refine((v) => !!(v.appears || v.disappears || v.urlChanges),
  { message: 'appears / disappears / urlChanges 至少要给一个' });
