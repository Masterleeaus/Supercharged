/**
 * Composes the reminder dispatcher for production: the dispatcher, the sender adapters (each wrapped in the attempt
 * log), and the onSent hook that appends appointment.reminder_sent to the company outbox.
 *
 * Nothing here runs by itself. The boot path builds it only when CHATBOT_REMINDERS_ENABLED is "true", and the
 * workers runner calls runDue on its tick.
 */
import type { OutboxStorage, ReminderSender } from "../contracts/index.ts";
import type { ReminderChannel } from "../bookings/types.ts";
import type { ReminderLedgerStore } from "./types.ts";
import { createReminderDispatcher, type ReminderConfig, type ReminderDispatcher, type ReminderDispatcherDeps } from "./reminders.ts";
import { createReminderSentHook } from "./reminder-sent-hook.ts";
import type { ReminderAttemptLog } from "./reminder-attempt-log.ts";
import { withAttemptLog } from "./reminder-senders.ts";

export interface ReminderPipelineDeps {
  bookings: ReminderDispatcherDeps["bookings"];
  ledger: ReminderLedgerStore;
  attemptLog: ReminderAttemptLog;
  /** One sender per channel. Each one is wrapped in the attempt log here. */
  senders: Partial<Record<ReminderChannel, ReminderSender>>;
  outbox: Pick<OutboxStorage, "append">;
  http: ReminderDispatcherDeps["http"];
  config: ReminderConfig;
  now?: () => Date;
  onLogError?: (message: string) => void;
}

export function createReminderPipeline(deps: ReminderPipelineDeps): ReminderDispatcher {
  const senders: ReminderDispatcherDeps["senders"] = {};
  for (const channel of Object.keys(deps.senders) as ReminderChannel[]) {
    const sender = deps.senders[channel];
    if (sender) senders[channel] = withAttemptLog(sender, deps.attemptLog, deps.onLogError);
  }
  return createReminderDispatcher({
    bookings: deps.bookings,
    ledger: deps.ledger,
    senders,
    http: deps.http,
    config: deps.config,
    now: deps.now,
    onSent: createReminderSentHook({ outbox: deps.outbox }),
  });
}
