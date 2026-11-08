/**
 * Notifications through an injected sender. The runtime validates the request, removes duplicate recipients,
 * and sends to each one. A failing recipient does not stop the others. The caller gets one error at the end,
 * which counts failures and never includes the payload.
 *
 * Port of NotificationRuntime.php. The PHP version only fired an event with no sender, so the sender is new.
 */
import type { NotificationRecipient, NotificationRuntime } from "../contracts/index.ts";
import { EventsError } from "./types.ts";

export interface NotificationSender {
  send(companyId: string, recipient: NotificationRecipient, topic: string, payload: Record<string, unknown>): Promise<void>;
}

export interface NotificationOptions {
  maxRecipients?: number;
  maxPayloadBytes?: number;
}

const TOPIC_PATTERN = /^[a-z][a-z0-9_.]{0,99}$/;
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,191}$/;

export function createNotificationRuntime(sender: NotificationSender, options: NotificationOptions = {}): NotificationRuntime {
  const maxRecipients = options.maxRecipients ?? 100;
  const maxPayloadBytes = options.maxPayloadBytes ?? 16 * 1024;

  return {
    async notify(companyId, topic, recipients, payload) {
      if (!TOPIC_PATTERN.test(topic)) throw new EventsError("VALIDATION", "Notification topic is not valid.");
      if (!Array.isArray(recipients) || recipients.length < 1 || recipients.length > maxRecipients) {
        throw new EventsError("VALIDATION", `A notification needs 1 to ${maxRecipients} recipients.`);
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new EventsError("VALIDATION", "Notification payload must be an object.");
      }
      if (Buffer.byteLength(JSON.stringify(payload), "utf8") > maxPayloadBytes) {
        throw new EventsError("VALIDATION", "Notification payload is too large.");
      }

      const unique = new Map<string, NotificationRecipient>();
      for (const recipient of recipients) {
        if ((recipient.kind !== "staff" && recipient.kind !== "customer") || !ID_PATTERN.test(recipient.id)) {
          throw new EventsError("VALIDATION", "A recipient needs a kind of staff or customer and a valid id.");
        }
        unique.set(`${recipient.kind}:${recipient.id}`, recipient);
      }

      let failed = 0;
      for (const recipient of unique.values()) {
        try {
          await sender.send(companyId, recipient, topic, payload);
        } catch {
          failed++;
        }
      }
      if (failed > 0) {
        throw new EventsError("NOTIFICATION_FAILED", `${failed} of ${unique.size} notifications could not be sent.`);
      }
    },
  };
}
