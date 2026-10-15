/**
 * 本进程唯一的一份事件时间线和闸门(HTTP 腿、pipe 腿、stdio 的所有会话共用:一个进程 = 一个工位)。
 */

import { deskConfig } from './config.js';
import { EventRing } from './events.js';
import { DeskGate } from './gate.js';

export const deskRing = new EventRing(2000);

/** PAUSE_WAIT_MAX_MS=0 表示暂停时不等、立即拒绝 */
export const deskGate = new DeskGate(
  deskConfig.pauseWaitMaxMs || 1,
  deskConfig.pauseWaitMaxMs === 0 ? 'reject' : 'wait',
);
