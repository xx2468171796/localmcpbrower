/**
 * Xvfb 单元的 ExecStartPost:虚拟屏起来后切到工位配置的分辨率。
 *   node dist/desk/display-cli.js
 * 用哪个:工位数据目录里记住的(面板 / deskctl resolution 改过)> 环境变量 DESK_RESOLUTION > 1920x1080。
 * X 还没就绪时最多等 10 秒。退出码非零只表示没切成(屏幕停在 Xvfb 启动时的 3840x2160),单元用 "-" 前缀不受影响。
 *
 * 只依赖 display.ts(不碰 config.ts:这个单元里没有令牌,config.ts 在托管模式下会拒绝加载)。
 */
import path from 'node:path';
import { DeskDisplay, execBin, formatResolution, pickStartupResolution } from './display.js';

async function waitForX(display: DeskDisplay): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try { await display.current(); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('等了 10 秒 X 还没就绪');
}

async function main(): Promise<void> {
  const dataDir = process.env['LOCALMCP_DATA_DIR'];
  const display = new DeskDisplay({
    exec: execBin,
    stateFile: dataDir ? path.join(dataDir, 'display-resolution') : null,
    wallpaper: null, // 壁纸单元在后面启动,自己会铺
  });
  await waitForX(display);
  const want = pickStartupResolution(await display.readSaved(), process.env['DESK_RESOLUTION']);
  const now = await display.apply(want);
  console.log(`[desk-display] ${process.env['DISPLAY'] ?? ''} → ${formatResolution(now)}`);
}

main().catch((e: unknown) => {
  console.error(`[desk-display] 切分辨率失败:${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
