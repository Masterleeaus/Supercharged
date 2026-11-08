/*
 * Email send transport for campaigns. The real sender (EmailService.sendEmail) is not imported
 * here. The composition layer passes it in as `sender`, adapted to the object shape below.
 *
 * The transport never throws. Refusals and sender failures come back as `{ ok: false, reason }`.
 * Failure details never carry a full recipient address: only the domain part can appear.
 */
import { randomUUID } from 'node:crypto';
import type { SendJob } from '../campaigns/types.ts';

export interface EmailSenderMessage {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  headers: Record<string, string>;
}

export interface EmailSenderResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

export type EmailSender = (message: EmailSenderMessage) => Promise<EmailSenderResult>;

export type EmailSendFailureReason = 'wrong_channel' | 'invalid_address' | 'sender_error';

export type EmailSendResult =
  | { ok: true; externalId: string }
  | { ok: false; reason: EmailSendFailureReason; detail?: string };

export interface EmailSendContent {
  subject: string | null;
  body: string;
}

export interface EmailSendTransport {
  send(companyId: string, job: SendJob, content: EmailSendContent): Promise<EmailSendResult>;
}

export interface EmailSendTransportOptions {
  sender: EmailSender;
  /** Domain used in the generated Message-ID header. */
  messageIdDomain?: string;
}

const DEFAULT_MESSAGE_ID_DOMAIN = 'campaigns.invalid';
const MAX_DETAIL_LENGTH = 200;

/** Replaces every local part in an address-like token with *** and keeps the domain. */
export function redactAddresses(text: string): string {
  return text.replace(/[^\s<>"'(),;:@]+@([^\s<>"'(),;:@]+)/g, '***@$1');
}

function isUsableAddress(address: unknown): address is string {
  if (typeof address !== 'string') return false;
  const trimmed = address.trim();
  const at = trimmed.indexOf('@');
  return at > 0 && at < trimmed.length - 1;
}

function describeSenderError(error: unknown): string {
  let raw: string;
  if (typeof error === 'string') raw = error;
  else if (error instanceof Error) raw = error.message || error.name;
  else raw = 'unknown error';
  const redacted = redactAddresses(raw).slice(0, MAX_DETAIL_LENGTH);
  return redacted.length > 0 ? redacted : 'unknown error';
}

export function createEmailSendTransport(options: EmailSendTransportOptions): EmailSendTransport {
  const { sender } = options;
  const domain = options.messageIdDomain ?? DEFAULT_MESSAGE_ID_DOMAIN;

  return {
    async send(_companyId, job, content) {
      try {
        if (job.channel !== 'email') {
          return { ok: false, reason: 'wrong_channel' };
        }
        if (!isUsableAddress(job.address)) {
          return { ok: false, reason: 'invalid_address' };
        }

        const to = job.address.trim();
        const messageId = `<${randomUUID()}@${domain}>`;
        const result = await sender({
          to,
          subject: content.subject ?? '',
          text: content.body,
          headers: { 'Message-ID': messageId },
        });

        if (!result || typeof result !== 'object') {
          return { ok: false, reason: 'sender_error', detail: 'sender returned no result' };
        }
        if (result.success !== true) {
          return { ok: false, reason: 'sender_error', detail: describeSenderError(result.error ?? 'send failed') };
        }
        return { ok: true, externalId: result.messageId ?? messageId };
      } catch (error) {
        return { ok: false, reason: 'sender_error', detail: describeSenderError(error) };
      }
    },
  };
}
