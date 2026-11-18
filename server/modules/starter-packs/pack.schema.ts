// Starter pack format (#362). A pack is data: it describes how a new service business starts
// out. It never carries prices, company data or code. Companies can change any part of a pack
// after it is loaded (see load.ts).
//
// Strict objects: an unknown field is an error, so a pack cannot quietly add a price or a
// setting that the loader does not understand.

import { z } from 'zod';

export const PACK_VERTICALS = ['cleaning', 'handyman', 'pool', 'garden'] as const;

/** How a service is charged. The company sets the rate. The pack never does. */
export const PRICING_UNITS = ['visit', 'hour', 'job', 'sqm', 'each', 'month'] as const;

export const QUOTE_FIELD_TYPES = ['text', 'number', 'select', 'boolean'] as const;

export const TEMPLATE_PURPOSES = [
  'enquiry_ack',
  'quote_sent',
  'quote_followup',
  'review_request',
  'visit_reminder',
] as const;

export const TEMPLATE_CHANNELS = ['email', 'sms'] as const;

/** Connector ids a pack may suggest. The setup wizard maps these to what a business already uses. */
export const CONNECTOR_PRESET_IDS = [
  'email',
  'sms',
  'google_calendar',
  'jobber',
  'servicem8',
  'quickbooks',
  'xero',
] as const;

const ID = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/, 'id must be lowercase letters, digits and separators');
const ROLE_ID = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'role id must be a catalogue role id');

export const LeadQuestionSchema = z
  .object({
    id: ID,
    prompt: z.string().min(5).max(300),
    /** The quote field this answer fills. Must name a quoteFields key. */
    field: ID,
    required: z.boolean(),
  })
  .strict();

export const QuoteFieldSchema = z
  .object({
    key: ID,
    label: z.string().min(1).max(80),
    type: z.enum(QUOTE_FIELD_TYPES),
    required: z.boolean(),
    options: z.array(z.string().min(1).max(60)).min(1).max(20).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (f.type === 'select' && !f.options) ctx.addIssue({ code: 'custom', message: 'select fields need options' });
    if (f.type !== 'select' && f.options) ctx.addIssue({ code: 'custom', message: 'only select fields take options' });
  });

export const ServiceSchema = z
  .object({
    id: ID,
    name: z.string().min(2).max(120),
    pricingUnit: z.enum(PRICING_UNITS),
    /** Quote fields the team needs to scope this service. Each must name a quoteFields key. */
    quoteFieldKeys: z.array(ID).min(1).max(12),
  })
  .strict();

export const MessageTemplateSchema = z
  .object({
    id: ID,
    purpose: z.enum(TEMPLATE_PURPOSES),
    channel: z.enum(TEMPLATE_CHANNELS),
    subject: z.string().max(160).nullable(),
    /** Placeholders are {{name}}. Each must be filled at render time. */
    body: z.string().min(10).max(1000),
  })
  .strict();

export const ConnectorPresetSchema = z
  .object({
    connectorId: z.enum(CONNECTOR_PRESET_IDS),
    purpose: z.string().min(5).max(160),
    required: z.boolean(),
  })
  .strict();

export const PackSchema = z
  .object({
    id: ID,
    version: z.number().int().min(1).max(999),
    name: z.string().min(3).max(80),
    vertical: z.enum(PACK_VERTICALS),
    description: z.string().min(10).max(400),
    agentRoles: z.array(ROLE_ID).min(1).max(12),
    leadQuestions: z.array(LeadQuestionSchema).min(1).max(12),
    quoteFields: z.array(QuoteFieldSchema).min(1).max(24),
    services: z.array(ServiceSchema).min(1).max(20),
    messageTemplates: z.array(MessageTemplateSchema).min(1).max(12),
    connectorPresets: z.array(ConnectorPresetSchema).max(8),
    compliance: z
      .object({
        /** Shown with every marketing message. Consent is always required first. */
        text: z.array(z.string().min(10).max(300)).min(1).max(6),
        marketingNeedsOptIn: z.literal(true),
      })
      .strict(),
    fixture: z
      .object({
        demoCompanyName: z.string().min(3).max(80),
        timezone: z.string().min(3).max(64),
        /** A sample enquiry the demo tenant and the tests run through the flow. */
        enquiry: z
          .object({
            serviceId: ID,
            answers: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type Pack = z.infer<typeof PackSchema>;
export type LeadQuestion = z.infer<typeof LeadQuestionSchema>;
export type QuoteField = z.infer<typeof QuoteFieldSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type MessageTemplate = z.infer<typeof MessageTemplateSchema>;
export type ConnectorPreset = z.infer<typeof ConnectorPresetSchema>;

/**
 * Checks the schema, then the cross references: every lead question and service points at a
 * real quote field, and each message template uses only known placeholders.
 * Returns every problem found, not just the first.
 */
export function validatePack(input: unknown): { ok: true; pack: Pack } | { ok: false; errors: string[] } {
  const parsed = PackSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'pack'}: ${i.message}`) };
  }
  const pack = parsed.data;
  const errors: string[] = [];
  const fieldKeys = new Set(pack.quoteFields.map((f) => f.key));

  const seen = (label: string, ids: string[]) => {
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    for (const d of new Set(dupes)) errors.push(`${label} id ${d} is repeated`);
  };
  seen('lead question', pack.leadQuestions.map((q) => q.id));
  seen('quote field', pack.quoteFields.map((f) => f.key));
  seen('service', pack.services.map((s) => s.id));
  seen('template', pack.messageTemplates.map((t) => t.id));
  seen('agent role', pack.agentRoles);

  for (const q of pack.leadQuestions) {
    if (!fieldKeys.has(q.field)) errors.push(`lead question ${q.id} points at unknown field ${q.field}`);
  }
  for (const s of pack.services) {
    for (const k of s.quoteFieldKeys) {
      if (!fieldKeys.has(k)) errors.push(`service ${s.id} uses unknown field ${k}`);
    }
  }
  for (const t of pack.messageTemplates) {
    if (t.channel === 'sms' && t.subject !== null) errors.push(`template ${t.id}: sms has no subject`);
    for (const m of t.body.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!(ALLOWED_PLACEHOLDERS as readonly string[]).includes(m[1])) errors.push(`template ${t.id} uses unknown placeholder ${m[1]}`);
    }
  }
  const serviceIds = new Set(pack.services.map((s) => s.id));
  if (!serviceIds.has(pack.fixture.enquiry.serviceId)) {
    errors.push('fixture enquiry names an unknown service');
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, pack };
}

/** Placeholders a template may use. Anything else is a typo and is refused. */
export const ALLOWED_PLACEHOLDERS = [
  'companyName',
  'clientName',
  'serviceName',
  'quoteSummary',
  'visitTime',
  'reviewUrl',
  'bookingUrl',
  'paymentUrl',
] as const;
