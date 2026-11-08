/*
 * Real-time event port for the unified inbox. Ably is NOT ported. The transport is an open decision for the
 * owner (see DECISIONS.md). The service calls publish() after each committed state change.
 *
 * Every event carries companyId. A transport must route each event only to that company's subscribers.
 * Publish failures never roll back the state change, which matches the PHP try/catch around the Ably calls.
 */
import type { PresenceState } from "./types.ts";

export const INBOX_EVENT_TYPES = [
  "conversation.handoff",
  "conversation.handback",
  "conversation.assigned",
  "conversation.status_changed",
  "conversation.priority_changed",
  "participant.saved",
  "participant.removed",
  "participant.read",
  "presence.changed",
] as const;
export type InboxEventType = (typeof INBOX_EVENT_TYPES)[number];

export interface InboxEventData {
  actorId: string;
  /** Previous value, when the change has one. */
  from?: string | null;
  /** New value. */
  to?: string | null;
  participantId?: string;
  presenceState?: PresenceState;
  participantKey?: string;
  unreadCount?: number;
}

export interface InboxEvent {
  type: InboxEventType;
  companyId: string;
  conversationId: string;
  occurredAt: Date;
  data: InboxEventData;
}

export interface EventPublisher {
  publish(event: InboxEvent): Promise<void>;
}

/** Keeps every event in memory, in order. Used by tests and local runs. */
export class InMemoryEventPublisher implements EventPublisher {
  private readonly recorded: InboxEvent[] = [];

  async publish(event: InboxEvent): Promise<void> {
    this.recorded.push({ ...event, data: { ...event.data } });
  }

  /** Copy of every event, oldest first. */
  events(): InboxEvent[] {
    return this.recorded.map((event) => ({ ...event, data: { ...event.data } }));
  }

  /** Events for one company only. */
  forCompany(companyId: string): InboxEvent[] {
    return this.events().filter((event) => event.companyId === companyId);
  }

  clear(): void {
    this.recorded.length = 0;
  }
}

/** Discards every event. Use it when no transport is wired yet. */
export const NOOP_EVENT_PUBLISHER: EventPublisher = {
  async publish(): Promise<void> {},
};
