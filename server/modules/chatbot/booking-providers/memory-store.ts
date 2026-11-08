/**
 * In-memory link and reminder ledger for tests and local runs. Same rules as the Drizzle store: every
 * method takes companyId, and a row from another company is treated as absent.
 */
import { randomUUID } from "node:crypto";
import { requireCompanyId } from "../chatbot-scope.ts";
import type { CalendarProviderKey } from "../contracts/index.ts";
import type {
  ExternalWindow,
  NewProviderLink,
  ProviderLinkRecord,
  ProviderLinkStore,
  ReminderLedgerStore,
  ReminderOutcome,
  ReminderSendRecord,
} from "./types.ts";

export interface MemoryProviderStore {
  links: ProviderLinkStore;
  ledger: ReminderLedgerStore;
}

export function createMemoryProviderStore(): MemoryProviderStore {
  const links = new Map<string, ProviderLinkRecord>();
  const sends = new Map<string, ReminderSendRecord>();

  const linkKey = (companyId: string, provider: CalendarProviderKey, externalBookingId: string) =>
    `${companyId}|${provider}|${externalBookingId}`;
  const sendKey = (companyId: string, appointmentId: string, channel: string) =>
    `${companyId}|${appointmentId}|${channel}`;

  const linkStore: ProviderLinkStore = {
    async insertLink(companyId, input: NewProviderLink, now: Date) {
      const scope = requireCompanyId(companyId);
      const key = linkKey(scope, input.provider, input.externalBookingId);
      const existing = links.get(key);
      if (existing) return { ...existing, startsAt: new Date(existing.startsAt), endsAt: new Date(existing.endsAt) };
      const record: ProviderLinkRecord = {
        id: randomUUID(),
        companyId: scope,
        chatbotId: input.chatbotId,
        provider: input.provider,
        externalEventTypeId: input.externalEventTypeId,
        externalBookingId: input.externalBookingId,
        appointmentId: input.appointmentId,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        status: "active",
        manageUrl: input.manageUrl,
        createdAt: now,
        updatedAt: now,
      };
      links.set(key, record);
      return { ...record };
    },

    async listLinks(companyId, provider, window: ExternalWindow) {
      const scope = requireCompanyId(companyId);
      return [...links.values()]
        .filter(
          (l) =>
            l.companyId === scope &&
            l.provider === provider &&
            l.startsAt.getTime() < window.to.getTime() &&
            l.endsAt.getTime() > window.from.getTime(),
        )
        .map((l) => ({ ...l }));
    },

    async setLinkStatus(companyId, provider, externalBookingId, status, now) {
      const scope = requireCompanyId(companyId);
      const record = links.get(linkKey(scope, provider, externalBookingId));
      if (!record) return false;
      record.status = status;
      record.updatedAt = now;
      return true;
    },
  };

  const ledger: ReminderLedgerStore = {
    async claim(companyId, appointmentId, channel, idempotencyKey, now) {
      const scope = requireCompanyId(companyId);
      const key = sendKey(scope, appointmentId, channel);
      if (sends.has(key)) return false;
      sends.set(key, {
        companyId: scope,
        appointmentId,
        channel,
        status: "sending",
        idempotencyKey,
        externalMessageId: null,
        reason: null,
        updatedAt: now,
      });
      return true;
    },

    async complete(companyId, appointmentId, channel, outcome: ReminderOutcome, now) {
      const scope = requireCompanyId(companyId);
      const record = sends.get(sendKey(scope, appointmentId, channel));
      if (!record) return;
      record.status = outcome.status;
      record.updatedAt = now;
      if (outcome.status === "sent") record.externalMessageId = outcome.externalMessageId;
      if (outcome.status === "failed") record.reason = outcome.reason;
      if (outcome.status === "cancelled") record.reason = "appointment_cancelled";
    },

    async release(companyId, appointmentId, channel) {
      const scope = requireCompanyId(companyId);
      const key = sendKey(scope, appointmentId, channel);
      if (sends.get(key)?.status === "sending") sends.delete(key);
    },

    async cancel(companyId, appointmentId, channel, now) {
      const scope = requireCompanyId(companyId);
      const key = sendKey(scope, appointmentId, channel);
      if (sends.has(key)) return;
      sends.set(key, {
        companyId: scope,
        appointmentId,
        channel,
        status: "cancelled",
        idempotencyKey: "",
        externalMessageId: null,
        reason: "appointment_cancelled",
        updatedAt: now,
      });
    },

    async find(companyId, appointmentId, channel) {
      const scope = requireCompanyId(companyId);
      const record = sends.get(sendKey(scope, appointmentId, channel));
      return record ? { ...record } : null;
    },
  };

  return { links: linkStore, ledger };
}
