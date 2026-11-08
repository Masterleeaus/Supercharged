/**
 * Drizzle implementation of the link and reminder ledger stores, over the tables in ./db.ts.
 *
 * The query builders are exported so tests can render them to SQL without a database. Every builder takes the
 * company id and puts it in the WHERE clause (or the insert values). Nothing runs at import time.
 */
import { and, eq, gt, lt } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { requireCompanyId } from "../chatbot-scope.ts";
import type { CalendarProviderKey } from "../contracts/index.ts";
import { chatbotBookingReminderSends, chatbotExternalBookings } from "./db.ts";
import type {
  ExternalWindow,
  LinkStatus,
  NewProviderLink,
  ProviderLinkRecord,
  ProviderLinkStore,
  ReminderLedgerStore,
  ReminderOutcome,
  ReminderSendRecord,
} from "./types.ts";

export type BookingProvidersDb = NodePgDatabase<Record<string, unknown>>;

export const providerQueries = {
  insertLink(db: BookingProvidersDb, companyId: string, input: NewProviderLink, now: Date) {
    return db
      .insert(chatbotExternalBookings)
      .values({
        companyId,
        chatbotId: input.chatbotId,
        provider: input.provider,
        externalEventTypeId: input.externalEventTypeId,
        externalBookingId: input.externalBookingId,
        appointmentId: input.appointmentId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        status: "active",
        manageUrl: input.manageUrl,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [chatbotExternalBookings.companyId, chatbotExternalBookings.provider, chatbotExternalBookings.externalBookingId],
      })
      .returning();
  },

  selectLink(db: BookingProvidersDb, companyId: string, provider: CalendarProviderKey, externalBookingId: string) {
    return db
      .select()
      .from(chatbotExternalBookings)
      .where(
        and(
          eq(chatbotExternalBookings.companyId, companyId),
          eq(chatbotExternalBookings.provider, provider),
          eq(chatbotExternalBookings.externalBookingId, externalBookingId),
        ),
      )
      .limit(1);
  },

  listLinks(db: BookingProvidersDb, companyId: string, provider: CalendarProviderKey, window: ExternalWindow) {
    return db
      .select()
      .from(chatbotExternalBookings)
      .where(
        and(
          eq(chatbotExternalBookings.companyId, companyId),
          eq(chatbotExternalBookings.provider, provider),
          lt(chatbotExternalBookings.startsAt, window.to),
          gt(chatbotExternalBookings.endsAt, window.from),
        ),
      );
  },

  setLinkStatus(
    db: BookingProvidersDb,
    companyId: string,
    provider: CalendarProviderKey,
    externalBookingId: string,
    status: LinkStatus,
    now: Date,
  ) {
    return db
      .update(chatbotExternalBookings)
      .set({ status, updatedAt: now })
      .where(
        and(
          eq(chatbotExternalBookings.companyId, companyId),
          eq(chatbotExternalBookings.provider, provider),
          eq(chatbotExternalBookings.externalBookingId, externalBookingId),
        ),
      )
      .returning({ id: chatbotExternalBookings.id });
  },

  claimReminder(
    db: BookingProvidersDb,
    companyId: string,
    appointmentId: string,
    channel: string,
    idempotencyKey: string,
    now: Date,
  ) {
    return db
      .insert(chatbotBookingReminderSends)
      .values({ companyId, appointmentId, channel, status: "sending", idempotencyKey, createdAt: now, updatedAt: now })
      .onConflictDoNothing({
        target: [
          chatbotBookingReminderSends.companyId,
          chatbotBookingReminderSends.appointmentId,
          chatbotBookingReminderSends.channel,
        ],
      })
      .returning({ id: chatbotBookingReminderSends.id });
  },

  completeReminder(
    db: BookingProvidersDb,
    companyId: string,
    appointmentId: string,
    channel: string,
    outcome: ReminderOutcome,
    now: Date,
  ) {
    return db
      .update(chatbotBookingReminderSends)
      .set({
        status: outcome.status,
        externalMessageId: outcome.status === "sent" ? outcome.externalMessageId : null,
        reason: outcome.status === "failed" ? outcome.reason : outcome.status === "cancelled" ? "appointment_cancelled" : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(chatbotBookingReminderSends.companyId, companyId),
          eq(chatbotBookingReminderSends.appointmentId, appointmentId),
          eq(chatbotBookingReminderSends.channel, channel),
        ),
      );
  },

  releaseReminder(db: BookingProvidersDb, companyId: string, appointmentId: string, channel: string) {
    return db
      .delete(chatbotBookingReminderSends)
      .where(
        and(
          eq(chatbotBookingReminderSends.companyId, companyId),
          eq(chatbotBookingReminderSends.appointmentId, appointmentId),
          eq(chatbotBookingReminderSends.channel, channel),
          eq(chatbotBookingReminderSends.status, "sending"),
        ),
      );
  },

  cancelReminder(db: BookingProvidersDb, companyId: string, appointmentId: string, channel: string, now: Date) {
    return db
      .insert(chatbotBookingReminderSends)
      .values({
        companyId,
        appointmentId,
        channel,
        status: "cancelled",
        idempotencyKey: "",
        reason: "appointment_cancelled",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({
        target: [
          chatbotBookingReminderSends.companyId,
          chatbotBookingReminderSends.appointmentId,
          chatbotBookingReminderSends.channel,
        ],
      });
  },

  selectReminder(db: BookingProvidersDb, companyId: string, appointmentId: string, channel: string) {
    return db
      .select()
      .from(chatbotBookingReminderSends)
      .where(
        and(
          eq(chatbotBookingReminderSends.companyId, companyId),
          eq(chatbotBookingReminderSends.appointmentId, appointmentId),
          eq(chatbotBookingReminderSends.channel, channel),
        ),
      )
      .limit(1);
  },
};

function toLink(row: typeof chatbotExternalBookings.$inferSelect): ProviderLinkRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    chatbotId: row.chatbotId,
    provider: row.provider as CalendarProviderKey,
    externalEventTypeId: row.externalEventTypeId,
    externalBookingId: row.externalBookingId,
    appointmentId: row.appointmentId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status as LinkStatus,
    manageUrl: row.manageUrl,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSend(row: typeof chatbotBookingReminderSends.$inferSelect): ReminderSendRecord {
  return {
    companyId: row.companyId,
    appointmentId: row.appointmentId,
    channel: row.channel,
    status: row.status as ReminderSendRecord["status"],
    idempotencyKey: row.idempotencyKey,
    externalMessageId: row.externalMessageId,
    reason: row.reason,
    updatedAt: row.updatedAt,
  };
}

export function createDrizzleProviderStore(db: BookingProvidersDb): {
  links: ProviderLinkStore;
  ledger: ReminderLedgerStore;
} {
  const links: ProviderLinkStore = {
    async insertLink(companyId, input, now) {
      const scope = requireCompanyId(companyId);
      const inserted = await providerQueries.insertLink(db, scope, input, now);
      if (inserted.length > 0) return toLink(inserted[0]!);
      const existing = await providerQueries.selectLink(db, scope, input.provider, input.externalBookingId);
      if (existing.length === 0) throw new Error("link insert conflicted but no row was found");
      return toLink(existing[0]!);
    },
    async listLinks(companyId, provider, window) {
      const rows = await providerQueries.listLinks(db, requireCompanyId(companyId), provider, window);
      return rows.map(toLink);
    },
    async setLinkStatus(companyId, provider, externalBookingId, status, now) {
      const rows = await providerQueries.setLinkStatus(db, requireCompanyId(companyId), provider, externalBookingId, status, now);
      return rows.length > 0;
    },
  };

  const ledger: ReminderLedgerStore = {
    async claim(companyId, appointmentId, channel, idempotencyKey, now) {
      const rows = await providerQueries.claimReminder(db, requireCompanyId(companyId), appointmentId, channel, idempotencyKey, now);
      return rows.length > 0;
    },
    async complete(companyId, appointmentId, channel, outcome, now) {
      await providerQueries.completeReminder(db, requireCompanyId(companyId), appointmentId, channel, outcome, now);
    },
    async release(companyId, appointmentId, channel) {
      await providerQueries.releaseReminder(db, requireCompanyId(companyId), appointmentId, channel);
    },
    async cancel(companyId, appointmentId, channel, now) {
      await providerQueries.cancelReminder(db, requireCompanyId(companyId), appointmentId, channel, now);
    },
    async find(companyId, appointmentId, channel) {
      const rows = await providerQueries.selectReminder(db, requireCompanyId(companyId), appointmentId, channel);
      return rows[0] ? toSend(rows[0]) : null;
    },
  };

  return { links, ledger };
}
