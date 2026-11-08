/*
 * Ports and result types for the conversation and reply runtime. Port of the reply path in
 * extensions/chatbot/System/Services (AIRuntime, MessageRuntime, DraftRuntime, StreamingRuntime).
 *
 * Only type imports from sibling slices. The chatbot service and storage are read by import, never edited.
 */
import type { ChatbotStorage, MessageRecord } from "../chatbot-storage.ts";
import type { ModelFinishReason, ModelUsage } from "../contracts/index.ts";

/** Reads needed to build a reply. Every read returns null for a row that belongs to another company. */
export type ReplyStorage = Pick<ChatbotStorage, "findConversation" | "findChatbot" | "listMessages">;

/**
 * The one write a reply needs. recordAssistantReply runs the generative-UI composer when it is enabled. The
 * conversation-store writer (reply-writer.ts) matches this shape too, so only the id and the accepted flag are read.
 */
export interface ReplyWriter {
  recordAssistantReply(
    companyId: string,
    conversationId: string,
    text: string,
    surface?: string,
  ): Promise<{ message: { id: string }; accepted: boolean }>;
}

export type TurnClaim =
  | { kind: "claimed" }
  | { kind: "done"; messageId: string }
  | { kind: "pending" };

/**
 * Claims a customer message's reply so that only one caller generates and stores it. A claim is a lease: a pending
 * claim older than leaseMs may be taken again, so a crashed worker does not block the conversation forever.
 */
export interface ReplyTurnStore {
  claim(companyId: string, conversationId: string, turnKey: string, now: Date, leaseMs: number): Promise<TurnClaim>;
  complete(companyId: string, conversationId: string, turnKey: string, messageId: string, now: Date): Promise<void>;
  release(companyId: string, conversationId: string, turnKey: string): Promise<void>;
}

/** Text one staff member saved for one conversation (PHP DraftRuntime save/get/delete). */
export interface StaffDraft {
  companyId: string;
  conversationId: string;
  staffId: string;
  content: string | null;
  attachments: unknown[];
  metadata: Record<string, unknown>;
  updatedAt: Date;
}

export interface StaffDraftAttributes {
  content?: string | null;
  attachments?: unknown[];
  metadata?: Record<string, unknown>;
}

export interface StaffDraftStore {
  save(companyId: string, conversationId: string, staffId: string | null, attributes: StaffDraftAttributes, now: Date): Promise<StaffDraft>;
  get(companyId: string, conversationId: string, staffId: string | null): Promise<StaffDraft | null>;
  delete(companyId: string, conversationId: string, staffId: string | null): Promise<boolean>;
}

export type ReplyEvent =
  | { type: "reply.stored"; companyId: string; conversationId: string; messageId: string; at: Date }
  | { type: "reply.duplicate"; companyId: string; conversationId: string; messageId: string; at: Date }
  | { type: "reply.failed"; companyId: string; conversationId: string; reason: string; at: Date }
  | { type: "reply.turn_unmarked"; companyId: string; conversationId: string; messageId: string; at: Date };

/** Receives reply events. Failures in the sink are swallowed: a delivery problem never undoes a stored reply. */
export type ReplyEventSink = (event: ReplyEvent) => void | Promise<void>;

/** A stream frame for the caller's transport. The runtime chooses no transport. */
export type StreamFrame =
  | { kind: "chunk"; companyId: string; conversationId: string; sequence: number; text: string }
  | { kind: "done"; companyId: string; conversationId: string; sequence: number; messageId: string | null; finishReason: ModelFinishReason }
  | { kind: "error"; companyId: string; conversationId: string; sequence: number; reason: string }
  | { kind: "typing"; companyId: string; conversationId: string; participantKey: string; active: boolean };

export type StreamPublisher = (frame: StreamFrame) => Promise<void>;

export interface StreamOutcome {
  messageId: string;
  deltasSent: number;
  finishReason: ModelFinishReason;
  usage: ModelUsage;
}

export const ZERO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0 };
