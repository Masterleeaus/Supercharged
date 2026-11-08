/**
 * Outbox event for a voice session that ends. Built here, written by the storage in the same transaction as the
 * state change (CONVENTIONS section 6). The payload carries ids, the end reason and counts only: no transcript,
 * reply text, audio or caller data.
 */
import type { OutboxEvent } from "../contracts/index.ts";
import type { VoiceSessionRecord } from "./voice-storage.ts";

export const VOICE_SESSION_ENDED_TOPIC = "voice.session.ended";

export type NewOutboxEvent = Omit<OutboxEvent, "id" | "status" | "attempts" | "publishedAt" | "createdAt">;

/** One event per session end. The dedupe key is the session id, so a second end can never add a second event. */
export function buildSessionEndedEvent(session: VoiceSessionRecord): NewOutboxEvent {
  if (session.endedAt === null || session.endReason === null) {
    throw new Error("voice session end event needs an ended session");
  }
  return {
    companyId: session.companyId,
    topic: VOICE_SESSION_ENDED_TOPIC,
    aggregateId: session.id,
    dedupeKey: `${VOICE_SESSION_ENDED_TOPIC}:${session.id}`,
    availableAt: session.endedAt,
    payload: {
      sessionId: session.id,
      chatbotId: session.chatbotId,
      conversationId: session.conversationId,
      endReason: session.endReason,
      turnCount: session.turnCount,
      usedMs: session.usedMs,
      endedAt: session.endedAt.toISOString(),
    },
  };
}
