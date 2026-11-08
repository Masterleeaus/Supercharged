/**
 * Reminder dispatcher. Decides when a booking's reminder is due, and sends it through an injected ReminderSender.
 *
 * Rules:
 *  - A reminder is due at (appointment start minus leadMinutes). A booking that is already inside the lead
 *    window when it is made is due straight away.
 *  - Once per booking per channel. The ledger row for (company, appointment, channel) is claimed before the send.
 *    Any later run finds the row and skips.
 *  - Never after cancellation. The booking is read again after the claim and before the send. A cancelled or
 *    missing booking marks the ledger row cancelled and sends nothing. cancelReminders() also blocks future sends
 *    for a booking when the caller cancels it.
 *  - Bookings are read through the bookings service's public functions. This module never touches its tables.
 *
 * Known limit: a cancel that lands while the sender is already sending cannot be undone. See DECISIONS.md.
 */
import { requireCompanyId } from "../chatbot-scope.ts";
import type { BookingService } from "../bookings/index.ts";
import type { AppointmentRecord, ReminderChannel } from "../bookings/types.ts";
import { REMINDER_CHANNELS } from "../bookings/types.ts";
import type { HttpClient, ReminderSendResult, ReminderSender } from "../contracts/index.ts";
import { REMINDER_LEAD_MAX_MINUTES, REMINDER_LEAD_MIN_MINUTES, type ReminderLedgerStore } from "./types.ts";
import { MINUTE_MS } from "./util.ts";

export interface ReminderConfig {
  /** Channels to send on. Each booking gets one reminder per channel. */
  channels: ReminderChannel[];
  /** How long before the start the reminder goes out, in minutes (5 to 10080). */
  leadMinutes: number;
  /** Locale for the reminder text. Defaults to en-AU. */
  locale?: string;
}

export interface ReminderDispatcherDeps {
  bookings: Pick<BookingService, "listCalendars" | "listAppointments">;
  ledger: ReminderLedgerStore;
  /** Injected senders, one per channel. A channel with no sender is skipped. */
  senders: Partial<Record<ReminderChannel, ReminderSender>>;
  http: HttpClient;
  config: ReminderConfig;
  now?: () => Date;
}

export interface ReminderRunSummary {
  due: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface ReminderDispatcher {
  runDue(companyId: string): Promise<ReminderRunSummary>;
  /** Blocks every future reminder for this booking. Call it when the booking is cancelled. */
  cancelReminders(companyId: string, appointmentId: string): Promise<void>;
}

function validateConfig(config: ReminderConfig): Required<ReminderConfig> {
  if (
    !Number.isInteger(config.leadMinutes) ||
    config.leadMinutes < REMINDER_LEAD_MIN_MINUTES ||
    config.leadMinutes > REMINDER_LEAD_MAX_MINUTES
  ) {
    throw new RangeError("leadMinutes must be an integer from 5 to 10080");
  }
  if (!Array.isArray(config.channels) || config.channels.length === 0) {
    throw new RangeError("at least one reminder channel is required");
  }
  const seen = new Set<string>();
  for (const channel of config.channels) {
    if (!(REMINDER_CHANNELS as readonly string[]).includes(channel)) throw new RangeError("unknown reminder channel");
    if (seen.has(channel)) throw new RangeError("reminder channels must be unique");
    seen.add(channel);
  }
  return { channels: [...config.channels], leadMinutes: config.leadMinutes, locale: config.locale ?? "en-AU" };
}

/** Email goes to the email address. SMS and WhatsApp go to the phone number. Other channels have no recipient yet. */
function recipientFor(channel: ReminderChannel, appointment: AppointmentRecord): string | null {
  if (channel === "email") return appointment.customerEmail;
  if (channel === "sms" || channel === "whatsapp") return appointment.customerPhone;
  return null;
}

function reminderBody(appointment: AppointmentRecord, timezone: string, locale: string): string {
  const when = new Intl.DateTimeFormat(locale, { timeZone: timezone, dateStyle: "full", timeStyle: "short" }).format(
    appointment.startsAt,
  );
  return `Hi ${appointment.customerName}, a reminder that your appointment is on ${when} (${timezone}).`;
}

export function createReminderDispatcher(deps: ReminderDispatcherDeps): ReminderDispatcher {
  const config = validateConfig(deps.config);
  for (const [channel, sender] of Object.entries(deps.senders)) {
    if (sender && sender.channel !== channel) throw new RangeError("sender channel does not match its key");
  }
  const now = deps.now ?? (() => new Date());
  const leadMs = config.leadMinutes * MINUTE_MS;

  /** Reads the booking again. Returns null when it is gone or belongs to another calendar. */
  const freshAppointment = async (companyId: string, calendarId: string, appointment: AppointmentRecord) => {
    const rows = await deps.bookings.listAppointments(companyId, calendarId, {
      from: appointment.startsAt.toISOString(),
      to: new Date(appointment.startsAt.getTime() + MINUTE_MS).toISOString(),
    });
    return rows.find((row) => row.id === appointment.id) ?? null;
  };

  return {
    async runDue(companyId) {
      const scope = requireCompanyId(companyId);
      const current = now();
      const horizon = new Date(current.getTime() + leadMs);
      const summary: ReminderRunSummary = { due: 0, sent: 0, failed: 0, skipped: 0 };

      const calendars = await deps.bookings.listCalendars(scope);
      for (const calendar of calendars) {
        const rows = await deps.bookings.listAppointments(scope, calendar.id, {
          from: current.toISOString(),
          to: horizon.toISOString(),
        });
        for (const appointment of rows) {
          if (appointment.status !== "confirmed") continue;
          if (appointment.startsAt.getTime() <= current.getTime()) continue;
          const sendAt = new Date(appointment.startsAt.getTime() - leadMs);
          if (sendAt.getTime() > current.getTime()) continue;

          for (const channel of config.channels) {
            summary.due += 1;
            const sender = deps.senders[channel];
            const recipient = recipientFor(channel, appointment);
            if (!sender || !recipient) {
              summary.skipped += 1;
              continue;
            }

            const idempotencyKey = `${appointment.id}:${channel}:${sendAt.toISOString()}`;
            const claimed = await deps.ledger.claim(scope, appointment.id, channel, idempotencyKey, current);
            if (!claimed) {
              summary.skipped += 1;
              continue;
            }

            // The booking may have been cancelled since the list was read. Check again after the claim.
            const fresh = await freshAppointment(scope, calendar.id, appointment);
            if (!fresh || fresh.status !== "confirmed") {
              await deps.ledger.complete(scope, appointment.id, channel, { status: "cancelled" }, now());
              summary.skipped += 1;
              continue;
            }

            let result: ReminderSendResult;
            try {
              result = await sender.send(
                {
                  companyId: scope,
                  appointmentId: appointment.id,
                  channel,
                  recipient,
                  body: reminderBody(appointment, calendar.timezone, config.locale),
                  idempotencyKey,
                },
                deps.http,
              );
            } catch {
              // The sender threw, so we do not know whether it sent. Treat it as retryable. The idempotency key
              // lets a sender that honours it refuse the second attempt.
              result = { status: "failed", retryable: true, reason: "sender_error" };
            }

            if (result.status === "sent") {
              await deps.ledger.complete(scope, appointment.id, channel, {
                status: "sent",
                externalMessageId: result.externalMessageId,
              }, now());
              summary.sent += 1;
            } else if (result.retryable) {
              await deps.ledger.release(scope, appointment.id, channel);
              summary.failed += 1;
            } else {
              await deps.ledger.complete(scope, appointment.id, channel, { status: "failed", reason: result.reason }, now());
              summary.failed += 1;
            }
          }
        }
      }
      return summary;
    },

    async cancelReminders(companyId, appointmentId) {
      const scope = requireCompanyId(companyId);
      for (const channel of config.channels) {
        await deps.ledger.cancel(scope, appointmentId, channel, now());
      }
    },
  };
}
