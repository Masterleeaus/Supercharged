/**
 * Group 00 workforce tools: definitions for 18 declared tool ids.
 *
 * None of these ids has a company-scoped table or storage method in this repo (see tools/READ_TOOLS.md), and none of
 * them can be mapped onto an existing table without changing what the tool means. So every handler here validates its
 * input and returns a `not_implemented` result with the reason. No handler reads or writes data, and none calls an
 * external provider.
 *
 * Side-effect tools (messages to customers, on-call pages, compliance reminders) are declared with the category and
 * risk that make the registry's approval gate hold each call for a human decision before the handler runs. Even after
 * approval the handler returns `not_implemented`, so nothing is sent.
 *
 * companyId comes only from the registry context. The strict input schemas reject any companyId key in the body.
 */
import { z } from 'zod';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { ToolDefinition, ToolSchema } from '../../runtime/tool-registry.ts';
import { ReadToolInputError } from '../read-handlers.ts';

const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 20_000;

type Access = 'read' | 'write';
type Risk = 'low' | 'medium' | 'high' | 'critical';
type Category = 'money' | 'customer_send' | 'delete' | 'other';

interface Group00Spec {
  id: string;
  access: Access;
  risk: Risk;
  category?: Category;
  timeoutMs: number;
  input: z.ZodType<Record<string, unknown>>;
  schema: ToolSchema;
  reason: string;
}

// ---- Shared zod pieces ------------------------------------------------------------------------------------------

const id = z.string().trim().min(1).max(128);
const text = (max: number) => z.string().trim().min(1).max(max);
const limit = z.number().int().min(1).max(50).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const channel = z.enum(['sms', 'email']);
const email = z.string().trim().max(320).email();

// Reasons. Each names the missing source so the caller can see why nothing was returned.
const NO_CLIENTS_TABLE =
  'No customer (clients) table in shared/schema.ts. contacts are campaign call targets and leads are inbound enquiries; mapping either would change the tool.';
const NO_TABLE = (what: string) => `No ${what} table or storage method in this repo.`;
const SEND_NOT_WIRED =
  'Outbound sends are not wired in this pass. The approval gate holds this call for a human decision; after approval nothing is sent.';

// ---- Specs ----------------------------------------------------------------------------------------------------

const SPECS: Group00Spec[] = [
  {
    id: 'after_hours.page_on_call',
    access: 'write',
    risk: 'high',
    timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ reason: text(500), urgency: z.enum(['normal', 'urgent']).optional() }).strict(),
    schema: { reason: { type: 'string', required: true }, urgency: { type: 'string' } },
    reason: `${SEND_NOT_WIRED} No on-call paging provider is wired.`,
  },
  {
    id: 'agreements.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    input: z.object({ status: text(50).optional(), limit }).strict(),
    schema: { status: { type: 'string' }, limit: { type: 'number' } },
    reason: NO_TABLE('service or membership agreements'),
  },
  {
    id: 'agreements.renewal_draft',
    access: 'write',
    risk: 'low',
    category: 'other',
    timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ agreementId: id }).strict(),
    schema: { agreementId: { type: 'string', required: true } },
    reason: NO_TABLE('service or membership agreements, so there is no record to draft a renewal from'),
  },
  {
    id: 'availability.read',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    input: z
      .object({ date: isoDate, durationMinutes: z.number().int().min(5).max(480).optional() })
      .strict(),
    schema: { date: { type: 'string', required: true }, durationMinutes: { type: 'number' } },
    reason:
      'No company-scoped working hours or capacity rules. appointment_settings is keyed by user_id, not company_id.',
  },
  {
    id: 'booking_requests.create',
    access: 'write',
    risk: 'medium',
    category: 'other',
    timeoutMs: WRITE_TIMEOUT_MS,
    input: z
      .object({
        name: text(200),
        phone: text(50).optional(),
        email: email.optional(),
        serviceName: text(255).optional(),
        notes: text(2000).optional(),
      })
      .strict()
      .refine((v) => Boolean(v.phone || v.email), 'phone or email is required'),
    schema: {
      name: { type: 'string', required: true },
      phone: { type: 'string' },
      email: { type: 'string' },
      serviceName: { type: 'string' },
      notes: { type: 'string' },
    },
    reason:
      'A service request has no date or time, but appointments (the table booking_requests.list reads) require both. The mapping needs an owner decision.',
  },
  {
    id: 'booking_requests.update',
    access: 'write',
    risk: 'high',
    category: 'other',
    timeoutMs: WRITE_TIMEOUT_MS,
    input: z
      .object({
        requestId: id,
        status: text(50).optional(),
        pricing_mode: text(50).optional(),
        routing_path: text(50).optional(),
        review_notes: text(2000).optional(),
        closed_reason: text(500).optional(),
      })
      .strict()
      .refine((v) => Object.keys(v).some((k) => k !== 'requestId'), 'at least one field to update'),
    schema: {
      requestId: { type: 'string', required: true },
      status: { type: 'string' },
      pricing_mode: { type: 'string' },
      routing_path: { type: 'string' },
      review_notes: { type: 'string' },
      closed_reason: { type: 'string' },
    },
    reason: 'Same mapping gap as booking_requests.create: no table holds a service request without a date and time.',
  },
  {
    id: 'campaign_messages.create',
    access: 'write',
    risk: 'critical',
    category: 'customer_send',
    timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ campaignId: id, channel, body: text(2000) }).strict(),
    schema: {
      campaignId: { type: 'string', required: true },
      channel: { type: 'string', required: true },
      body: { type: 'string', required: true },
    },
    reason: `${SEND_NOT_WIRED} Campaign messages have no company-scoped store in this repo.`,
  },
  {
    id: 'client_duplicates.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    input: z.object({ limit }).strict(),
    schema: { limit: { type: 'number' } },
    reason: NO_CLIENTS_TABLE,
  },
  {
    id: 'client_merge_suggestions.create',
    access: 'write',
    risk: 'critical',
    category: 'other',
    timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ clientIds: z.array(id).min(2).max(20) }).strict(),
    schema: { clientIds: { type: 'array', required: true } },
    reason: NO_CLIENTS_TABLE,
  },
  {
    id: 'clients.create',
    access: 'write',
    risk: 'high',
    category: 'other',
    timeoutMs: WRITE_TIMEOUT_MS,
    input: z
      .object({ name: text(255), phone: text(50).optional(), email: email.optional() })
      .strict(),
    schema: { name: { type: 'string', required: true }, phone: { type: 'string' }, email: { type: 'string' } },
    reason: NO_CLIENTS_TABLE,
  },
  {
    id: 'clients.get',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    input: z.object({ id }).strict(),
    schema: { id: { type: 'string', required: true } },
    reason: NO_CLIENTS_TABLE,
  },
  {
    id: 'clients.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    input: z.object({ query: text(255).optional(), limit }).strict(),
    schema: { query: { type: 'string' }, limit: { type: 'number' } },
    reason: NO_CLIENTS_TABLE,
  },
  {
    id: 'collection_notes.create',
    access: 'write',
    risk: 'low',
    category: 'other',
    timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ invoiceId: id, note: text(2000) }).strict(),
    schema: { invoiceId: { type: 'string', required: true }, note: { type: 'string', required: true } },
    reason: NO_TABLE('collection notes (lead_notes is keyed to leads, not invoices)'),
  },
  {
    id: 'complaints.create',
    access: 'write',
    risk: 'medium',
    category: 'other',
    timeoutMs: WRITE_TIMEOUT_MS,
    input: z
      .object({ description: text(4000), customerName: text(255).optional(), jobReference: text(128).optional() })
      .strict(),
    schema: {
      description: { type: 'string', required: true },
      customerName: { type: 'string' },
      jobReference: { type: 'string' },
    },
    reason: NO_TABLE('complaints'),
  },
  {
    id: 'compliance_certificates.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    input: z.object({ status: text(50).optional(), limit }).strict(),
    schema: { status: { type: 'string' }, limit: { type: 'number' } },
    reason: NO_TABLE('compliance certificates'),
  },
  {
    id: 'compliance_documents.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    input: z.object({ limit }).strict(),
    schema: { limit: { type: 'number' } },
    reason: 'No compliance documents table. user_kyc_documents is platform identity KYC and is not company data.',
  },
  {
    id: 'compliance_reminders.send',
    access: 'write',
    risk: 'critical',
    category: 'customer_send',
    timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ certificateId: id, channel }).strict(),
    schema: { certificateId: { type: 'string', required: true }, channel: { type: 'string', required: true } },
    reason: `${SEND_NOT_WIRED} There is no compliance certificate store to remind from.`,
  },
  {
    id: 'crew_rosters.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    input: z.object({ fromDate: isoDate.optional(), toDate: isoDate.optional() }).strict(),
    schema: { fromDate: { type: 'string' }, toDate: { type: 'string' } },
    reason: NO_TABLE('crew rosters'),
  },
];

/** Input schemas by tool id. Exported so the group test can check a valid input for each tool. */
export const GROUP_00_INPUT_SCHEMAS: ReadonlyMap<string, z.ZodType<Record<string, unknown>>> = new Map(
  SPECS.map((spec) => [spec.id, spec.input]),
);

/**
 * Registry definitions for the group 00 tools. Every handler validates its input, requires a company id from the
 * registry context, and returns `not_implemented` with the reason. No data is read and no provider is called.
 */
export function createGroup00ToolDefinitions(): ToolDefinition[] {
  return SPECS.map((spec) => ({
    id: spec.id,
    risk: spec.risk,
    access: spec.access,
    ...(spec.category ? { category: spec.category } : {}),
    schema: spec.schema,
    timeoutMs: spec.timeoutMs,
    handler: (params, context) => {
      requireCompanyId(context.companyId);
      const result = spec.input.safeParse(params);
      if (!result.success) {
        // Field names only. Values are never echoed back.
        const fields = result.error.issues.flatMap((issue) =>
          issue.code === 'unrecognized_keys' ? issue.keys : [issue.path.join('.') || '(input)'],
        );
        throw new ReadToolInputError(`invalid input: ${[...new Set(fields)].join(', ')}`);
      }
      return { status: 'not_implemented', tool: spec.id, reason: spec.reason };
    },
  }));
}
