/*
 * Unified inbox service. Port of UnifiedInboxService (query, assign), ParticipantRuntime (participants,
 * read cursor, unread count) and PresenceRuntime (presence heartbeat and TTL), plus the AI-to-human handoff
 * rule from the Chatbot extension (connect_agent_at: null means the AI handles the chat).
 *
 * Off by default. Every method throws 503 until enabled is set. The chatbot module reads no env, so the flag
 * arrives as an option, the same way generativeUi does.
 *
 * Every method takes companyId first and calls requireCompanyId before anything else.
 */
import { randomUUID } from "node:crypto";
import { ChatbotError, requireCompanyId } from "../chatbot-scope.ts";
import type { EventPublisher, InboxEvent, InboxEventType } from "./event-publisher.ts";
import { NOOP_EVENT_PUBLISHER } from "./event-publisher.ts";
import type { ConversationStatePatch, InboxStorage } from "./ports.ts";
import {
  DEFAULT_PAGE_SIZE,
  DEFAULT_PRESENCE_TTL_SECONDS,
  HANDLERS,
  INBOX_PRIORITIES,
  MAX_ID_LENGTH,
  MAX_PAGE_SIZE,
  MAX_TYPE_LENGTH,
  MIN_PRESENCE_TTL_SECONDS,
  PRESENCE_STATES,
  TICKET_STATUSES,
} from "./types.ts";
import type {
  Handler,
  HandlingChange,
  HandlingState,
  InboxActor,
  InboxConversation,
  InboxFilter,
  InboxPage,
  InboxParticipant,
  InboxPresence,
  InboxPriority,
  InboxQueryInput,
  MessageCursor,
  PresenceState,
  TicketStatus,
  TouchPresenceInput,
  UnreadCounts,
  UpsertParticipantInput,
} from "./types.ts";

const MAX_SEARCH_LENGTH = 200;

export interface InboxServiceOptions {
  storage: InboxStorage;
  /** Real-time transport. Defaults to a no-op. Ably is not ported (see DECISIONS.md). */
  events?: EventPublisher;
  /** Default false. Nothing is read or written while the inbox is off. */
  enabled?: boolean;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Presence window in seconds. Default 120, and never below 15, matching the PHP clamp. */
  presenceTtlSeconds?: number;
  /** Called when the publisher throws. The state change is already committed, so it is not rolled back. */
  onPublishError?: (error: unknown, event: InboxEvent) => void;
}

export interface MarkReadResult {
  participant: InboxParticipant;
  unreadCount: number;
}

export interface InboxService {
  query(companyId: string, input?: InboxQueryInput): Promise<InboxPage>;
  unreadCounts(companyId: string): Promise<UnreadCounts>;

  assign(companyId: string, conversationId: string, assignedTo: string | null, actor: InboxActor): Promise<InboxConversation>;
  setPriority(companyId: string, conversationId: string, priority: InboxPriority, actor: InboxActor): Promise<InboxConversation>;
  setTicketStatus(companyId: string, conversationId: string, status: TicketStatus, actor: InboxActor): Promise<InboxConversation>;

  handoffToHuman(companyId: string, conversationId: string, actor: InboxActor): Promise<HandlingChange>;
  handBackToAi(companyId: string, conversationId: string, actor: InboxActor): Promise<HandlingChange>;
  handlingState(companyId: string, conversationId: string): Promise<HandlingState>;

  upsertParticipant(
    companyId: string,
    conversationId: string,
    input: UpsertParticipantInput,
    actor: InboxActor,
  ): Promise<InboxParticipant>;
  listParticipants(companyId: string, conversationId: string): Promise<InboxParticipant[]>;
  markParticipantRead(
    companyId: string,
    conversationId: string,
    participantId: string,
    actor: InboxActor,
    messageId?: string | null,
  ): Promise<MarkReadResult>;
  participantUnreadCount(companyId: string, conversationId: string, participantId: string): Promise<number>;
  removeParticipant(companyId: string, conversationId: string, participantId: string, actor: InboxActor): Promise<void>;

  touchPresence(companyId: string, conversationId: string, input: TouchPresenceInput): Promise<InboxPresence>;
  activePresence(companyId: string, conversationId: string): Promise<InboxPresence[]>;
}

// ---------- validation helpers ----------

function fail(message: string, status: number): never {
  throw new ChatbotError(message, status);
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") fail(`${label} is required`, 422);
  const trimmed = (value as string).trim();
  if (trimmed === "") fail(`${label} is required`, 422);
  if (trimmed.length > maxLength) fail(`${label} must be at most ${maxLength} characters`, 422);
  return trimmed;
}

function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") fail(`${label} must be a string`, 422);
  const trimmed = (value as string).trim();
  if (trimmed === "") return null;
  if (trimmed.length > maxLength) fail(`${label} must be at most ${maxLength} characters`, 422);
  return trimmed;
}

function requireActor(actor: InboxActor | undefined): string {
  if (!actor || typeof actor !== "object") fail("actor is required", 422);
  return requireText(actor.id, "actor id", MAX_ID_LENGTH);
}

function requireOneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${label} must be one of: ${allowed.join(", ")}`, 422);
  }
  return value as T;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`, 422);
  return { ...(value as Record<string, unknown>) };
}

/** Null and undefined both mean the caller did not set the field. */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function requireBody<T extends object>(input: T | undefined, label: string): T {
  if (!input || typeof input !== "object") fail(`${label} is required`, 422);
  return input as T;
}

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Turns caller input into a storage filter. Validation happens here, so storage only sees clean values. */
export function normaliseInboxQuery(input: InboxQueryInput = {}): InboxFilter {
  const perPage = toInt(input.perPage ?? DEFAULT_PAGE_SIZE, DEFAULT_PAGE_SIZE, 1, MAX_PAGE_SIZE);
  const page = toInt(input.page ?? 1, 1, 1, Number.MAX_SAFE_INTEGER);

  const rawQ = optionalText(input.q, "q", MAX_SEARCH_LENGTH);

  let handler: Handler | "all" = "all";
  if (isSet(input.handler) && input.handler !== "all") {
    handler = requireOneOf(input.handler, HANDLERS, "handler");
  }

  let status: TicketStatus | null = null;
  if (isSet(input.status) && input.status !== "all") {
    status = requireOneOf(input.status, TICKET_STATUSES, "status");
  }

  let priority: InboxPriority | null = null;
  if (isSet(input.priority)) {
    priority = requireOneOf(input.priority, INBOX_PRIORITIES, "priority");
  }

  return {
    q: rawQ,
    handler,
    assignedTo: optionalText(input.assignedTo, "assignedTo", MAX_ID_LENGTH),
    priority,
    status,
    unread: input.unread === true,
    offset: (page - 1) * perPage,
    limit: perPage,
  };
}

/** Presence window in seconds. Non-finite input falls back to the default. Never below the 15 second floor. */
export function resolvePresenceTtlSeconds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PRESENCE_TTL_SECONDS;
  return Math.max(MIN_PRESENCE_TTL_SECONDS, Math.trunc(value));
}

function cursorFor(participant: InboxParticipant): MessageCursor | null {
  if (participant.lastReadMessageId === null || participant.lastReadMessageCreatedAt === null) return null;
  return { createdAt: participant.lastReadMessageCreatedAt, id: participant.lastReadMessageId };
}

// ---------- factory ----------

export function createInboxService(options: InboxServiceOptions): InboxService {
  const { storage } = options;
  const events = options.events ?? NOOP_EVENT_PUBLISHER;
  const enabled = options.enabled === true;
  const clock = options.now ?? (() => new Date());
  const presenceTtlSeconds = resolvePresenceTtlSeconds(options.presenceTtlSeconds);
  const onPublishError = options.onPublishError ?? (() => {});

  /** Scope check first, then the flag. Nothing reaches storage until both pass. */
  function gate(companyId: unknown): string {
    const scoped = requireCompanyId(companyId);
    if (!enabled) fail("Unified inbox is disabled", 503);
    return scoped;
  }

  async function publish(
    type: InboxEventType,
    companyId: string,
    conversationId: string,
    data: InboxEvent["data"],
  ): Promise<void> {
    const event: InboxEvent = { type, companyId, conversationId, occurredAt: clock(), data };
    try {
      await events.publish(event);
    } catch (error) {
      onPublishError(error, event);
    }
  }

  async function loadConversation(companyId: string, conversationId: string): Promise<InboxConversation> {
    const row = await storage.getConversation(companyId, conversationId);
    if (!row) fail("Conversation not found", 404);
    return row;
  }

  async function applyState(
    companyId: string,
    conversationId: string,
    patch: ConversationStatePatch,
  ): Promise<InboxConversation> {
    const updated = await storage.saveConversationState(companyId, conversationId, patch);
    if (!updated) fail("Conversation not found", 404);
    return updated;
  }

  async function loadParticipant(companyId: string, conversationId: string, participantId: string): Promise<InboxParticipant> {
    const id = requireText(participantId, "participantId", MAX_ID_LENGTH);
    const participant = await storage.getParticipant(companyId, conversationId, id);
    if (!participant) fail("Participant not found", 404);
    return participant;
  }

  return {
    async query(companyIdRaw, input) {
      const companyId = gate(companyIdRaw);
      const filter = normaliseInboxQuery(input);
      const { rows, total } = await storage.listConversations(companyId, filter);
      return {
        data: rows,
        total,
        page: Math.floor(filter.offset / filter.limit) + 1,
        perPage: filter.limit,
      };
    },

    async unreadCounts(companyIdRaw) {
      const companyId = gate(companyIdRaw);
      const [agent, ai, all] = await Promise.all([
        storage.countConversationsWithUnreadInbound(companyId, "human"),
        storage.countConversationsWithUnreadInbound(companyId, "ai"),
        storage.countConversationsWithUnreadInbound(companyId, "all"),
      ]);
      return { agent, ai, all };
    },

    async assign(companyIdRaw, conversationIdRaw, assignedToRaw, actor) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      const actorId = requireActor(actor);
      const assignedTo = optionalText(assignedToRaw, "assignedTo", MAX_ID_LENGTH);

      const current = await loadConversation(companyId, conversationId);
      if (current.assignedTo === assignedTo) return current;

      const updated = await applyState(companyId, conversationId, { assignedTo });
      await publish("conversation.assigned", companyId, conversationId, {
        actorId,
        from: current.assignedTo,
        to: assignedTo,
      });
      return updated;
    },

    async setPriority(companyIdRaw, conversationIdRaw, priorityRaw, actor) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      const actorId = requireActor(actor);
      const priority = requireOneOf(priorityRaw, INBOX_PRIORITIES, "priority");

      const current = await loadConversation(companyId, conversationId);
      if (current.priority === priority) return current;

      const updated = await applyState(companyId, conversationId, { priority });
      await publish("conversation.priority_changed", companyId, conversationId, {
        actorId,
        from: current.priority,
        to: priority,
      });
      return updated;
    },

    async setTicketStatus(companyIdRaw, conversationIdRaw, statusRaw, actor) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      const actorId = requireActor(actor);
      const status = requireOneOf(statusRaw, TICKET_STATUSES, "status");

      const current = await loadConversation(companyId, conversationId);
      if (current.ticketStatus === status) return current;

      const updated = await applyState(companyId, conversationId, { ticketStatus: status });
      await publish("conversation.status_changed", companyId, conversationId, {
        actorId,
        from: current.ticketStatus,
        to: status,
      });
      return updated;
    },

    async handoffToHuman(companyIdRaw, conversationIdRaw, actor) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      const actorId = requireActor(actor);
      const transition = await storage.transitionHandler(companyId, conversationId, "human", clock());
      if (!transition) fail("Conversation not found", 404);
      if (transition.applied) {
        await publish("conversation.handoff", companyId, conversationId, { actorId, from: "ai", to: "human" });
      }
      return { conversation: transition.conversation, changed: transition.applied };
    },

    async handBackToAi(companyIdRaw, conversationIdRaw, actor) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      const actorId = requireActor(actor);
      const transition = await storage.transitionHandler(companyId, conversationId, "ai", clock());
      if (!transition) fail("Conversation not found", 404);
      if (transition.applied) {
        await publish("conversation.handback", companyId, conversationId, { actorId, from: "human", to: "ai" });
      }
      return { conversation: transition.conversation, changed: transition.applied };
    },

    async handlingState(companyIdRaw, conversationIdRaw) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      const conversation = await loadConversation(companyId, conversationId);
      return {
        conversationId,
        handler: conversation.connectAgentAt === null ? "ai" : "human",
        handedOffAt: conversation.connectAgentAt,
        assignedTo: conversation.assignedTo,
      };
    },

    async upsertParticipant(companyIdRaw, conversationIdRaw, input, actor) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      const actorId = requireActor(actor);
      await loadConversation(companyId, conversationId);

      const body = requireBody(input, "input");
      const type = requireText(body.type, "type", MAX_TYPE_LENGTH);
      const reference = optionalText(body.reference, "reference", MAX_ID_LENGTH);
      const displayName = optionalText(body.displayName, "display_name", MAX_ID_LENGTH);
      const metadata = plainObject(body.metadata, "metadata");
      const now = clock();

      const existing = await storage.findParticipantByKey(companyId, conversationId, type, reference);
      const participant: InboxParticipant = existing
        ? { ...existing, displayName, metadata, lastSeenAt: now }
        : {
            companyId,
            id: randomUUID(),
            conversationId,
            type,
            reference,
            displayName,
            metadata,
            lastSeenAt: now,
            lastReadMessageId: null,
            lastReadMessageCreatedAt: null,
            lastReadAt: null,
          };

      await storage.saveParticipant(companyId, participant);
      await publish("participant.saved", companyId, conversationId, {
        actorId,
        participantId: participant.id,
        to: type,
      });
      return { ...participant, metadata: { ...participant.metadata } };
    },

    async listParticipants(companyIdRaw, conversationIdRaw) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      await loadConversation(companyId, conversationId);
      return storage.listParticipants(companyId, conversationId);
    },

    async markParticipantRead(companyIdRaw, conversationIdRaw, participantIdRaw, actor, messageId) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      const actorId = requireActor(actor);
      const participant = await loadParticipant(companyId, conversationId, participantIdRaw);

      let cursor: MessageCursor | null;
      if (messageId === undefined || messageId === null) {
        cursor = await storage.latestMessageCursor(companyId, conversationId);
      } else {
        const id = requireText(messageId, "history_id", MAX_ID_LENGTH);
        cursor = await storage.findMessageCursor(companyId, conversationId, id);
        if (!cursor) fail("The selected message does not belong to this conversation.", 422);
      }

      const now = clock();
      const updated: InboxParticipant = {
        ...participant,
        lastReadMessageId: cursor?.id ?? null,
        lastReadMessageCreatedAt: cursor?.createdAt ?? null,
        lastReadAt: now,
        lastSeenAt: now,
      };
      await storage.saveParticipant(companyId, updated);

      const unreadCount = await storage.countMessagesAfter(companyId, conversationId, cursorFor(updated));
      await publish("participant.read", companyId, conversationId, {
        actorId,
        participantId: updated.id,
        unreadCount,
      });
      return { participant: { ...updated, metadata: { ...updated.metadata } }, unreadCount };
    },

    async participantUnreadCount(companyIdRaw, conversationIdRaw, participantIdRaw) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      const participant = await loadParticipant(companyId, conversationId, participantIdRaw);
      return storage.countMessagesAfter(companyId, conversationId, cursorFor(participant));
    },

    async removeParticipant(companyIdRaw, conversationIdRaw, participantIdRaw, actor) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      const actorId = requireActor(actor);
      const participant = await loadParticipant(companyId, conversationId, participantIdRaw);
      const removed = await storage.deleteParticipant(companyId, conversationId, participant.id);
      if (!removed) fail("Participant not found", 404);
      await publish("participant.removed", companyId, conversationId, {
        actorId,
        participantId: participant.id,
      });
    },

    async touchPresence(companyIdRaw, conversationIdRaw, input) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      await loadConversation(companyId, conversationId);

      const body = requireBody(input, "input");
      const participantKey = requireText(body.participantKey, "participant_key", MAX_ID_LENGTH);
      const state: PresenceState = isSet(body.state)
        ? requireOneOf(body.state, PRESENCE_STATES, "state")
        : "online";
      const metadata = plainObject(body.metadata, "metadata");

      const previous = await storage.getPresence(companyId, conversationId, participantKey);
      const row: InboxPresence = {
        companyId,
        conversationId,
        participantKey,
        state,
        lastSeenAt: clock(),
        metadata,
      };
      await storage.savePresence(companyId, row);

      // Heartbeats keep the same state and produce no event. Only a change of state is announced.
      if (previous === null || previous.state !== state) {
        await publish("presence.changed", companyId, conversationId, {
          actorId: participantKey,
          participantKey,
          presenceState: state,
          from: previous?.state ?? null,
          to: state,
        });
      }
      return { ...row, metadata: { ...row.metadata } };
    },

    async activePresence(companyIdRaw, conversationIdRaw) {
      const companyId = gate(companyIdRaw);
      const conversationId = requireText(conversationIdRaw, "conversationId", MAX_ID_LENGTH);
      await loadConversation(companyId, conversationId);

      const since = new Date(clock().getTime() - presenceTtlSeconds * 1000);
      const rows = await storage.listPresenceSince(companyId, conversationId, since);
      return rows
        .filter((row) => row.state !== "offline")
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
        .map((row) => ({ ...row, metadata: { ...row.metadata } }));
    },
  };
}
