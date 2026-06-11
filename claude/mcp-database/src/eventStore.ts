/**
 * 有界内存 EventStore — 支撑 Streamable HTTP 的断线重放（resumability）。
 *
 * SDK examples 里的 InMemoryEventStore 永不淘汰事件，长期运行会无界吃内存；
 * 这里按 FIFO 设置总量上限。超过上限后最旧的事件被丢弃 —— 客户端若拿着
 * 已淘汰的 Last-Event-ID 重连，会从可用事件之后继续（丢失部分重放，但不泄漏内存）。
 */

import { randomUUID } from 'node:crypto';
import type { EventStore, EventId, StreamId } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

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
    if (!entry) return '';
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
