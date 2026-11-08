/*
 * Publishers over Server-Sent Events. Each one routes inside the company it is given, through the hub.
 *
 * - createSsePublisher: the inbox EventPublisher (inbox/ports.ts). Staff streams of the event's company only.
 * - createSseStoreEventSink: conversation events from runtime/store-events.ts (created, archived, merged). Staff only.
 * - createSseReplyEventSink: reply events from the reply runtime. A stored reply reaches the staff streams and the
 *   customer streams of its conversation. A failure reaches staff only, with a code and no text.
 */
import type { EventPublisher } from "../inbox/event-publisher.ts";
import type { ReplyEvent } from "../runtime/types.ts";
import type { SseHub } from "./hub.ts";

export function createSsePublisher(hub: SseHub): EventPublisher {
  return {
    async publish(event) {
      hub.routeInbox(event);
    },
  };
}

/** Matches runtime/store-events.ts StoreEventSink. Typed structurally, so realtime does not import the runtime. */
export function createSseStoreEventSink(hub: SseHub): (companyId: string, event: { topic: string; aggregateId: string; payload: Record<string, unknown> }) => void {
  return (companyId, event) => {
    hub.routeToStaff(companyId, event.topic, { ...event.payload, conversationId: event.aggregateId });
  };
}

export function createSseReplyEventSink(hub: SseHub): (event: ReplyEvent) => void {
  return (event) => {
    if (event.type === "reply.stored") {
      hub.routeToConversation(event.companyId, event.conversationId, "reply.stored", { messageId: event.messageId });
    } else if (event.type === "reply.failed") {
      hub.routeToStaff(event.companyId, "reply.failed", { conversationId: event.conversationId, code: event.reason });
    }
    // reply.duplicate and reply.turn_unmarked are internal bookkeeping. Nothing is sent for them.
  };
}
