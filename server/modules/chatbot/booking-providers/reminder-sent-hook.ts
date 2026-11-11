/**
 * Builds the `onSent` hook for the reminder dispatcher. After a reminder is sent, the hook appends one
 * `appointment.reminder_sent` row to the company's event outbox (the same outbox the chatbot drains to
 * company-registered webhook subscriptions).
 *
 * Company-wide, not per user: the row carries only the company id, and no user id is needed. The per-user
 * webhook path (server/services/webhook-delivery) is not used here.
 *
 * Fail-safe: the hook never throws. A failing outbox write is logged and the send stays as it is. The dispatcher
 * already logs a throwing hook, so this is a second layer.
 *
 * Dedupe: one row per (company, appointment, channel). The reminder ledger already sends at most once per
 * channel, and the dedupe key makes a retried append return the first row.
 */
import type { OutboxStorage } from "../contracts/index.ts";
import type { ReminderSentEvent } from "./reminders.ts";
import { logger } from '../../../utils/logger.ts';

export const REMINDER_SENT_EVENT = "appointment.reminder_sent";

export interface ReminderSentHookDeps {
  /** The company's outbox. Build it with createOutboxStorage over the events store. */
  outbox: Pick<OutboxStorage, "append">;
  error?: (message: string) => void;
}

/** The dedupe key for one reminder. Pure. */
export function reminderSentDedupeKey(appointmentId: string, channel: string): string {
  return `${REMINDER_SENT_EVENT}:${appointmentId}:${channel}`;
}

export function createReminderSentHook(deps: ReminderSentHookDeps): (event: ReminderSentEvent) => Promise<void> {
  const warn = deps.warn ?? ((message: string) => logger.warn(message));
  const error = deps.error ?? ((message: string) => logger.error(message));

  return async (event) => {
    try {
      const sentAt = event.sentAt.toISOString();
      await deps.outbox.append(event.companyId, {
        companyId: event.companyId,
        topic: REMINDER_SENT_EVENT,
        aggregateId: event.appointmentId,
        dedupeKey: reminderSentDedupeKey(event.appointmentId, event.channel),
        availableAt: event.sentAt,
        payload: {
          companyId: event.companyId,
          appointmentId: event.appointmentId,
          channel: event.channel,
          sentAt,
        },
      });
    } catch (err) {
      error(`[reminders] ${REMINDER_SENT_EVENT} outbox write failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  };
}
