/*
 * Publishes conversation events after the store has committed them. The store writes the outbox row in the same
 * transaction as the state change (conversation-store.ts). This wrapper calls the sink only after that call returns,
 * so a subscriber never sees an event for a change that rolled back.
 *
 * A sink failure is swallowed: a delivery problem never undoes the change. The events processor relays only inbox
 * topics, so conversation topics (chatbot.conversation.*) reach realtime through this wrapper and no other path.
 */
import type { ConversationStore, OutboxAppend } from "./conversation-store.ts";

export type StoreEventSink = (companyId: string, event: OutboxAppend) => void | Promise<void>;

export function withStoreEvents(store: ConversationStore, sink: StoreEventSink): ConversationStore {
  const emit = async (companyId: string, event: OutboxAppend): Promise<void> => {
    try {
      await sink(companyId, event);
    } catch {
      // Publish failures never roll back the committed change.
    }
  };

  const overrides: Partial<ConversationStore> = {
    async insertConversation(companyId, record, event) {
      const created = await store.insertConversation(companyId, record, event);
      await emit(companyId, event);
      return created;
    },

    async setStatus(companyId, id, status, now, event) {
      const updated = await store.setStatus(companyId, id, status, now, event);
      if (updated && event) await emit(companyId, event);
      return updated;
    },

    async mergeConversations(companyId, targetId, sourceId, now, event) {
      const outcome = await store.mergeConversations(companyId, targetId, sourceId, now, event);
      if (outcome.kind === "merged") await emit(companyId, event);
      return outcome;
    },
  };

  // Prototype chain: every method this wrapper does not change is inherited, so nothing is copied or lost.
  return Object.assign(Object.create(store) as ConversationStore, overrides);
}
