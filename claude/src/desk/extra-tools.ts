/**
 * 3.0 新增工具的注册(server.ts 的 createMcpServer 末尾调一次):
 * cdp_send、fill_secret / login_with_asset、run_flow、录制三件套、扩展的标签页 / 下载 / 网络规则。
 * 工具实现在 control/ 和 secrets/;这里只管描述(写给 AI 看:什么时候用)和接线。
 */

import type { McpServer, ToolAnnotations } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CdpSendSchema, cdpSend } from '../control/cdp.js';
import { RunFlowSchema, runFlow, type FlowHooks } from '../control/flow.js';
import { ExtBlockSchema, ExtDownloadsSchema, extBlockRules, extDownloads, extTabs, recordStart, recordStatus, recordStop } from '../control/extension.js';
import { FillSecretSchema, LoginWithAssetSchema, fillSecret, loginWithAsset } from '../secrets/fill-secret.js';
import type { ToolResult } from '../types.js';
import { errorOf, preflight, trackCall, withCode, type RawResult } from './instrument.js';

type McpOut = { content?: Array<{ type: string; text?: string }>; _meta?: Record<string, unknown>; isError?: boolean };
type RawHandler = (...a: unknown[]) => Promise<McpOut>;
type Wrap = <T extends (...args: never[]) => unknown>(fn: T) => T;
/** 必须是字面量 'text':写成 string 时 SDK 的 registerTool 重载全部匹配失败,报错却指向 inputSchema(AGENTS.md 第 5 条) */
type Text = (result: unknown) => { content: Array<{ type: 'text'; text: string }> };

const NO_ARGS = z.object({});

function ann(title: string, readOnly: boolean, openWorld = false, destructive = false): ToolAnnotations {
  return { title, readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: readOnly, openWorldHint: openWorld };
}

/** 从原始 handler 的输出里取回 { success, data, error, code } */
function unwrap(out: McpOut): ToolResult<unknown> {
  const t = out.content?.find((c) => c.type === 'text')?.text ?? '';
  try {
    const p = JSON.parse(t) as RawResult;
    if (typeof p.success === 'boolean') return withCode(p) as ToolResult<unknown>;
  } catch { /* 下面按失败处理 */ }
  return { success: false, error: t.slice(0, 500) || '工具没有返回结果', code: 'INTERNAL' };
}

export function registerExtraTools(server: McpServer, wrap: Wrap, text: Text, registry: ReadonlyMap<string, RawHandler>, sessionId: string): void {
  server.registerTool('cdp_send', {
    title: '发 CDP 命令',
    description: '直接向当前标签页发 Chrome DevTools Protocol 命令(method 如 Emulation.setGeolocationOverride、Network.emulateNetworkConditions、Performance.getMetrics、DOM.getDocument),拿到 CDP 原始返回。现有工具做不到的浏览器能力用它;常规点击 / 输入 / 读页面仍用对应工具。只开放页面级的域;读写本机文件、打开 file://、改下载目录、浏览器级(Browser.* / Target.* 等)的命令默认不开放,会返回 UNSUPPORTED,别想办法绕。',
    inputSchema: CdpSendSchema,
    annotations: ann('发 CDP 命令', false, true),
  }, wrap(async (args: unknown) => text(await cdpSend(args))));

  server.registerTool('fill_secret', {
    title: '用堡垒机资产填写',
    description: '把堡垒机资产里的密码 / 账号 / 两步验证码 / 自定义字段直接填进输入框,明文不经过你。登录公司系统时用它,不要自己 get_asset 拿明文再 type。只有当前页面站点和资产登记的地址对得上才会填(防止填到别的网站)。资产名或 id 用堡垒机 list_assets 查。',
    inputSchema: FillSecretSchema,
    annotations: ann('用堡垒机资产填写', false),
  }, wrap(async (args: unknown) => text(await fillSecret(args))));

  server.registerTool('login_with_asset', {
    title: '用堡垒机资产登录',
    description: '一次填好账号、密码(和两步验证码)并提交:给出各输入框的 ref / selector 和资产 id 或名称,submit 给按钮或 \'enter\'。明文不经过你,站点必须和资产登记的地址对得上。',
    inputSchema: LoginWithAssetSchema,
    annotations: ann('用堡垒机资产登录', false, true),
  }, wrap(async (args: unknown) => text(await loginWithAsset(args))));

  server.registerTool('run_flow', {
    title: '跑一段流程',
    description: '把多个工具调用写成步骤一次跑完(steps: [{tool, args, as?, retry?, continueOnError?}]),跨页面跳转也不断,比一步一调快得多。后面的步骤可以用 "{{名字.路径}}" 引用前面 as 存下的结果。失败时返回已完成的步骤,方便从断点续跑。record_stop 录出来的流程直接交给它回放。',
    inputSchema: RunFlowSchema,
    annotations: ann('跑一段流程', false, true),
  }, wrap(async (args: unknown, ctx: unknown) => {
    const signal = (ctx as { mcpReq?: { signal?: AbortSignal } } | undefined)?.mcpReq?.signal;
    const tools = new Map<string, (input: unknown) => Promise<ToolResult<unknown>>>();
    for (const [name, handler] of registry) {
      tools.set(name, async (input) => {
        const done = trackCall({ tool: name, session: sessionId, args: input });
        const t0 = performance.now();
        let r: ToolResult<unknown>;
        try { r = unwrap(await handler(input, ctx)); } catch (e) { r = errorOf(e) as ToolResult<unknown>; }
        done(r as RawResult, performance.now() - t0);
        return r;
      });
    }
    const hooks: FlowHooks = { tools, beforeStep: (step) => preflight({ tool: step.tool, session: sessionId, args: step.args, signal }) };
    return text(await runFlow(args, hooks));
  }));

  server.registerTool('record_start', {
    title: '开始录制操作',
    description: '开始录制人在浏览器里的操作(点击、输入、下拉选择、回车、地址栏跳转)。人在远程画面或弹出的窗口里演示一遍,再调 record_stop 拿到可回放的流程。需要有窗口的浏览器(自带扩展);无头时会提示。',
    inputSchema: NO_ARGS,
    annotations: ann('开始录制操作', false),
  }, wrap(async () => text(await recordStart())));

  server.registerTool('record_stop', {
    title: '停止录制',
    description: '停止录制,返回转好的 run_flow 步骤。密码框不记内容,会变成 fill_secret 步骤,回放前把 asset 改成对应的堡垒机资产。',
    inputSchema: NO_ARGS,
    annotations: ann('停止录制', false),
  }, wrap(async () => text(await recordStop())));

  server.registerTool('record_status', {
    title: '录制状态',
    description: '看是否正在录制、已录了几步。',
    inputSchema: NO_ARGS,
    annotations: ann('录制状态', true),
  }, wrap(async () => text(await recordStatus())));

  server.registerTool('browser_tabs', {
    title: '全部标签页',
    description: '列出整个浏览器所有窗口里的标签页(含人手动开的、不属于本会话的),给接管 / 排查用。只看本会话的标签页用 list_tabs。需要自带扩展。',
    inputSchema: NO_ARGS,
    annotations: ann('全部标签页', true),
  }, wrap(async () => text(await extTabs())));

  server.registerTool('browser_downloads', {
    title: '下载记录',
    description: '列出浏览器最近的下载(文件名、状态、大小、出错原因),确认文件是否下好。需要自带扩展。',
    inputSchema: ExtDownloadsSchema,
    annotations: ann('下载记录', true),
  }, wrap(async (args: unknown) => text(await extDownloads(args))));

  server.registerTool('browser_block_rules', {
    title: '浏览器内拦截规则',
    description: '在浏览器内部按规则拦请求(urlFilter 规则 + 整类资源如 image / media / font),不经过本服务逐个判断,大批量爬取时比 set_block_rules 更快;传空数组清除。需要自带扩展。',
    inputSchema: ExtBlockSchema,
    annotations: ann('浏览器内拦截规则', false),
  }, wrap(async (args: unknown) => text(await extBlockRules(args))));
}
