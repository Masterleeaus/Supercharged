/**
 * Group 03 workforce tool definitions: property issues, purchase orders, quotes, referrals, refunds, reports,
 * review alerts, reviews, safety escalation and service agreements.
 *
 * None of these tools has a company-scoped data source in this repo (see tools/READ_TOOLS.md). No table in
 * shared/schema.ts holds property issues, purchase orders, quotes, referral requests, refund requests (refunds
 * records only issued refunds), reviews, service agreements or safety escalations. So every handler returns a
 * `not_implemented` result with the reason. Nothing is invented and no external system is called.
 *
 * Side-effect tools:
 *  - purchase_orders.draft and service_agreements.draft_renewal are drafts. The registry stages any tool whose id
 *    ends in 'draft' or 'draft_*' and never runs its handler, so they use the existing draft path.
 *  - refund_requests.create and refund_requests.prepare use category 'money', and reviews.request and
 *    referral_requests.create use category 'customer_send'. The registry needs owner approval before any handler runs.
 *  - safety.escalate_to_human uses risk 'high' and needs approval (the policy gate). Its handler still returns
 *    not_implemented.
 *
 * Company scope: every handler takes the company from the caller's context (requireCompanyId) and never from input.
 * Input is parsed with a strict zod schema, so a companyId key in input is rejected.
 */
import { z } from 'zod';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { ToolDefinition, ToolSchema } from '../../runtime/tool-registry.ts';
import type { RiskTier } from '../../../modules/approvals/authority-ladder.ts';

export const GROUP03_READ_TIMEOUT_MS = 10_000;
export const GROUP03_WRITE_TIMEOUT_MS = 20_000;

export interface NotImplementedResult {
  status: 'not_implemented';
  tool: string;
  reason: string;
}

const NO_TABLE = 'no company-scoped table or data source in this repo';

const limit = z.number().int().min(1).max(50).optional();
const id = z.string().trim().min(1).max(128);
const text = (max: number) => z.string().trim().min(1).max(max);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** Zod input schema per tool id. Strict: unknown keys (companyId included) are rejected. */
export const GROUP03_INPUT_SCHEMAS = {
  'property_issues.create': z
    .object({ propertyId: id, summary: text(2000), category: text(60).optional() })
    .strict(),
  'property_issues.list': z.object({ propertyId: id, limit }).strict(),
  'property_issues.update': z
    .object({ propertyId: id, issueId: id, status: z.enum(['open', 'monitoring', 'resolved', 'referred']).optional(), note: text(2000).optional() })
    .strict(),
  'purchase_orders.draft': z
    .object({
      supplierName: text(200),
      items: z.array(z.object({ description: text(300), quantity: z.number().positive() }).strict()).min(1).max(100),
      notes: text(2000).optional(),
    })
    .strict(),
  'purchase_orders.list': z.object({ status: text(50).optional(), limit }).strict(),
  'quote_requests.create': z.object({ clientName: text(200), summary: text(2000) }).strict(),
  'quotes.list': z.object({ status: text(50).optional(), limit }).strict(),
  'referral_requests.create': z.object({ contactName: text(200), referralNote: text(2000) }).strict(),
  'refund_requests.create': z.object({ invoiceId: id, amount: text(30), reason: text(2000) }).strict(),
  'refund_requests.list': z.object({ status: text(50).optional(), limit }).strict(),
  'refund_requests.prepare': z.object({ invoiceId: id, reason: text(2000) }).strict(),
  'reports.weekly_summary': z.object({ weekStart: isoDate }).strict(),
  'review_alerts.create': z.object({ reviewId: id, summary: text(2000) }).strict(),
  'reviews.list': z.object({ limit }).strict(),
  'reviews.request': z.object({ appointmentId: id }).strict(),
  'safety.escalate_to_human': z
    .object({ summary: text(2000), urgency: z.enum(['urgent', 'immediate']) })
    .strict(),
  'service_agreements.draft_renewal': z.object({ agreementId: id }).strict(),
  'service_agreements.list': z.object({ status: text(50).optional(), limit }).strict(),
} as const;

type Group03Id = keyof typeof GROUP03_INPUT_SCHEMAS;

interface Spec {
  id: Group03Id;
  risk: RiskTier;
  access: 'read' | 'write';
  category?: 'money' | 'customer_send';
  reason: string;
  /** Field-type schema for the registry. Mirrors the zod schema above. */
  fields: ToolSchema;
}

const reason = (what: string) => `${what}: ${NO_TABLE}.`;

const SPECS: readonly Spec[] = [
  { id: 'property_issues.create', risk: 'medium', access: 'write', reason: reason('Property issues'), fields: { propertyId: { type: 'string', required: true }, summary: { type: 'string', required: true }, category: { type: 'string' } } },
  { id: 'property_issues.list', risk: 'low', access: 'read', reason: reason('Property issues'), fields: { propertyId: { type: 'string', required: true }, limit: { type: 'number' } } },
  { id: 'property_issues.update', risk: 'medium', access: 'write', reason: reason('Property issues'), fields: { propertyId: { type: 'string', required: true }, issueId: { type: 'string', required: true }, status: { type: 'string' }, note: { type: 'string' } } },
  { id: 'purchase_orders.draft', risk: 'critical', access: 'write', reason: 'Purchase orders have no table. Drafts are staged by the registry, so this handler is not reached.', fields: { supplierName: { type: 'string', required: true }, items: { type: 'array', required: true }, notes: { type: 'string' } } },
  { id: 'purchase_orders.list', risk: 'low', access: 'read', reason: reason('Purchase orders'), fields: { status: { type: 'string' }, limit: { type: 'number' } } },
  { id: 'quote_requests.create', risk: 'medium', access: 'write', reason: reason('Quote requests'), fields: { clientName: { type: 'string', required: true }, summary: { type: 'string', required: true } } },
  { id: 'quotes.list', risk: 'low', access: 'read', reason: reason('Quotes'), fields: { status: { type: 'string' }, limit: { type: 'number' } } },
  { id: 'referral_requests.create', risk: 'low', access: 'write', category: 'customer_send', reason: reason('Referral requests'), fields: { contactName: { type: 'string', required: true }, referralNote: { type: 'string', required: true } } },
  { id: 'refund_requests.create', risk: 'critical', access: 'write', category: 'money', reason: reason('Refund requests (refunds records issued refunds, not requests)'), fields: { invoiceId: { type: 'string', required: true }, amount: { type: 'string', required: true }, reason: { type: 'string', required: true } } },
  { id: 'refund_requests.list', risk: 'low', access: 'read', reason: reason('Refund requests (refunds records issued refunds, not requests)'), fields: { status: { type: 'string' }, limit: { type: 'number' } } },
  { id: 'refund_requests.prepare', risk: 'critical', access: 'write', category: 'money', reason: reason('Refund requests (refunds records issued refunds, not requests)'), fields: { invoiceId: { type: 'string', required: true }, reason: { type: 'string', required: true } } },
  { id: 'reports.weekly_summary', risk: 'low', access: 'write', reason: 'Weekly summary needs date-filtered counts and totals. The read port cannot filter invoices or payments by date and caps lists at 50 rows, so a complete figure cannot be given.', fields: { weekStart: { type: 'string', required: true } } },
  { id: 'review_alerts.create', risk: 'low', access: 'write', reason: reason('Review alerts'), fields: { reviewId: { type: 'string', required: true }, summary: { type: 'string', required: true } } },
  { id: 'reviews.list', risk: 'low', access: 'read', reason: reason('Customer reviews'), fields: { limit: { type: 'number' } } },
  { id: 'reviews.request', risk: 'critical', access: 'write', category: 'customer_send', reason: reason('Review requests (also a customer send, which needs approval)'), fields: { appointmentId: { type: 'string', required: true } } },
  { id: 'safety.escalate_to_human', risk: 'high', access: 'write', reason: reason('Safety escalations'), fields: { summary: { type: 'string', required: true }, urgency: { type: 'string', required: true } } },
  { id: 'service_agreements.draft_renewal', risk: 'medium', access: 'write', reason: 'Service agreements have no table. Drafts are staged by the registry, so this handler is not reached.', fields: { agreementId: { type: 'string', required: true } } },
  { id: 'service_agreements.list', risk: 'low', access: 'read', reason: reason('Service agreements'), fields: { status: { type: 'string' }, limit: { type: 'number' } } },
];

function notImplemented(tool: string, why: string): NotImplementedResult {
  return { status: 'not_implemented', tool, reason: why };
}

/**
 * Registry definitions for group 03. Every handler checks the company from its context, parses its input strictly,
 * and returns not_implemented, because there is no data source to read or write.
 */
export function createGroup03ToolDefinitions(): ToolDefinition[] {
  return SPECS.map((spec) => ({
    id: spec.id,
    risk: spec.risk,
    access: spec.access,
    ...(spec.category ? { category: spec.category } : {}),
    schema: spec.fields,
    timeoutMs: spec.access === 'read' ? GROUP03_READ_TIMEOUT_MS : GROUP03_WRITE_TIMEOUT_MS,
    handler: (params, context) => {
      requireCompanyId(context.companyId);
      const parsed = GROUP03_INPUT_SCHEMAS[spec.id].safeParse(params);
      if (!parsed.success) {
        const fields = parsed.error.issues.flatMap((issue) =>
          issue.code === 'unrecognized_keys' ? issue.keys : [issue.path.join('.') || '(input)'],
        );
        throw new Error(`invalid input: ${[...new Set(fields)].join(', ')}`);
      }
      return notImplemented(spec.id, spec.reason);
    },
  }));
}
