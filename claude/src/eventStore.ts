/**
 * 有界内存 EventStore — 支撑 Streamable HTTP 的断线重放（resumability）。
 *
 * SDK examples 里的 InMemoryEventStore 永不淘汰事件，长期运行会无界吃内存；
 * 这里按 FIFO 设置总量上限。超过上限后最旧的事件被丢弃 —— 客户端若拿着
 * 已淘汰的 Last-Event-ID 重连，重放明确失败（SDK 回 500 "Error replaying events"），
 * 客户端知道这段断线期间的消息没了，而不是拿到一条「成功但当场关掉」的空流反复重连。
 */

import { randomUUID } from 'node:crypto';
import type { EventStore, EventId, StreamId, JSONRPCMessage } from "@modelcontextprotocol/server";

const MAX_EVENTS = 1000;

export class BoundedEventStore implements EventStore {
  // Map 保持插入顺序，天然 FIFO
  private events = new Map<EventId, { streamId: StreamId; message: JSONRPCMessage }>();

  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = `${streamId}_${randomUUID()}`;
    this.events.set(eventId, { streamId, message });
    while (this.events.size > MAX_EVENTS) {
      const oldest = this.events.keys().next().value;
      if (oldest === undefined) break;
      this.events.delete(oldest);
    }
    return eventId;
  }

  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return this.events.get(eventId)?.streamId;
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> },
  ): Promise<StreamId> {
    const entry = this.events.get(lastEventId);
    // 以前返回 ''：SDK 会建一条流、发现 '' 不对应任何请求又立刻关掉，客户端收到 200 + 空流，
    // 按 EventSource 惯例拿着同一个过期 ID 反复重连，永远不知道出错（2026-09-25 审查发现）
    if (!entry) throw new Error(`Last-Event-ID ${lastEventId} 已被淘汰（只保留最近 ${MAX_EVENTS} 条事件），无法重放`);
    let found = false;
    for (const [eventId, { streamId, message }] of this.events) {
      if (found && streamId === entry.streamId) {
        await send(eventId, message);
      }
      if (eventId === lastEventId) found = true;
    }
    return entry.streamId;
  }
}
