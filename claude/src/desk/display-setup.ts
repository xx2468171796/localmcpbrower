/**
 * 组装 /admin/display 用的 DisplayControl(server.ts 只调这一个函数)。
 * 只有托管工位(DESK_ID)+ Linux + 有 DISPLAY 时才有;否则返回 undefined,/admin/display 回 404。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { BrowserContext } from 'patchright';
import { DeskDisplay, execBin } from './display.js';
import { DisplayControl, type DisplayPort } from './display-control.js';
import type { ToolEventInput } from './events.js';
import { maximizeAllWindows } from './window-fit.js';

const DEFAULT_WALLPAPER = '/opt/ai-desk/idle.png';
const SYSTEMCTL_TIMEOUT_MS = 10_000;

export interface DisplaySetupOptions {
  deskId: string | null;
  dataDir: string | null;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  headedContexts: () => BrowserContext[];
  push: (e: ToolEventInput) => void;
}

export function createDeskDisplayControl(o: DisplaySetupOptions): DisplayPort | undefined {
  if (!o.deskId || o.platform !== 'linux' || !o.env['DISPLAY']) return undefined;
  const wallpaper = o.env['DESK_WALLPAPER'] ?? DEFAULT_WALLPAPER;
  const driver = new DeskDisplay({
    exec: execBin,
    stateFile: o.dataDir ? path.join(o.dataDir, 'display-resolution') : null,
    wallpaper: wallpaper && existsSync(wallpaper) ? wallpaper : null,
  });
  // Selkies 单元名由工位 id 定;--no-block:只把重启排进 systemd 队列,不等它起来(polkit 只放行这一个单元的 restart)
  const unit = `desk-selkies@${o.deskId}.service`;
  return new DisplayControl({
    driver,
    fitWindows: () => maximizeAllWindows(o.headedContexts()),
    restartStream: async () => { await execBin('systemctl', ['restart', '--no-block', unit], SYSTEMCTL_TIMEOUT_MS); },
    push: o.push,
  });
}
