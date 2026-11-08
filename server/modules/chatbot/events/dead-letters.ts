/**
 * Dead-letter view for the outbox. Read only: it lists events that used up their attempts, newest failure first.
 *
 * Every read is scoped to the company. The store filters on company_id, and the view checks it again before
 * returning a row, so a row from another company is never shown. Payloads are left out on purpose: the view
 * is for operators, and the payload can carry customer data. The lease owner is left out too.
 */
import type { OutboxStore } from "./types.ts";

export const DEAD_LETTER_DEFAULT_LIMIT = 50;
export const DEAD_LETTER_MAX_LIMIT = 200;

export interface DeadLetterEntry {
  id: string;
  topic: string;
  aggregateId: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  failedAt: Date | null;
}

export interface DeadLetterView {
  list(companyId: string, options?: { limit?: number }): Promise<DeadLetterEntry[]>;
}

/** Clamps to a whole number in 1..200. Anything that is not a finite number uses the default. */
export function clampDeadLetterLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEAD_LETTER_DEFAULT_LIMIT;
  return Math.min(DEAD_LETTER_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

export function createDeadLetterView(store: OutboxStore): DeadLetterView {
  return {
    async list(companyId, options = {}) {
      if (!companyId) return [];
      const rows = await store.listDeadLetters(companyId, clampDeadLetterLimit(options.limit));
      return rows
        .filter((row) => row.companyId === companyId && row.status === "failed")
        .map((row) => ({
          id: row.id,
          topic: row.topic,
          aggregateId: row.aggregateId,
          attempts: row.attempts,
          lastError: row.lastError,
          createdAt: row.createdAt,
          failedAt: row.failedAt,
        }));
    },
  };
}
