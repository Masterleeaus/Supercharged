/*
 * Turn claim store: makes sure one customer message gets one stored reply. Two implementations share one rule set.
 *
 * - claim: takes the turn if nothing holds it, or if a pending lease is older than leaseMs. Returns 'done' with the
 *   message id when the turn already has its reply.
 * - complete: marks the turn done with the stored message id.
 * - release: drops a pending claim so a retry can take the turn.
 *
 * Every row carries company_id. A row of another company is invisible to every call.
 */
import { and, eq, lt } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { chatbotReplyTurns } from "../db/runtime.ts";
import type { ReplyTurnStore, TurnClaim } from "./types.ts";

interface TurnRow {
  state: "pending" | "done";
  messageId: string | null;
  claimedAt: Date;
}

export function createMemoryReplyTurnStore(): ReplyTurnStore {
  const rows = new Map<string, TurnRow>();
  const keyOf = (companyId: string, conversationId: string, turnKey: string) => JSON.stringify([companyId, conversationId, turnKey]);

  return {
    async claim(companyId, conversationId, turnKey, now, leaseMs) {
      const key = keyOf(companyId, conversationId, turnKey);
      const existing = rows.get(key);
      if (!existing) {
        rows.set(key, { state: "pending", messageId: null, claimedAt: now });
        return { kind: "claimed" };
      }
      if (existing.state === "done") return { kind: "done", messageId: existing.messageId as string };
      if (now.getTime() - existing.claimedAt.getTime() >= leaseMs) {
        rows.set(key, { state: "pending", messageId: null, claimedAt: now });
        return { kind: "claimed" };
      }
      return { kind: "pending" } satisfies TurnClaim;
    },

    async complete(companyId, conversationId, turnKey, messageId) {
      const key = keyOf(companyId, conversationId, turnKey);
      const existing = rows.get(key);
      if (existing && existing.state === "pending") rows.set(key, { ...existing, state: "done", messageId });
    },

    async release(companyId, conversationId, turnKey) {
      const key = keyOf(companyId, conversationId, turnKey);
      const existing = rows.get(key);
      if (existing && existing.state === "pending") rows.delete(key);
    },
  };
}

/**
 * Drizzle version. Claim is one statement: an insert that, on conflict, takes over only a stale pending row.
 * If no row comes back, the turn is held by someone else, and a select tells 'done' from 'pending'.
 */
export function createDrizzleReplyTurnStore(db: PgDatabase<any, any, any>): ReplyTurnStore {
  return {
    async claim(companyId, conversationId, turnKey, now, leaseMs) {
      const cutoff = new Date(now.getTime() - leaseMs);
      const claimed = await db
        .insert(chatbotReplyTurns)
        .values({ companyId, conversationId, turnKey, state: "pending", messageId: null, claimedAt: now, completedAt: null })
        .onConflictDoUpdate({
          target: [chatbotReplyTurns.companyId, chatbotReplyTurns.conversationId, chatbotReplyTurns.turnKey],
          set: { state: "pending", claimedAt: now, messageId: null },
          setWhere: and(
            eq(chatbotReplyTurns.companyId, companyId),
            eq(chatbotReplyTurns.state, "pending"),
            lt(chatbotReplyTurns.claimedAt, cutoff),
          ),
        })
        .returning({ id: chatbotReplyTurns.turnKey });
      if (claimed.length === 1) return { kind: "claimed" };

      const [existing] = await db
        .select({ state: chatbotReplyTurns.state, messageId: chatbotReplyTurns.messageId })
        .from(chatbotReplyTurns)
        .where(and(
          eq(chatbotReplyTurns.companyId, companyId),
          eq(chatbotReplyTurns.conversationId, conversationId),
          eq(chatbotReplyTurns.turnKey, turnKey),
        ))
        .limit(1);
      if (existing?.state === "done" && existing.messageId) return { kind: "done", messageId: existing.messageId };
      return { kind: "pending" };
    },

    async complete(companyId, conversationId, turnKey, messageId, now) {
      await db
        .update(chatbotReplyTurns)
        .set({ state: "done", messageId, completedAt: now })
        .where(and(
          eq(chatbotReplyTurns.companyId, companyId),
          eq(chatbotReplyTurns.conversationId, conversationId),
          eq(chatbotReplyTurns.turnKey, turnKey),
          eq(chatbotReplyTurns.state, "pending"),
        ));
    },

    async release(companyId, conversationId, turnKey) {
      await db
        .delete(chatbotReplyTurns)
        .where(and(
          eq(chatbotReplyTurns.companyId, companyId),
          eq(chatbotReplyTurns.conversationId, conversationId),
          eq(chatbotReplyTurns.turnKey, turnKey),
          eq(chatbotReplyTurns.state, "pending"),
        ));
    },
  };
}
