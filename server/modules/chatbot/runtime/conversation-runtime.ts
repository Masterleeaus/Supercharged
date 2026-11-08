/*
 * Conversation runtime: create, archive, merge, search and cached summaries. Implements the ConversationRuntime
 * contract. Port of ConversationRuntime.php, with three changes: every call takes companyId, archive hides a
 * conversation by status instead of only stamping a time, and the outbox row is written with the state change.
 *
 * Storage goes through ConversationStore (conversation-store.ts). No vendor, no network except the injected route.
 */
import { randomUUID } from "node:crypto";
import type {
  ConversationRecord,
  ConversationRuntime as ConversationRuntimeContract,
  ConversationSearchFilters,
  ConversationSearchPage,
  NewConversation,
} from "../contracts/runtime.ts";
import type { ConversationSearchQuery, ConversationStore, OutboxAppend, StoredMessage } from "./conversation-store.ts";
import type { CompletionRoute } from "./failover.ts";
import { fallbackSummary, summarizeWithStatus } from "./summary.ts";

export const SEARCH_DEFAULT_LIMIT = 25;
export const SEARCH_MAX_LIMIT = 100;
export const SEARCH_MAX_QUERY_CHARS = 200;
/** A cached summary is reused until this many new (non-internal) messages arrive. */
export const SUMMARY_REFRESH_AFTER_MESSAGES = 10;
/** Long conversations: only the newest messages go to the model. */
export const SUMMARY_MAX_MESSAGES = 200;

export type ConversationErrorCode =
  | "chatbot_not_found"
  | "self_merge"
  | "chatbot_mismatch"
  | "target_not_open"
  | "source_merged_elsewhere"
  | "merge_conflict"
  | "invalid_cursor";

/** Thrown for rule breaks a caller can fix. Carries a code only, never a stored value. */
export class ConversationRuntimeError extends Error {
  constructor(readonly code: ConversationErrorCode) {
    super(code);
    this.name = "ConversationRuntimeError";
  }
}

export interface ConversationRuntimeDeps {
  store: ConversationStore;
  /** Model route for summaries. Failover order and model ids are resolved by the caller. */
  route: CompletionRoute;
  now?: () => Date;
  newId?: () => string;
}

export interface ConversationRuntime extends ConversationRuntimeContract {}

type CursorPayload = { u: string; i: string };

export function encodeSearchCursor(row: Pick<ConversationRecord, "updatedAt" | "id">): string {
  const payload: CursorPayload = { u: row.updatedAt.toISOString(), i: row.id };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeSearchCursor(cursor: string | null): { updatedAt: Date; id: string } | null {
  if (cursor === null || cursor === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ConversationRuntimeError("invalid_cursor");
  }
  if (typeof parsed !== "object" || parsed === null) throw new ConversationRuntimeError("invalid_cursor");
  const { u, i } = parsed as Partial<CursorPayload>;
  const updatedAt = typeof u === "string" ? new Date(u) : null;
  if (!updatedAt || Number.isNaN(updatedAt.getTime()) || typeof i !== "string" || i === "") {
    throw new ConversationRuntimeError("invalid_cursor");
  }
  return { updatedAt, id: i };
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, Math.trunc(value)));

export function createConversationRuntime(deps: ConversationRuntimeDeps): ConversationRuntime {
  const { store, route } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? randomUUID;

  const outboxFor = (topic: string, aggregateId: string, payload: Record<string, unknown>, dedupeKey: string, at: Date): OutboxAppend => ({
    topic,
    aggregateId,
    payload,
    dedupeKey,
    availableAt: at,
  });

  return {
    async create(companyId: string, input: NewConversation): Promise<ConversationRecord> {
      if (!(await store.chatbotBelongsTo(companyId, input.chatbotId))) {
        throw new ConversationRuntimeError("chatbot_not_found");
      }
      const at = now();
      const id = newId();
      const record: ConversationRecord = {
        id,
        companyId,
        chatbotId: input.chatbotId,
        channel: input.channel,
        externalThreadId: input.externalThreadId,
        customerId: input.customerId,
        status: "open",
        handler: "ai",
        summary: null,
        summaryUpdatedAt: null,
        mergedIntoId: null,
        createdAt: at,
        updatedAt: at,
      };
      return store.insertConversation(
        companyId,
        record,
        outboxFor("chatbot.conversation.created", id, { conversation_id: id }, `chatbot.conversation.created:${id}`, at),
      );
    },

    async archive(companyId: string, conversationId: string): Promise<ConversationRecord | null> {
      const current = await store.findConversation(companyId, conversationId);
      if (!current) return null;
      // Already archived, or merged: nothing to change, and no second event.
      if (current.status !== "open") return current;
      const at = now();
      return store.setStatus(
        companyId,
        conversationId,
        "archived",
        at,
        outboxFor(
          "chatbot.conversation.archived",
          conversationId,
          { conversation_id: conversationId },
          `chatbot.conversation.archived:${conversationId}`,
          at,
        ),
      );
    },

    async merge(companyId: string, targetId: string, sourceId: string): Promise<ConversationRecord | null> {
      if (targetId === sourceId) throw new ConversationRuntimeError("self_merge");

      // Both lookups are company-scoped. A conversation of another company is absent, so no cross-company merge can start.
      const target = await store.findConversation(companyId, targetId);
      if (!target) return null;
      const source = await store.findConversation(companyId, sourceId);
      if (!source) return null;

      // Repeating a finished merge does nothing and moves nothing.
      if (source.status === "merged" && source.mergedIntoId === targetId) return target;

      if (target.chatbotId !== source.chatbotId) throw new ConversationRuntimeError("chatbot_mismatch");
      if (target.status !== "open") throw new ConversationRuntimeError("target_not_open");
      if (source.status === "merged") throw new ConversationRuntimeError("source_merged_elsewhere");

      const at = now();
      const outcome = await store.mergeConversations(
        companyId,
        targetId,
        sourceId,
        at,
        outboxFor(
          "chatbot.conversation.merged",
          targetId,
          { target_id: targetId, source_id: sourceId },
          `chatbot.conversation.merged:${sourceId}:${targetId}`,
          at,
        ),
      );
      if (outcome.kind === "conflict") throw new ConversationRuntimeError("merge_conflict");
      return outcome.target;
    },

    async summarize(companyId: string, conversationId: string, options: { force: boolean; timeoutMs: number }): Promise<string> {
      const conversation = await store.findConversation(companyId, conversationId);
      if (!conversation) return "";

      const visible = (await store.listMessages(companyId, conversationId)).filter((message) => !message.isInternalNote);
      if (visible.length === 0) return conversation.summary ?? "";

      if (!options.force && conversation.summary !== null && conversation.summaryUpdatedAt !== null) {
        const cachedAt = conversation.summaryUpdatedAt.getTime();
        const newer = visible.filter((message) => message.createdAt.getTime() > cachedAt).length;
        if (newer < SUMMARY_REFRESH_AFTER_MESSAGES) return conversation.summary;
      }

      const window: StoredMessage[] = visible.slice(-SUMMARY_MAX_MESSAGES);
      const transcript = window.map((message) => ({ role: message.role, message: message.text }));
      let result;
      try {
        result = await summarizeWithStatus(route, companyId, transcript, {
          timeoutMs: options.timeoutMs,
          conversationId,
        });
      } catch {
        // A non-retryable provider error. Keep the last good summary, or a plain excerpt. Nothing is cached.
        return conversation.summary ?? fallbackSummary(window.map((m) => `${m.role}: ${m.text ?? ""}`).join("\n"));
      }

      if (!result.fromModel) return conversation.summary ?? result.text;
      await store.setSummary(companyId, conversationId, result.text, now());
      return result.text;
    },

    async search(companyId: string, filters: ConversationSearchFilters): Promise<ConversationSearchPage> {
      const limit = clamp(filters.limit ?? SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
      const after = decodeSearchCursor(filters.cursor);
      const trimmed = (filters.query ?? "").trim().slice(0, SEARCH_MAX_QUERY_CHARS);

      const query: ConversationSearchQuery = {
        chatbotId: filters.chatbotId,
        channel: filters.channel,
        status: filters.status,
        customerId: filters.customerId,
        query: trimmed === "" ? undefined : trimmed,
        updatedAfter: filters.updatedAfter,
        limit: limit + 1,
        after,
      };
      const rows = await store.searchConversations(companyId, query);
      const rowsForPage = rows.slice(0, limit);
      const last = rowsForPage[rowsForPage.length - 1];
      const nextCursor = rows.length > limit && last ? encodeSearchCursor(last) : null;
      return { rows: rowsForPage, nextCursor };
    },
  };
}
