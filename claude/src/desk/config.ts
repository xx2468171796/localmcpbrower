/**
 * 托管模式(AI 浏览器工位)的环境变量:启动时一次性读、用 Zod 校验,之后全程只读。
 *
 * 设了 DESK_ID 即「托管模式」:同一台机器上可能并排跑好几个实例(一个 AI 一个工位),
 * 登录态 / 数据目录 / 截图目录必须各自独立 —— 所以这三项托管模式下**必填**,缺了直接拒绝启动,
 * 不许悄悄落回安装目录推断出来的共享位置(那会让几个工位共用一份登录态、互相清对方的截图)。
 *
 * 不设 DESK_ID(本机单用,今天的用法)时各项取默认值,行为与 2.4.0 一致。
 * 设计见 docs/architecture.md 4.2。
 */
import { z } from 'zod';

type Env = Record<string, string | undefined>;

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

/** 开关类变量:没设(或空串)取默认;认不出的值当配置错误,不猜 */
const flag = (name: string, def: boolean) => z.string().optional().transform((v, ctx) => {
  const s = (v ?? '').trim().toLowerCase();
  if (!s) return def;
  if (TRUE.has(s)) return true;
  if (FALSE.has(s)) return false;
  ctx.addIssue({ code: 'custom', message: `${name}=${v} 看不懂,只认 1/0、true/false、on/off、yes/no` });
  return z.NEVER;
});

/** 整数类变量:没设取默认;0 有意义的由调用方决定(期限类 0 = 不限) */
const int = (name: string, def: number | null, min: number, max: number) => z.string().optional().transform((v, ctx) => {
  const s = (v ?? '').trim();
  if (!s) return def;
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) {
    ctx.addIssue({ code: 'custom', message: `${name}=${v} 不合法,应为 ${min}–${max} 的整数` });
    return z.NEVER;
  }
  return n;
});

const text = () => z.string().optional().transform((v) => {
  const s = (v ?? '').trim();
  return s ? s : null;
});

const EnvSchema = z.object({
  DESK_ID: text().refine((v) => v === null || /^[A-Za-z0-9_-]{1,40}$/.test(v), {
    message: 'DESK_ID 只允许字母 / 数字 / 下划线 / 连字符,长度 1–40(它会进管道名和遥测标签)',
  }),
  KILL_PORT_ON_START: flag('KILL_PORT_ON_START', true),
  PIPE_DISABLE: flag('PIPE_DISABLE', false),
  USER_DATA_DIR: text(),
  LOCALMCP_DATA_DIR: text(),
  SCREENSHOT_DIR: text(),
  ADMIN_TOKEN: text(),
  DEVTOOLS_PORT: int('DEVTOOLS_PORT', null, 1, 65535),
  TOOL_DEADLINE_MS: int('TOOL_DEADLINE_MS', 120_000, 0, 24 * 3600_000),
  PAUSE_WAIT_MAX_MS: int('PAUSE_WAIT_MAX_MS', 600_000, 0, 24 * 3600_000),
  ALLOW_BROWSER_CDP: flag('ALLOW_BROWSER_CDP', false),
});

export interface DeskConfig {
  /** 工位 id;null = 本机单用 */
  deskId: string | null;
  /** 托管模式(设了 DESK_ID) */
  managed: boolean;
  /** 启动时清掉占着本端口的进程(本机默认开;托管工位应设 0,免得杀掉邻居) */
  killPortOnStart: boolean;
  /** 不起 pipe 腿(托管工位只走 HTTP) */
  pipeDisable: boolean;
  /** 原样给出(托管模式下保证非空);本机单用时为 null,由 paths.ts 推断 */
  userDataDir: string | null;
  dataDir: string | null;
  screenshotDir: string | null;
  /** /admin/* 的管理令牌;null = 只许本机回环访问 */
  adminToken: string | null;
  /** 浏览器远程调试端口;null = 不显式开(DEVTOOLS=true 时仍用 9222) */
  devtoolsPort: number | null;
  /** 单次工具调用总期限;0 = 不限 */
  toolDeadlineMs: number;
  /** 暂停中的调用最多等多久;0 = 不等,立即返回 DESK_PAUSED */
  pauseWaitMaxMs: number;
  /** cdp_send 允许 target=browser(能关浏览器、改下载目录,默认关) */
  allowBrowserCdp: boolean;
}

/** 解析并校验;不合法抛错,消息是给人看的中文(一次列全所有问题) */
export function parseDeskConfig(env: Env): DeskConfig {
  const r = EnvSchema.safeParse({
    DESK_ID: env['DESK_ID'],
    KILL_PORT_ON_START: env['KILL_PORT_ON_START'],
    PIPE_DISABLE: env['PIPE_DISABLE'],
    USER_DATA_DIR: env['USER_DATA_DIR'],
    LOCALMCP_DATA_DIR: env['LOCALMCP_DATA_DIR'],
    SCREENSHOT_DIR: env['SCREENSHOT_DIR'],
    ADMIN_TOKEN: env['ADMIN_TOKEN'],
    DEVTOOLS_PORT: env['DEVTOOLS_PORT'],
    TOOL_DEADLINE_MS: env['TOOL_DEADLINE_MS'],
    PAUSE_WAIT_MAX_MS: env['PAUSE_WAIT_MAX_MS'],
    ALLOW_BROWSER_CDP: env['ALLOW_BROWSER_CDP'],
  });
  if (!r.success) {
    throw new Error(`[Desk] 环境变量配置有误,拒绝启动:\n  - ${r.error.issues.map((i) => i.message).join('\n  - ')}`);
  }
  const e = r.data;
  const cfg: DeskConfig = {
    deskId: e.DESK_ID,
    managed: e.DESK_ID !== null,
    killPortOnStart: e.KILL_PORT_ON_START,
    pipeDisable: e.PIPE_DISABLE,
    userDataDir: e.USER_DATA_DIR,
    dataDir: e.LOCALMCP_DATA_DIR,
    screenshotDir: e.SCREENSHOT_DIR,
    adminToken: e.ADMIN_TOKEN,
    devtoolsPort: e.DEVTOOLS_PORT,
    toolDeadlineMs: e.TOOL_DEADLINE_MS ?? 120_000,
    pauseWaitMaxMs: e.PAUSE_WAIT_MAX_MS ?? 600_000,
    allowBrowserCdp: e.ALLOW_BROWSER_CDP,
  };
  if (cfg.managed) {
    const missing = [
      cfg.userDataDir ? null : 'USER_DATA_DIR(登录态 profile 目录)',
      cfg.dataDir ? null : 'LOCALMCP_DATA_DIR(数据 / 临时文件目录)',
      cfg.screenshotDir ? null : 'SCREENSHOT_DIR(截图目录)',
      // 工位常在反向代理后面,那时所有请求都像来自本机回环,「没令牌只许本机」挡不住人
      cfg.adminToken ? null : 'ADMIN_TOKEN(管理接口令牌)',
    ].filter((m): m is string => m !== null);
    if (missing.length) {
      throw new Error(
        `[Desk] 托管模式(DESK_ID=${cfg.deskId})必须给每个工位单独指定目录,缺:${missing.join('、')}。`
        + '不指定就会落到安装目录推断的共享位置,几个工位会共用登录态、互相清对方的截图。');
    }
  }
  return cfg;
}

/** 本进程的托管配置(模块加载时读一次;配置错误在这里直接抛出,服务起不来并说明原因) */
export const deskConfig: Readonly<DeskConfig> = Object.freeze(parseDeskConfig(process.env));
