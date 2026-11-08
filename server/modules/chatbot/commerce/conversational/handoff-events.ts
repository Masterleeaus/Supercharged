/**
 * Handoff to a human, as an outbox event.
 *
 * recordHandoff() appends exactly one OutboxEvent (topic "conversation.handoff", the same name the inbox
 * EventPublisher uses) for one handoff. The caller passes a stable handoffId (for example the escalation id).
 * The dedupeKey is built from it, so a retried write reuses the same key and the outbox keeps one row.
 *
 * Rules:
 * - Written through the injected OutboxStorage. The caller runs it inside its own transaction (the state change
 *   that moves the conversation to a human). A publish failure later never rolls that state change back.
 * - The conversation must belong to companyId. A conversation from another company is reported as not found and
 *   nothing is appended.
 * - The payload carries ids, a bounded reason and summary, and a priority. It carries no customer contact data
 *   and no tokens.
 * - Requirement on OutboxStorage.append: a second append with an existing dedupeKey returns the existing event
 *   (or the store refuses it). It must never create a second row.
 */
import type { OutboxEvent, OutboxStorage } from "../../contracts/index.ts";
import { CommerceError } from "./errors.ts";

export const HANDOFF_TOPIC = "conversation.handoff";
export const HANDOFF_PRIORITIES = ["low", "normal", "high"] as const;
export type HandoffPriority = (typeof HANDOFF_PRIORITIES)[number];
export const HANDOFF_SOURCES = ["ai", "customer_rule"] as const;
export type HandoffSource = (typeof HANDOFF_SOURCES)[number];

export const HANDOFF_REASON_MAX = 500;
export const HANDOFF_SUMMARY_MAX = 1000;
const HANDOFF_ID_MAX = 191;

export interface HandoffRequest {
  conversationId: string;
  /** Stable id for this handoff. Retries must send the same value. */
  handoffId: string;
  reason: string;
  priority: HandoffPriority;
  source: HandoffSource;
  summary?: string | null;
}

export interface ConversationLookup {
  /** Returns the conversation only when it belongs to companyId. Null otherwise. */
  find(companyId: string, conversationId: string): Promise<{ id: string; chatbotId: string } | null>;
}

export interface HandoffEventDeps {
  outbox: OutboxStorage;
  conversations: ConversationLookup;
  now: () => Date;
}

export interface HandoffEventWriter {
  recordHandoff(companyId: string, request: HandoffRequest): Promise<OutboxEvent>;
}

/** The dedupe key for one handoff. Pure. */
export function handoffDedupeKey(conversationId: string, handoffId: string): string {
  return `${HANDOFF_TOPIC}:${conversationId}:${handoffId}`;
}

export function createHandoffEvents(deps: HandoffEventDeps): HandoffEventWriter {
  return {
    async recordHandoff(companyId, request) {
      requireText(companyId, "company_id");
      const conversationId = requireText(request.conversationId, "conversation_id");
      const handoffId = requireText(request.handoffId, "handoff_id");
      if ([...handoffId].length > HANDOFF_ID_MAX) throw new CommerceError("validation", "The handoff id is too long.", { handoff_id: "too_long" });
      const reason = requireText(request.reason, "reason");
      if ([...reason].length > HANDOFF_REASON_MAX) throw new CommerceError("validation", "The handoff reason is too long.", { reason: "too_long" });
      if (!(HANDOFF_PRIORITIES as readonly string[]).includes(request.priority)) {
        throw new CommerceError("validation", "The handoff priority is invalid.", { priority: "invalid" });
      }
      if (!(HANDOFF_SOURCES as readonly string[]).includes(request.source)) {
        throw new CommerceError("validation", "The handoff source is invalid.", { source: "invalid" });
      }
      const summary = request.summary?.trim() ? request.summary.trim().slice(0, HANDOFF_SUMMARY_MAX) : null;

      const conversation = await deps.conversations.find(companyId, conversationId);
      if (conversation === null) throw new CommerceError("not_found", "The conversation was not found.");

      const at = deps.now();
      return deps.outbox.append(companyId, {
        companyId,
        topic: HANDOFF_TOPIC,
        aggregateId: conversation.id,
        dedupeKey: handoffDedupeKey(conversation.id, handoffId),
        availableAt: at,
        payload: {
          conversation_id: conversation.id,
          chatbot_id: conversation.chatbotId,
          handoff_id: handoffId,
          reason,
          priority: request.priority,
          source: request.source,
          summary,
          occurred_at: at.toISOString(),
        },
      });
    },
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CommerceError("validation", `${field} is required.`, { [field]: "required" });
  }
  return value.trim();
}
