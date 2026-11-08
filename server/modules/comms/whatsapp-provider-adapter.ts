// WhatsApp provider adapter. Applies the send rules, then hands the built request to sendWhatsApp.
//
// Rules, checked in order:
// 1. An opted-out WhatsApp contact is refused (checkConsent reason 'opted_out').
// 1a. A MARKETING send also needs a recorded WhatsApp opt-in. A contact with no consent record,
//    or with records that grant no WhatsApp opt-in, is refused ('opt_in_required').
//    A TRANSACTIONAL send (the default) does not need an opt-in and is not refused by this rule.
// 2. Free-form text is sent only inside the 24-hour customer-service window (whatsapp-window.ts).
// 3. Outside the window, only an approved template defined through template-rules.ts may be sent.
//    Its values are rendered with renderTemplate, so an unapproved or unsafe template is refused.
//
// The HTTP client is injected. sendWhatsApp never throws, and neither does this adapter.

import { checkConsent, type Contact, type QuietHours } from './consent.ts';
import { decideWhatsAppSend, type WindowTime } from './whatsapp-window.ts';
import { buildWhatsAppRequest, sendWhatsApp, type WhatsAppHttp } from './whatsapp-send.ts';
import { renderTemplate, type RenderRefusalReason, type Template } from './template-rules.ts';
import type { SuppressionList } from './suppression.ts';
import {
  NO_SEND_AUDIT,
  openSendAudit,
  type CommsEventSink,
  type CommsSendAudit,
  type CommsSendAuditOutcome,
} from './audit-sink.ts';

export interface WhatsAppAdapterConfig {
  phoneNumberId: string;
  accessToken: string;
  http: WhatsAppHttp;
  company: string;
  /** Company id for the suppression check. Required when `suppression` is wired (missing means refuse). */
  companyId?: string;
  /** Company suppression list. When wired, a suppressed recipient is refused before any request. */
  suppression?: SuppressionList;
  /** Optional comms audit sink. When absent, a send is still made and nothing is recorded. */
  auditSink?: CommsEventSink;
}

export interface WhatsAppAdapterTemplate {
  template: Template;
  templateName: string;
  templateLanguage: string;
  values: Record<string, unknown>;
}

/** 'marketing' needs a recorded WhatsApp opt-in. 'transactional' (the default) does not. */
export type WhatsAppMessagePurpose = 'marketing' | 'transactional';

export interface WhatsAppAdapterMessage {
  to: string;
  contact: Contact | null | undefined;
  purpose?: WhatsAppMessagePurpose;
  now: WindowTime;
  lastInboundAt: WindowTime | null | undefined;
  text?: string;
  template?: WhatsAppAdapterTemplate;
  /** Company quiet-hours window. It is read in the contact's own timezone (contact.timezone). */
  quietHours?: QuietHours | null;
  /** Human or system actor for the audit event. Without it, no event is recorded. */
  actorId?: string | null;
}

export type WhatsAppAdapterRefusalReason =
  | 'suppressed'
  | 'invalid_company'
  | 'opted_out'
  | 'quiet_hours'
  | 'invalid_contact'
  | 'opt_in_required'
  | 'invalid_purpose'
  | 'window_closed'
  | 'clock_skew'
  | 'template_required'
  | 'template_channel_mismatch'
  | 'template_rejected'
  | 'invalid_message'
  | 'invalid_text'
  | 'invalid_recipient'
  | 'invalid_sender'
  | 'invalid_template'
  | 'invalid_variable'
  | 'invalid_token'
  | 'invalid_request'
  | 'audit_unavailable'
  | 'provider_error';

/** Results of a send that reached the audit gate carry auditRecorded. Earlier refusals do not. */
export type WhatsAppAdapterResult = (
  | { ok: true; externalId: string }
  | { ok: false; reason: WhatsAppAdapterRefusalReason; names?: string[] }
) &
  Partial<CommsSendAuditOutcome>;

export interface WhatsAppProviderAdapter {
  send(message: WhatsAppAdapterMessage): Promise<WhatsAppAdapterResult>;
}

const RENDER_REFUSAL_REASONS: Record<RenderRefusalReason, WhatsAppAdapterRefusalReason> = {
  template_not_approved: 'template_rejected',
  template_not_defined: 'template_rejected',
  missing_variable: 'template_rejected',
  unknown_variable: 'template_rejected',
  invalid_value: 'template_rejected',
  link_not_allowed: 'template_rejected',
  contact_not_allowed: 'template_rejected',
};

function refuse(reason: WhatsAppAdapterRefusalReason, names?: string[]): WhatsAppAdapterResult {
  return names && names.length > 0 ? { ok: false, reason, names } : { ok: false, reason };
}

export function createWhatsAppProviderAdapter(config: WhatsAppAdapterConfig): WhatsAppProviderAdapter {
  return {
    async send(message: WhatsAppAdapterMessage): Promise<WhatsAppAdapterResult> {
      try {
        if (!message || typeof message !== 'object') return refuse('invalid_message');

        const purpose = message.purpose ?? 'transactional';
        if (purpose !== 'marketing' && purpose !== 'transactional') return refuse('invalid_purpose');

        if (config.suppression) {
          if (typeof config.companyId !== 'string') return refuse('invalid_company');
          if (config.suppression.isSuppressed(config.companyId, { address: message.to, channel: 'whatsapp' })) {
            return refuse('suppressed');
          }
        }

        // Quiet hours are read in the contact's own timezone (contact.timezone), not the company's.
        const consent = checkConsent({
          channel: 'whatsapp',
          contact: message.contact,
          now: message.now,
          quietHours: message.quietHours,
        });
        if (!consent.allowed && consent.reason === 'opted_out') {
          return refuse('opted_out');
        }
        // Quiet hours apply to every purpose. An unreadable recipient timezone under a window fails closed.
        if (!consent.allowed && consent.reason === 'quiet_hours') return refuse('quiet_hours');
        if (!consent.allowed && consent.reason === 'invalid_contact' && message.quietHours) {
          return refuse('invalid_contact');
        }
        // Marketing needs an explicit WhatsApp opt-in on record. Any other refusal of consent
        // (no record, or no record for this channel, or an invalid contact) means no opt-in.
        if (purpose === 'marketing' && !consent.allowed) {
          return refuse('opt_in_required');
        }

        const hasText = typeof message.text === 'string';
        const hasTemplate = message.template !== undefined && message.template !== null;

        let decision;
        let variables: string[] | undefined;
        let templateName: string | undefined;
        let templateLanguage: string | undefined;

        if (hasTemplate) {
          const t = message.template as WhatsAppAdapterTemplate;
          if (t.template.channel !== 'whatsapp') return refuse('template_channel_mismatch');

          const rendered = renderTemplate(t.template, t.values, { company: config.company });
          if (!rendered.ok) return refuse(RENDER_REFUSAL_REASONS[rendered.reason], rendered.names);

          // Positional body parameters follow the declared variable order.
          variables = t.template.variables.map((name) => String(t.values[name]));
          templateName = t.templateName;
          templateLanguage = t.templateLanguage;
          // A template may be sent inside or outside the window, so it is always the template path.
          decision = { send: 'template' as const };
        } else {
          decision = decideWhatsAppSend({
            lastInboundAt: message.lastInboundAt,
            now: message.now,
            templateApproved: false,
            body: hasText ? (message.text as string) : '',
          });
          if (decision.send === 'refuse') {
            return decision.reason === 'clock_skew'
              ? refuse('clock_skew')
              : refuse('window_closed');
          }
          if (decision.send !== 'free_form') return refuse('template_required');
          if (!hasText) return refuse('invalid_text');
        }

        const build = buildWhatsAppRequest({
          phoneNumberId: config.phoneNumberId,
          to: message.to,
          decision,
          text: hasTemplate ? undefined : message.text,
          templateName,
          templateLanguage,
          variables,
          purpose,
          contact: message.contact,
        });
        if (!build.ok) return refuse(build.reason);

        // The pending audit event is written before the provider is called. If it cannot be written, nothing is sent.
        let audit: CommsSendAudit | null;
        try {
          audit = await openSendAudit(config.auditSink, {
            companyId: config.companyId ?? '',
            actorId: message.actorId,
            channel: 'whatsapp',
            now: () => message.now,
          });
        } catch {
          return { ...refuse('audit_unavailable'), auditRecorded: false };
        }

        const sent = await sendWhatsApp({
          accessToken: config.accessToken,
          request: { url: build.url, body: build.body },
          http: config.http,
        });
        const outcome = audit ? await audit.finish(sent.ok ? 'sent' : 'provider_error') : NO_SEND_AUDIT;
        if (!sent.ok) return { ...refuse(sent.reason), ...outcome };
        return { ok: true, externalId: sent.externalId, ...outcome };
      } catch {
        return refuse('provider_error');
      }
    },
  };
}
