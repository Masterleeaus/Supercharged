/**
 * Reminder sender adapters, one per channel. Each adapter calls the existing transport for its channel. No new
 * provider is added here.
 *
 *   email     -> the existing EmailService (comms/email-provider-adapter.ts createEmailServiceSender)
 *   whatsapp  -> the existing Twilio WhatsApp send (channels/whatsapp/outbound.ts sendTwilioWhatsapp)
 *   sms       -> no existing transport. Explicit "not_wired" failure.
 *   telegram, web -> no recipient rule and no transport. Never sent (the dispatcher skips them).
 *
 * Failure rules: an adapter returns a result and does not throw. Failure reasons are fixed codes, never provider text,
 * so no credential, URL or address reaches the ledger or the attempt log.
 */
import type {
  ChannelCredentialSource,
  HttpClient,
  OutboundMessage,
  ReminderRequest,
  ReminderSendResult,
  ReminderSender,
  SendResult,
} from "../contracts/index.ts";
import type { ReminderChannel } from "../bookings/types.ts";
import { sendTwilioWhatsapp } from "../channels/whatsapp/outbound.ts";
import type { ReminderAttemptLog } from "./reminder-attempt-log.ts";

export const REMINDER_EMAIL_SUBJECT = "Appointment reminder";

/** The email call the adapter needs. createEmailServiceSender() returns this shape. */
export type ReminderEmailSend = (message: {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
}) => Promise<{ success: boolean; error?: string; messageId?: string }>;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Email goes through the existing EmailService. A failed send is retryable: the message was not accepted. */
export function createEmailReminderSender(send: ReminderEmailSend): ReminderSender {
  return {
    channel: "email",
    async send(request: ReminderRequest): Promise<ReminderSendResult> {
      const result = await send({
        to: request.recipient,
        subject: REMINDER_EMAIL_SUBJECT,
        text: request.body,
        html: `<p>${escapeHtml(request.body)}</p>`,
        headers: { "Idempotency-Key": request.idempotencyKey },
      });
      if (result.success) return { status: "sent", externalMessageId: result.messageId ?? null };
      return { status: "failed", retryable: true, reason: "email_rejected" };
    },
  };
}

export interface WhatsappReminderDeps {
  /** The company's WhatsApp channel account id. Null when the company has none. */
  resolveAccountId(companyId: string): Promise<string | null> | string | null;
  /** Loads and decrypts the account credentials. Null when they are missing. */
  credentials: ChannelCredentialSource;
  /** Successful sends, keyed by company, sender and idempotency key. Owned by the adapter instance. */
  sentCache?: Map<string, SendResult>;
}

/**
 * WhatsApp goes through the existing Twilio send. Outside the 24 hour session window Twilio needs a template, and
 * this adapter sends free text. Those sends fail at Twilio with a non-retryable error. Template support is not wired.
 */
export function createWhatsappReminderSender(deps: WhatsappReminderDeps): ReminderSender {
  const sentCache = deps.sentCache ?? new Map<string, SendResult>();
  return {
    channel: "whatsapp",
    async send(request: ReminderRequest, http: HttpClient): Promise<ReminderSendResult> {
      const accountId = await deps.resolveAccountId(request.companyId);
      if (!accountId) return { status: "failed", retryable: false, reason: "account_not_wired" };

      const credentials = await deps.credentials.load(request.companyId, "whatsapp", accountId);
      if (!credentials) return { status: "failed", retryable: false, reason: "credentials_missing" };

      const message: OutboundMessage = {
        channel: "whatsapp",
        accountId,
        recipient: request.recipient,
        contentKind: "text",
        text: request.body,
        attachmentUrl: null,
        templateName: null,
        templateParams: null,
        replyToExternalMessageId: null,
        idempotencyKey: request.idempotencyKey,
      };
      const result = await sendTwilioWhatsapp(request.companyId, message, credentials, http, { sentCache });
      if (result.status === "sent") return { status: "sent", externalMessageId: result.externalMessageId };
      if (result.status === "queued") return { status: "sent", externalMessageId: null };
      return { status: "failed", retryable: result.retryable, reason: result.errorCode };
    },
  };
}

/** A channel with no existing transport. Every send fails with the explicit reason "not_wired". */
export function createNotWiredReminderSender(channel: ReminderChannel): ReminderSender {
  return {
    channel,
    async send(): Promise<ReminderSendResult> {
      return { status: "failed", retryable: false, reason: "not_wired" };
    },
  };
}

/**
 * Records one attempt row per send, including failures and throws. The send outcome is never changed by the log:
 * a log write error is reported through onError and ignored. A sender throw is recorded, then rethrown, so the
 * dispatcher still treats it as retryable.
 */
export function withAttemptLog(
  sender: ReminderSender,
  log: ReminderAttemptLog,
  onError: (message: string) => void = (message) => console.error(message),
): ReminderSender {
  const record = async (
    request: ReminderRequest,
    outcome: { status: "sent" | "failed" | "error"; externalMessageId: string | null; reason: string | null },
  ) => {
    try {
      const attemptNo = (await log.countAttempts(request.companyId, request.appointmentId, request.channel)) + 1;
      await log.record({
        companyId: request.companyId,
        appointmentId: request.appointmentId,
        channel: request.channel,
        attemptNo,
        status: outcome.status,
        idempotencyKey: request.idempotencyKey,
        externalMessageId: outcome.externalMessageId,
        reason: outcome.reason,
      });
    } catch (err) {
      onError(`[reminders] attempt log write failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  };

  return {
    channel: sender.channel,
    async send(request, http) {
      let result: ReminderSendResult;
      try {
        result = await sender.send(request, http);
      } catch (err) {
        await record(request, { status: "error", externalMessageId: null, reason: "sender_error" });
        throw err;
      }
      if (result.status === "sent") {
        await record(request, { status: "sent", externalMessageId: result.externalMessageId, reason: null });
      } else {
        await record(request, { status: "failed", externalMessageId: null, reason: result.reason });
      }
      return result;
    },
  };
}
