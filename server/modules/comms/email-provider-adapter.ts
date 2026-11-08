/*
 * Guards every campaign email before it reaches the real sender. Each send runs, in order:
 * the company suppression list, then the contact's consent (consent.ts), then the send itself.
 * Every message that gets through carries an unsubscribe link in its body and a
 * List-Unsubscribe header.
 *
 * EmailService is loaded only inside createEmailServiceSender, so importing this module (and
 * running its tests) never loads the mail service singleton.
 *
 * Refusals come back as { success: false, error } with a reason code only. No recipient address
 * appears in any error string. The sender's own result is returned with auditRecorded added.
 * A send writes a 'pending' audit event before the base sender runs; if that write fails, the
 * base sender is never called.
 */
import type { EmailSender, EmailSenderMessage, EmailSenderResult } from './email-send-transport.ts';
import { checkConsent, type Contact, type DateInput, type QuietHours } from './consent.ts';
import { normaliseAddress, type SuppressionList } from './suppression.ts';
import {
  NO_SEND_AUDIT,
  openSendAudit,
  type CommsEventSink,
  type CommsSendAudit,
  type CommsSendAuditOutcome,
} from './audit-sink.ts';

/** The sender returns the base result plus auditRecorded once a send has reached the audit gate. */
export type EmailSenderWithAudit = (
  message: EmailSenderMessage,
) => Promise<EmailSenderResult & Partial<CommsSendAuditOutcome>>;

export interface EmailProviderAdapterOptions {
  /** Company whose suppression list and contacts apply. One adapter serves one company. */
  companyId: string;
  suppression: SuppressionList;
  /** Looks up the contact for a normalised address. Return null when no contact is known. */
  loadContact: (address: string) => Contact | null | undefined | Promise<Contact | null | undefined>;
  /** Builds the unsubscribe URL for a normalised address. Must return an http(s) URL. */
  buildUnsubscribeUrl: (address: string) => string;
  /** The real sender, e.g. the one from createEmailServiceSender. */
  base: EmailSender;
  now?: () => DateInput;
  /** Company quiet-hours window. It is read in the contact's own timezone (contact.timezone). */
  quietHours?: QuietHours | null;
  /** Optional comms audit sink. When absent, a send is still made and nothing is recorded. */
  auditSink?: CommsEventSink;
  /** Human or system actor for the audit event. Without it, no event is recorded. */
  actorId?: string | null;
}

function refuse(error: string): EmailSenderResult {
  return { success: false, error };
}

function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || /[\s<>"]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Adds the unsubscribe link to the text and HTML bodies, and the List-Unsubscribe header. */
export function appendUnsubscribe(message: EmailSenderMessage, url: string): EmailSenderMessage {
  const linkText = `To stop these emails, unsubscribe: ${url}`;
  const linkHtml = `<p style="font-size:12px;color:#666">To stop these emails, <a href="${escapeHtml(url)}">unsubscribe</a>.</p>`;

  const baseText = message.text ?? '';
  const text = baseText.length > 0 ? `${baseText}\n\n${linkText}` : linkText;

  let html: string;
  if (message.html) {
    html = /<\/body\s*>/i.test(message.html)
      ? message.html.replace(/<\/body\s*>/i, () => `${linkHtml}</body>`)
      : `${message.html}${linkHtml}`;
  } else {
    html = `<div>${escapeHtml(baseText).replace(/\r?\n/g, '<br>')}</div>${linkHtml}`;
  }

  return {
    ...message,
    text,
    html,
    headers: { ...message.headers, 'List-Unsubscribe': `<${url}>` },
  };
}

export function createEmailProviderAdapter(options: EmailProviderAdapterOptions): EmailSenderWithAudit {
  const { companyId, suppression, loadContact, buildUnsubscribeUrl, base } = options;
  if (typeof base !== 'function') throw new TypeError('base sender is required');
  if (typeof loadContact !== 'function') throw new TypeError('loadContact is required');
  if (typeof buildUnsubscribeUrl !== 'function') throw new TypeError('buildUnsubscribeUrl is required');
  const now = options.now ?? (() => new Date());

  return async (message) => {
    let prepared: EmailSenderMessage;
    try {
      const address = normaliseAddress('email', message.to);
      if (address === null) return refuse('invalid_address');

      if (suppression.isSuppressed(companyId, { address, channel: 'email' })) {
        return refuse('suppressed');
      }

      const contact = await loadContact(address);
      const decision = checkConsent({
        channel: 'email',
        contact,
        now: now(),
        quietHours: options.quietHours,
      });
      if (!decision.allowed) return refuse(`consent_${decision.reason}`);

      const url = buildUnsubscribeUrl(address);
      if (!isSafeHttpUrl(url)) return refuse('unsubscribe_unavailable');

      prepared = appendUnsubscribe(message, url);
    } catch {
      // Any failure in the checks blocks the send. The error text is fixed and carries no address.
      return refuse('guard_error');
    }
    // The pending audit event is written before the base sender is called. If it cannot be written, nothing is sent.
    let audit: CommsSendAudit | null;
    try {
      audit = await openSendAudit(options.auditSink, {
        companyId,
        actorId: options.actorId,
        channel: 'email',
        now,
      });
    } catch {
      return { success: false, error: 'audit_unavailable', auditRecorded: false };
    }

    let result: EmailSenderResult;
    try {
      result = await base(prepared);
    } catch (error) {
      if (audit) await audit.finish('provider_error');
      throw error;
    }
    const outcome = audit ? await audit.finish(result.success ? 'sent' : 'provider_error') : NO_SEND_AUDIT;
    return { ...result, ...outcome };
  };
}

/**
 * Wraps the existing EmailService.sendEmail as an EmailSender. The service module is imported
 * here, inside the factory, so nothing loads it at import time.
 */
export async function createEmailServiceSender(): Promise<EmailSender> {
  const { emailService } = await import('../../services/email-service.ts');
  return async (message) => {
    const result = await emailService.sendEmail(message.to, message.subject, message.html ?? '', undefined, {
      text: message.text,
      headers: message.headers,
    });
    return { success: result.success, error: result.error, messageId: result.messageId };
  };
}
