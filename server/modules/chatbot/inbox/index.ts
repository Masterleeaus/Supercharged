/*
 * Unified inbox entry point. Not imported by chatbot/index.ts yet. The integration agent wires it in.
 *
 * Usage:
 *   createInboxService({ storage, events, enabled: false })
 *
 * The inbox is off unless enabled is true. Storage and events are injected, and the Drizzle storage
 * adapter is not written yet (see DECISIONS.md).
 */
export {
  createInboxService,
  normaliseInboxQuery,
  resolvePresenceTtlSeconds,
} from "./inbox-service.ts";
export type { InboxService, InboxServiceOptions, MarkReadResult } from "./inbox-service.ts";
export { InMemoryInboxStorage } from "./memory-storage.ts";
export { createDrizzleInboxStorage } from "./drizzle-storage.ts";
export type { SeedConversationInput, SeedMessageInput } from "./memory-storage.ts";
export { INBOX_EVENT_TYPES, InMemoryEventPublisher, NOOP_EVENT_PUBLISHER } from "./event-publisher.ts";
export type { EventPublisher, InboxEvent, InboxEventData, InboxEventType } from "./event-publisher.ts";
export type { ConversationStatePatch, HandlerTransition, InboxStorage } from "./ports.ts";
export * from "./types.ts";
