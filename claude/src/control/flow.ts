/**
 * run_flow:把多个工具调用写成一个流程,一次调用跑完(第三期「多步合一」)。
 *
 * 和 run_script 的区别:run_script 在**一个页面里**跑 JS,页面一跳转脚本就断;
 * run_flow 在服务端按步骤调现有工具,跨导航、跨标签页都行,每步复用工具自己的等待、iframe 穿透和错误码。
 * 也是以后「操作录制 → 回放」和编排(n8n 节点)的执行器:流程是纯数据,存下来就能不经 AI 重放。
 *
 * 步骤之间可以引用前面步骤的结果:args 里的 "{{名字.路径}}" 换成 as 存下的数据,
 * 整个字符串就是一个引用时保留原类型(数组 / 对象),嵌在文字里时转成字符串。
 */

import { z } from 'zod';
import { ToolError, fail, type ErrorCode } from '../errors.js';
import type { ToolResult } from '../types.js';

const StepSchema = z.object({
  tool: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()).optional(),
  as: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(40).optional().describe('把这一步的 data 存成变量,后面用 {{名字.路径}} 引用'),
  retry: z.number().int().min(0).max(3).default(0),
  continueOnError: z.boolean().default(false),
});

export const RunFlowSchema = z.object({
  steps: z.array(StepSchema).min(1).max(100),
  timeoutMs: z.number().int().min(1000).max(900_000).default(300_000),
});

export type FlowStep = z.infer<typeof StepSchema>;
type AnyTool = (input: unknown) => Promise<ToolResult<unknown>>;

export interface FlowHooks {
  /** 可调用的工具(名字 → 实现);不在表里的步骤直接判错 */
  tools: ReadonlyMap<string, AnyTool>;
  /** 每步执行前(过闸门、查取消);抛错即中止流程 */
  beforeStep?: (step: FlowStep, index: number) => Promise<void>;
  /** 每步结束后(记事件) */
  afterStep?: (step: FlowStep, index: number, result: ToolResult<unknown>, ms: number) => void;
}

export interface FlowStepOutcome {
  index: number;
  tool: string;
  ok: boolean;
  ms: number;
  attempts: number;
  data?: unknown;
  error?: string;
  code?: ErrorCode;
}

/** 流程里不许嵌套的工具:防递归,也防把整个流程卡在等人上 */
const FORBIDDEN_IN_FLOW = new Set(['run_flow']);

export async function runFlow(input: unknown, hooks: FlowHooks): Promise<ToolResult<{ completed: number; total: number; steps: FlowStepOutcome[]; vars: Record<string, unknown> }>> {
  const parsed = RunFlowSchema.safeParse(input);
  if (!parsed.success) return fail('INVALID_ARGS', `参数验证失败: ${parsed.error.message}`);
  const { steps, timeoutMs } = parsed.data;
  for (const [i, s] of steps.entries()) {
    if (FORBIDDEN_IN_FLOW.has(s.tool)) return fail('INVALID_ARGS', `第 ${i + 1} 步:流程里不能再调 ${s.tool}`);
    if (!hooks.tools.has(s.tool)) return fail('INVALID_ARGS', `第 ${i + 1} 步:没有工具 ${s.tool}`);
  }
  const deadline = Date.now() + timeoutMs;
  const vars: Record<string, unknown> = {};
  const outcomes: FlowStepOutcome[] = [];
  for (const [index, step] of steps.entries()) {
    if (Date.now() > deadline) return flowFailed(outcomes, steps.length, vars, 'TIMEOUT', `流程超过 ${timeoutMs}ms,停在第 ${index + 1} 步之前`);
    try {
      await hooks.beforeStep?.(step, index);
    } catch (e) {
      const code = e instanceof ToolError ? e.code : 'INTERNAL';
      return flowFailed(outcomes, steps.length, vars, code, `第 ${index + 1} 步(${step.tool})没能开始:${e instanceof Error ? e.message : String(e)}`);
    }
    const outcome = await runStep(step, index, vars, hooks);
    outcomes.push(outcome);
    if (outcome.ok && step.as) vars[step.as] = outcome.data;
    if (!outcome.ok && !step.continueOnError) {
      return flowFailed(outcomes, steps.length, vars, outcome.code ?? 'INTERNAL', `第 ${index + 1} 步(${step.tool})失败:${outcome.error ?? ''}`);
    }
  }
  return { success: true, data: { completed: outcomes.filter((o) => o.ok).length, total: steps.length, steps: outcomes, vars } };
}

async function runStep(step: FlowStep, index: number, vars: Record<string, unknown>, hooks: FlowHooks): Promise<FlowStepOutcome> {
  const tool = hooks.tools.get(step.tool) as AnyTool;
  const args = substitute(step.args ?? {}, vars);
  const t0 = Date.now();
  let last: ToolResult<unknown> = { success: false, error: '未执行' };
  let attempts = 0;
  while (attempts <= step.retry) {
    attempts++;
    const s0 = Date.now();
    try {
      last = await tool(args);
    } catch (e) {
      last = { success: false, error: e instanceof Error ? e.message : String(e), code: e instanceof ToolError ? e.code : 'INTERNAL' };
    }
    hooks.afterStep?.(step, index, last, Date.now() - s0);
    if (last.success || (last.code && NO_RETRY.has(last.code))) break;
  }
  const ms = Date.now() - t0;
  return last.success
    ? { index, tool: step.tool, ok: true, ms, attempts, data: last.data }
    : { index, tool: step.tool, ok: false, ms, attempts, error: last.error, code: last.code };
}

/** 参数错、被接管、被白名单 / 路径 / 防外泄拦下、被取消:重试也没用,直接停 */
const NO_RETRY: ReadonlySet<ErrorCode> = new Set(['INVALID_ARGS', 'DESK_PAUSED', 'DOMAIN_BLOCKED', 'PATH_DENIED', 'SECRET_ORIGIN_MISMATCH', 'CANCELLED']);

function flowFailed(steps: FlowStepOutcome[], total: number, vars: Record<string, unknown>, code: ErrorCode, error: string) {
  // 失败时也把已完成的步骤带回去,编排方据此决定从哪一步续跑
  return { success: false as const, error, code, data: { completed: steps.filter((s) => s.ok).length, total, steps, vars } };
}

const REF = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;

/** 把 args 里的 {{变量.路径}} 换成前面步骤存下的值 */
export function substitute(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const whole = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)\s*\}\}$/.exec(value);
    if (whole) return lookup(vars, whole[1] ?? '', whole[2] ?? '');
    return value.replace(REF, (_m, name: string, p: string) => {
      const v = lookup(vars, name, p);
      return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v, vars)]));
  }
  return value;
}

function lookup(vars: Record<string, unknown>, name: string, dotted: string): unknown {
  let cur: unknown = vars[name];
  for (const key of dotted.split('.').filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
