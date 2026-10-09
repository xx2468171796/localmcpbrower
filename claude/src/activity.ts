/**
 * 版本号与「浏览器 MCP 正在被用吗」(给本机的自动更新器看,见 baolei apps/ai-kit/browser-mcp.mjs)。
 *
 * - 版本号只认 claude/package.json 一处:发布中心的构建会把候选版本号(ANKOTTI_RELEASE_VERSION)写进打包出来的
 *   package.json,所以运行中的服务、遥测、/health 报的都是真正装着的版本,不会再出现「代码是新的、版本号还是老的」。
 * - 活动:每次工具调用开始 / 结束记一笔(两条腿 HTTP + pipe 合计)。更新器只在 inFlight = 0 且最近 N 分钟没有调用时
 *   才重启服务换版本,免得打断正在用浏览器的人。只记次数和时刻,不记参数。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** claude/package.json 里的版本号;读不出返回 '0.0.0'(不让服务因此起不来) */
export function packageVersion(file = path.resolve(fileURLToPath(import.meta.url), '../../package.json')): string {
  try {
    const v = (JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v.trim() ? v.trim() : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export interface ActivitySnapshot {
  /** 正在执行的工具调用数 */
  inFlight: number;
  /** 最近一次工具调用开始或结束的时刻(epoch ms);启动以来没调用过为 null */
  lastCallAt: number | null;
  /** 启动以来的工具调用总数 */
  calls: number;
}

export class Activity {
  private inFlight = 0;
  private lastCallAt: number | null = null;
  private calls = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** 调用开始:返回结束时要调的函数(重复调用只算一次) */
  begin(): () => void {
    this.inFlight++;
    this.calls++;
    this.lastCallAt = this.now();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastCallAt = this.now();
    };
  }

  snapshot(): ActivitySnapshot {
    return { inFlight: this.inFlight, lastCallAt: this.lastCallAt, calls: this.calls };
  }
}
