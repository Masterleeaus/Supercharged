// Telegram provider adapter: consent gate, request build, then send through an injected HTTP client.
// Pre-send refusals (consent, invalid input) throw a TelegramAdapterRefusedError whose message is the
// reason code only. Provider outcomes return a SendTelegramResult. No database, no clock reads
// (the caller passes `now`). The only I/O is the injected http.post, reached through sendTelegram.
// The bot token is never placed in a thrown message, a returned value, or a log line.

import {
  checkConsent,
  type ConsentReason,
  type Contact,
  type DateInput,
  type QuietHours,
} from './consent.ts';
import type { SuppressionList } from './suppression.ts';
import {
  NO_SEND_AUDIT,
  openSendAudit,
  type CommsEventSink,
  type CommsSendAudit,
  type CommsSendAuditOutcome,
} from './audit-sink.ts';
import {
  buildTelegramSendRequest,
  sendTelegram,
  type SendTelegramResult,
  type TelegramHttp,
  type TelegramSendRefusal,
} from './telegram-send.ts';

export type TelegramAdapterRefusal = ConsentReason | TelegramSendRefusal | 'suppressed' | 'audit_unavailable';

export class TelegramAdapterRefusedError extends Error {
  readonly reason: TelegramAdapterRefusal;

  constructor(reason: TelegramAdapterRefusal) {
    // Message is the reason code only, so no token or caller payload can leak through it.
    super(reason);
    this.name = 'TelegramAdapterRefusedError';
    this.reason = reason;
  }
}

export interface TelegramProviderAdapterConfig {
  token: string;
  http: TelegramHttp;
  /** Company suppression list. When wired, a suppressed chat or a missing companyId is refused. */
  suppression?: SuppressionList;
  /** Optional comms audit sink. When absent, a send is still made and nothing is recorded. */
  auditSink?: CommsEventSink;
}

export interface TelegramDeliveryInput {
  /** Company the send belongs to. Required for the suppression check when a list is wired. */
  companyId?: string;
  contact: Contact | null | undefined;
  chatId: string | number;
  text: string;
  replyToMessageId?: number | null;
  now: DateInput;
  quietHours?: QuietHours | null;
  /** Human or system actor for the audit event. Without it, no event is recorded. */
  actorId?: string | null;
}

export interface TelegramProviderAdapter {
  send(input: TelegramDeliveryInput): Promise<SendTelegramResult & Partial<CommsSendAuditOutcome>>;
}

function isRefusalReason(value: unknown): value is TelegramSendRefusal {
  return (
    value === 'text_too_long' ||
    value === 'empty_text' ||
    value === 'invalid_chat_id' ||
    value === 'invalid_reply_to_message_id'
  );
}

export function createTelegramProviderAdapter(
  config: TelegramProviderAdapterConfig,
): TelegramProviderAdapter {
  return {
    async send(input: TelegramDeliveryInput): Promise<SendTelegramResult & Partial<CommsSendAuditOutcome>> {
      // Suppression first. An invalid or missing companyId makes isSuppressed return true (fail closed).
      if (config.suppression && config.suppression.isSuppressed(input.companyId ?? '', {
        address: String(input.chatId),
        channel: 'telegram',
      })) {
        throw new TelegramAdapterRefusedError('suppressed');
      }

      // Quiet hours are read in the contact's own timezone (contact.timezone), not the company's.
      const decision = checkConsent({
        channel: 'telegram',
        contact: input.contact,
        now: input.now,
        quietHours: input.quietHours,
      });
      if (!decision.allowed) {
        throw new TelegramAdapterRefusedError(decision.reason);
      }

      let request: ReturnType<typeof buildTelegramSendRequest>;
      try {
        request = buildTelegramSendRequest({
          chatId: input.chatId,
          text: input.text,
          replyToMessageId: input.replyToMessageId,
        });
      } catch (error) {
        const reason = (error as { reason?: unknown } | null)?.reason;
        if (isRefusalReason(reason)) {
          throw new TelegramAdapterRefusedError(reason);
        }
        return { ok: false, reason: 'provider_error' };
      }

      // The pending audit event is written before the provider is called. If it cannot be written, nothing is sent.
      let audit: CommsSendAudit | null;
      try {
        audit = await openSendAudit(config.auditSink, {
          companyId: input.companyId ?? '',
          actorId: input.actorId,
          channel: 'telegram',
          now: () => input.now,
        });
      } catch {
        throw new TelegramAdapterRefusedError('audit_unavailable');
      }

      // sendTelegram never rethrows transport errors, so nothing from the HTTP client reaches the caller.
      const sent = await sendTelegram({ token: config.token, request, http: config.http });
      const outcome = audit ? await audit.finish(sent.ok ? 'sent' : 'provider_error') : NO_SEND_AUDIT;
      return { ...sent, ...outcome };
    },
  };
}
