/**
 * Builds the `onSent` hook for the reminder dispatcher. After a reminder is sent, the hook fires the
 * `appointment.reminder_sent` flow event through the existing trigger function.
 *
 * Fail-safe: the hook never throws. A missing user id, a failing resolver or a failing trigger is logged and the
 * send stays as it is. The dispatcher already logs a throwing hook, so this is a second layer.
 *
 * No user id is invented here. Chatbot appointments carry no user id (AppointmentRecord has companyId only), and
 * the webhook trigger looks up subscriptions by user id. The caller must supply resolveUserId. When it returns
 * null, the event is skipped with a warning.
 */
import type { ReminderSentEvent } from "./reminders.ts";
import { logger } from '../../../utils/logger.ts';

export const REMINDER_SENT_EVENT = "appointment.reminder_sent";

export type ReminderSentTrigger = (
  companyId: string,
  userId: string,
  event: string,
  data: Record<string, unknown>,
) => Promise<void> | void;

export interface ReminderSentHookDeps {
  /** The flow trigger, for example webhookDeliveryService.triggerEvent bound to its service. */
  triggerEvent: ReminderSentTrigger;
  /** Returns the user id to fire the event for, or null when none is known. */
  resolveUserId: (companyId: string) => Promise<string | null> | string | null;
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

export function createReminderSentHook(deps: ReminderSentHookDeps): (event: ReminderSentEvent) => Promise<void> {
  const warn = deps.warn ?? ((message: string) => logger.warn(message));
  const error = deps.error ?? ((message: string) => logger.error(message));

  return async (event) => {
    try {
      const userId = await deps.resolveUserId(event.companyId);
      if (!userId) {
        warn(`[reminders] ${REMINDER_SENT_EVENT} skipped: no user id for company ${event.companyId}`);
        return;
      }
      await deps.triggerEvent(event.companyId, userId, REMINDER_SENT_EVENT, {
        appointmentId: event.appointmentId,
        channel: event.channel,
        sentAt: event.sentAt.toISOString(),
      });
    } catch (err) {
      error(`[reminders] ${REMINDER_SENT_EVENT} trigger failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  };
}
