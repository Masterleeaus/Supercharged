/**
 * Per-attempt record for reminder sends. One row is written for every send attempt, including retryable failures.
 * The once-per-booking gate stays on the ledger (chatbot_booking_reminder_sends). This log only records history.
 *
 * Every write is scoped by company_id. A write error is reported to the caller and never changes the send outcome
 * (see withAttemptLog in reminder-senders.ts).
 */
import { and, eq, sql } from "drizzle-orm";
import { requireCompanyId } from "../chatbot-scope.ts";
import type { BookingProvidersDb } from "./drizzle-store.ts";
import { chatbotBookingReminderAttempts } from "./db.ts";

export type ReminderAttemptStatus = "sent" | "failed" | "error";

export interface ReminderAttemptEntry {
  companyId: string;
  appointmentId: string;
  channel: string;
  attemptNo: number;
  status: ReminderAttemptStatus;
  idempotencyKey: string;
  externalMessageId: string | null;
  reason: string | null;
}

export interface ReminderAttemptLog {
  /** Number of attempts already recorded for this booking and channel. */
  countAttempts(companyId: string, appointmentId: string, channel: string): Promise<number>;
  record(entry: ReminderAttemptEntry): Promise<void>;
}

export function createMemoryAttemptLog(): ReminderAttemptLog & { entries: ReminderAttemptEntry[] } {
  const entries: ReminderAttemptEntry[] = [];
  return {
    entries,
    async countAttempts(companyId, appointmentId, channel) {
      return entries.filter((e) => e.companyId === companyId && e.appointmentId === appointmentId && e.channel === channel).length;
    },
    async record(entry) {
      entries.push({ ...entry });
    },
  };
}

export function createDrizzleAttemptLog(db: BookingProvidersDb): ReminderAttemptLog {
  const table = chatbotBookingReminderAttempts;
  return {
    async countAttempts(companyId, appointmentId, channel) {
      const rows = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(and(eq(table.companyId, requireCompanyId(companyId)), eq(table.appointmentId, appointmentId), eq(table.channel, channel)));
      return rows[0]?.n ?? 0;
    },
    async record(entry) {
      await db.insert(table).values({
        companyId: requireCompanyId(entry.companyId),
        appointmentId: entry.appointmentId,
        channel: entry.channel,
        attemptNo: entry.attemptNo,
        status: entry.status,
        idempotencyKey: entry.idempotencyKey,
        externalMessageId: entry.externalMessageId,
        reason: entry.reason,
      });
    },
  };
}
