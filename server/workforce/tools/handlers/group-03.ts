/**
 * Handlers for tool group 03: property issues, purchase orders, quotes, referrals, refunds, reviews, safety escalation,
 * service agreements and the weekly report. Each tool is a ToolDefinition built by createGroup03ToolDefinitions().
 *
 * Rules every handler follows:
 *   - companyId comes only from the handler context, which the registry sets from the authenticated call. The input
 *     schemas are strict, so a companyId or tenant key in the input is refused before any query runs.
 *   - a read runs one parameterised query whose first placeholder is company_id = $1. Nothing is read across companies.
 *   - a write uses context.db, the action-journal executor. Without it (no journal configured) the write refuses and
 *     writes nothing.
 *   - a side-effect tool (a customer contact or money) never sends or moves money. Its category and risk make the
 *     registry ask for owner approval first. Where there is no table and no safe path, the handler returns
 *     { status: 'not_implemented', reason } and runs no query.
 *   - a draft tool (id ends in 'draft' or 'draft_<something>') is staged by the registry and never runs. Its handler
 *     only builds the proposal and returns it unsaved.
 *
 * Tables used are the 0014 workforce tables (migrations/0014_workforce_tool_tables.sql), all of which carry company_id.
 * Legacy tables (appointments, invoices, payment_transactions, refunds) have no company_id in the migrations, so no
 * tool here reads them.
 */
import { z } from 'zod';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { CompanyId } from '../../../services/ai-runtime/types.ts';
import type { SqlExecutor } from '../../runtime/pg-store.ts';
import type { ToolCategory, ToolDefinition, ToolHandlerContext, ToolSchema } from '../../runtime/tool-registry.ts';

export const GROUP03_MAX_ROWS = 50;
export const GROUP03_READ_TIMEOUT_MS = 10000;
export const GROUP03_WRITE_TIMEOUT_MS = 20000;
const DEFAULT_SUMMARY_DAYS = 7;
const MS_PER_DAY = 86400000;

export class Group03InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Group03InputError';
  }
}

export interface Group03Options {
  /** Executor for read queries. Writes never use it: they use context.db, the action-journal executor. */
  sql?: SqlExecutor;
}

export interface NotImplementedResult {
  status: 'not_implemented';
  reason: string;
}

// ---- Input schemas (strict: unknown keys, companyId included, are rejected) ------------------------------------------

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const rowLimit = z.number().int().min(1).max(GROUP03_MAX_ROWS).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const ISSUE_STATUS = ['open', 'monitoring', 'resolved', 'referred'] as const;
const ISSUE_SEVERITY = ['minor', 'moderate', 'major', 'critical'] as const;
const PO_STATUS = ['draft', 'sent', 'received', 'cancelled'] as const;
const ESTIMATE_STATUS = ['draft', 'sent', 'approved', 'declined', 'expired'] as const;
const AGREEMENT_STATUS = ['active', 'lapsed', 'cancelled'] as const;
const REFUND_STATUS = ['pending', 'processing', 'completed', 'failed'] as const;
const TASK_PRIORITY = ['high', 'urgent'] as const;

const propertyIssuesListInput = z
  .object({ propertyId: uuid, status: z.enum(ISSUE_STATUS).optional(), limit: rowLimit })
  .strict();
const propertyIssuesCreateInput = z
  .object({
    propertyId: uuid,
    area: text(100),
    itemKey: text(100).optional(),
    title: text(500),
    description: text(5000).optional(),
    severity: z.enum(ISSUE_SEVERITY).optional(),
  })
  .strict();
const propertyIssuesUpdateInput = z
  .object({
    issueId: uuid,
    status: z.enum(ISSUE_STATUS).optional(),
    severity: z.enum(ISSUE_SEVERITY).optional(),
    resolvedNote: text(2000).optional(),
  })
  .strict()
  .refine((v) => v.status !== undefined || v.severity !== undefined || v.resolvedNote !== undefined, {
    message: 'nothing to update',
  });
const purchaseOrdersListInput = z.object({ status: z.enum(PO_STATUS).optional(), limit: rowLimit }).strict();
const purchaseOrdersDraftInput = z
  .object({ supplierName: text(200), totalCents: z.number().int().min(0).max(100000000).optional(), notes: text(2000).optional() })
  .strict();
const quoteRequestsCreateInput = z
  .object({ clientName: text(200), summary: text(2000), clientId: uuid.optional() })
  .strict();
const quotesListInput = z
  .object({ status: z.enum(ESTIMATE_STATUS).optional(), clientId: uuid.optional(), limit: rowLimit })
  .strict();
const referralRequestsCreateInput = z.object({ clientId: uuid, note: text(1000).optional() }).strict();
const refundRequestsCreateInput = z
  .object({ transactionId: text(128), amountCents: z.number().int().min(1), reason: text(500) })
  .strict();
const refundRequestsListInput = z.object({ status: z.enum(REFUND_STATUS).optional(), limit: rowLimit }).strict();
const refundRequestsPrepareInput = z
  .object({ transactionId: text(128), amountCents: z.number().int().min(1), reason: text(500) })
  .strict();
const reportsWeeklySummaryInput = z
  .object({ days: z.number().int().min(1).max(31).optional() })
  .strict();
const reviewAlertsCreateInput = z.object({ reviewId: uuid, summary: text(1000) }).strict();
const reviewsListInput = z
  .object({ rating: z.number().int().min(1).max(5).optional(), clientId: uuid.optional(), limit: rowLimit })
  .strict();
const reviewsRequestInput = z.object({ clientId: uuid, note: text(1000).optional() }).strict();
const safetyEscalateInput = z
  .object({
    title: text(200),
    description: text(2000),
    priority: z.enum(TASK_PRIORITY).optional(),
    workOrderId: uuid.optional(),
    visitId: uuid.optional(),
  })
  .strict();
const serviceAgreementsDraftRenewalInput = z
  .object({ agreementId: uuid, endsOn: isoDate.optional(), priceCents: z.number().int().min(0).optional() })
  .strict();
const serviceAgreementsListInput = z
  .object({ status: z.enum(AGREEMENT_STATUS).optional(), clientId: uuid.optional(), limit: rowLimit })
  .strict();

/** Zod input schema per tool id. The registry uses the ToolSchema field list; these are the stricter check. */
export const GROUP03_INPUT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  'property_issues.list': propertyIssuesListInput,
  'property_issues.create': propertyIssuesCreateInput,
  'property_issues.update': propertyIssuesUpdateInput,
  'purchase_orders.list': purchaseOrdersListInput,
  'purchase_orders.draft': purchaseOrdersDraftInput,
  'quote_requests.create': quoteRequestsCreateInput,
  'quotes.list': quotesListInput,
  'referral_requests.create': referralRequestsCreateInput,
  'refund_requests.create': refundRequestsCreateInput,
  'refund_requests.list': refundRequestsListInput,
  'refund_requests.prepare': refundRequestsPrepareInput,
  'reports.weekly_summary': reportsWeeklySummaryInput,
  'review_alerts.create': reviewAlertsCreateInput,
  'reviews.list': reviewsListInput,
  'reviews.request': reviewsRequestInput,
  'safety.escalate_to_human': safetyEscalateInput,
  'service_agreements.draft_renewal': serviceAgreementsDraftRenewalInput,
  'service_agreements.list': serviceAgreementsListInput,
};

/** Every tool id in group 03, in the order the definitions are returned. */
export const GROUP03_TOOL_IDS: readonly string[] = Object.keys(GROUP03_INPUT_SCHEMAS);

/** Ids whose handler returns { status: 'not_implemented' } and runs no query (no table or no safe path). */
export const GROUP03_NOT_IMPLEMENTED_IDS: ReadonlySet<string> = new Set([
  'referral_requests.create',
  'refund_requests.create',
  'refund_requests.list',
  'refund_requests.prepare',
  'reviews.request',
]);

// ---- Helpers ---------------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Field names only. Values are never echoed back.
    const fields = result.error.issues.flatMap((issue) => {
      if (issue.code === 'unrecognized_keys') return issue.keys;
      return [issue.path.join('.') || '(input)'];
    });
    throw new Group03InputError(`invalid input: ${[...new Set(fields)].join(', ')}`);
  }
  return result.data;
}

/** Builds a query's values with company_id as $1, so every query names the caller's company first. */
class Params {
  readonly values: unknown[];

  constructor(companyId: CompanyId) {
    this.values = [companyId];
  }

  /** Adds a value and returns its placeholder, such as $3. Placeholders are numbered in the order values are added. */
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function readDb(options: Group03Options, context: ToolHandlerContext): SqlExecutor {
  const db = context.db ?? options.sql;
  if (db === undefined) throw new Error('read needs a database executor; none is configured');
  return db;
}

function writeDb(context: ToolHandlerContext): SqlExecutor {
  if (context.db === undefined) throw new Error('write needs the action journal executor; nothing was written');
  return context.db;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function dateOnly(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

function bounded<T>(rows: Row[], limit: number, shape: (row: Row) => T) {
  const kept = rows.slice(0, limit).map(shape);
  return { rows: kept, count: kept.length, truncated: rows.length > limit, maxRows: GROUP03_MAX_ROWS };
}

function notImplemented(reason: string): NotImplementedResult {
  return { status: 'not_implemented', reason };
}

function firstRow(rows: Row[], what: string): Row {
  const row = rows[0];
  if (row === undefined) throw new Error(`${what} returned no row`);
  return row;
}

// ---- Shapes: explicit allow-lists of output fields -------------------------------------------------------------------

function issueShape(row: Row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    area: row.area,
    itemKey: row.item_key,
    title: row.title,
    description: row.description ?? null,
    severity: row.severity,
    status: row.status,
    occurrenceCount: Number(row.occurrence_count),
    firstNotedAt: iso(row.first_noted_at),
    lastNotedAt: iso(row.last_noted_at),
    resolvedAt: iso(row.resolved_at),
    resolvedNote: row.resolved_note ?? null,
  };
}

function purchaseOrderShape(row: Row) {
  // No notes: they are internal.
  return {
    id: row.id,
    supplierName: row.supplier_name,
    status: row.status,
    totalCents: Number(row.total_cents),
    orderedAt: iso(row.ordered_at),
    createdAt: iso(row.created_at),
  };
}

function estimateShape(row: Row) {
  // No internal_notes: they are for staff only.
  return {
    id: row.id,
    clientId: row.client_id,
    propertyId: row.property_id ?? null,
    status: row.status,
    subtotalCents: Number(row.subtotal_cents),
    taxCents: Number(row.tax_cents),
    totalCents: Number(row.total_cents),
    sentAt: iso(row.sent_at),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

function reviewShape(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id ?? null,
    rating: Number(row.rating),
    comment: row.comment ?? null,
    source: row.source ?? null,
    reviewedAt: iso(row.reviewed_at),
  };
}

function agreementShape(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id,
    propertyId: row.property_id ?? null,
    name: row.name,
    status: row.status,
    startsOn: dateOnly(row.starts_on),
    endsOn: dateOnly(row.ends_on),
    priceCents: Number(row.price_cents),
  };
}

// ---- Definition builder ----------------------------------------------------------------------------------------------

interface ToolSpec<S extends z.ZodType> {
  id: string;
  access: 'read' | 'write';
  risk: 'low' | 'medium' | 'high' | 'critical';
  category?: ToolCategory;
  schema: ToolSchema;
  input: S;
  run: (args: { companyId: CompanyId; input: z.infer<S>; context: ToolHandlerContext; options: Group03Options }) => unknown;
}

function toDefinition<S extends z.ZodType>(spec: ToolSpec<S>, options: Group03Options): ToolDefinition {
  return {
    id: spec.id,
    access: spec.access,
    risk: spec.risk,
    ...(spec.category === undefined ? {} : { category: spec.category }),
    schema: spec.schema,
    timeoutMs: spec.access === 'read' ? GROUP03_READ_TIMEOUT_MS : GROUP03_WRITE_TIMEOUT_MS,
    handler: (params, context) => {
      const companyId = requireCompanyId(context.companyId);
      const input = parseInput(spec.input, params);
      return spec.run({ companyId, input, context, options });
    },
  };
}

// ---- Tool definitions ------------------------------------------------------------------------------------------------

/**
 * Registry definitions for group 03. Reads use options.sql (or context.db when the registry supplies one). Writes use
 * context.db only. Side-effect tools carry the category and risk that make the registry ask for owner approval.
 */
export function createGroup03ToolDefinitions(options: Group03Options = {}): ToolDefinition[] {
  const define = <S extends z.ZodType>(spec: ToolSpec<S>): ToolDefinition => toDefinition(spec, options);

  return [
    define({
      id: 'property_issues.list',
      access: 'read',
      risk: 'low',
      schema: {
        propertyId: { type: 'string', required: true },
        status: { type: 'string' },
        limit: { type: 'number' },
      },
      input: propertyIssuesListInput,
      run: async ({ companyId, input, context }) => {
        const db = readDb(options, context);
        const p = new Params(companyId);
        const where = ['company_id = $1', `property_id = ${p.add(input.propertyId)}`];
        if (input.status !== undefined) where.push(`status = ${p.add(input.status)}`);
        const limit = input.limit ?? GROUP03_MAX_ROWS;
        const limitRef = p.add(limit + 1);
        const result = await db.query(
          `SELECT id, property_id, area, item_key, title, description, severity, status, occurrence_count,
                  first_noted_at, last_noted_at, resolved_at, resolved_note
             FROM property_issues WHERE ${where.join(' AND ')}
            ORDER BY last_noted_at DESC LIMIT ${limitRef}`,
          p.values,
        );
        return bounded(result.rows, limit, issueShape);
      },
    }),

    define({
      id: 'property_issues.create',
      access: 'write',
      risk: 'medium',
      category: 'other',
      schema: {
        propertyId: { type: 'string', required: true },
        area: { type: 'string', required: true },
        itemKey: { type: 'string' },
        title: { type: 'string', required: true },
        description: { type: 'string' },
        severity: { type: 'string' },
      },
      input: propertyIssuesCreateInput,
      run: async ({ companyId, input, context }) => {
        const db = writeDb(context);
        const p = new Params(companyId);
        const result = await db.query(
          `INSERT INTO property_issues (company_id, property_id, area, item_key, title, description, severity, auto_detected)
           VALUES ($1, ${p.add(input.propertyId)}, ${p.add(input.area)}, ${p.add(input.itemKey ?? 'manual')},
                   ${p.add(input.title)}, ${p.add(input.description ?? null)}, ${p.add(input.severity ?? 'minor')}, false)
           RETURNING id, property_id, area, item_key, title, description, severity, status, occurrence_count,
                     first_noted_at, last_noted_at, resolved_at, resolved_note`,
          p.values,
        );
        return { created: issueShape(firstRow(result.rows, 'property issue insert')) };
      },
    }),

    define({
      id: 'property_issues.update',
      access: 'write',
      risk: 'medium',
      category: 'other',
      schema: {
        issueId: { type: 'string', required: true },
        status: { type: 'string' },
        severity: { type: 'string' },
        resolvedNote: { type: 'string' },
      },
      input: propertyIssuesUpdateInput,
      run: async ({ companyId, input, context }) => {
        const db = writeDb(context);
        const p = new Params(companyId);
        const idRef = p.add(input.issueId);
        const statusRef = p.add(input.status ?? null);
        const severityRef = p.add(input.severity ?? null);
        const noteRef = p.add(input.resolvedNote ?? null);
        const result = await db.query(
          `UPDATE property_issues SET
             status = COALESCE(${statusRef}::text, status),
             severity = COALESCE(${severityRef}::text, severity),
             resolved_note = COALESCE(${noteRef}::text, resolved_note),
             resolved_at = CASE WHEN ${statusRef}::text = 'resolved' THEN now()
                                WHEN ${statusRef}::text IS NOT NULL THEN NULL
                                ELSE resolved_at END,
             updated_at = now()
           WHERE company_id = $1 AND id = ${idRef}
           RETURNING id, property_id, area, item_key, title, description, severity, status, occurrence_count,
                     first_noted_at, last_noted_at, resolved_at, resolved_note`,
          p.values,
        );
        const row = result.rows[0];
        return row === undefined ? { found: false, issue: null } : { found: true, issue: issueShape(row) };
      },
    }),

    define({
      id: 'purchase_orders.list',
      access: 'read',
      risk: 'low',
      schema: { status: { type: 'string' }, limit: { type: 'number' } },
      input: purchaseOrdersListInput,
      run: async ({ companyId, input, context, options: opts }) => {
        const db = readDb(opts, context);
        const p = new Params(companyId);
        const where = ['company_id = $1'];
        if (input.status !== undefined) where.push(`status = ${p.add(input.status)}`);
        const limit = input.limit ?? GROUP03_MAX_ROWS;
        const limitRef = p.add(limit + 1);
        const result = await db.query(
          `SELECT id, supplier_name, status, total_cents, ordered_at, created_at
             FROM purchase_orders WHERE ${where.join(' AND ')}
            ORDER BY created_at DESC LIMIT ${limitRef}`,
          p.values,
        );
        return bounded(result.rows, limit, purchaseOrderShape);
      },
    }),

    define({
      // A draft: the registry stages it and never runs this handler. The proposal is returned unsaved.
      id: 'purchase_orders.draft',
      access: 'write',
      risk: 'medium',
      category: 'other',
      schema: {
        supplierName: { type: 'string', required: true },
        totalCents: { type: 'number' },
        notes: { type: 'string' },
      },
      input: purchaseOrdersDraftInput,
      run: ({ input }) => ({
        persisted: false,
        proposal: {
          supplierName: input.supplierName,
          status: 'draft',
          totalCents: input.totalCents ?? 0,
          notes: input.notes ?? null,
        },
      }),
    }),

    define({
      id: 'quote_requests.create',
      access: 'write',
      risk: 'medium',
      category: 'other',
      schema: {
        clientName: { type: 'string', required: true },
        summary: { type: 'string', required: true },
        clientId: { type: 'string' },
      },
      input: quoteRequestsCreateInput,
      run: async ({ companyId, input, context }) => {
        const db = writeDb(context);
        const p = new Params(companyId);
        const result = await db.query(
          `INSERT INTO quote_requests (company_id, client_id, client_name, summary)
           VALUES ($1, ${p.add(input.clientId ?? null)}, ${p.add(input.clientName)}, ${p.add(input.summary)})
           RETURNING id, client_id, client_name, summary, status, requested_at`,
          p.values,
        );
        const row = firstRow(result.rows, 'quote request insert');
        return {
          created: {
            id: row.id,
            clientId: row.client_id ?? null,
            clientName: row.client_name,
            summary: row.summary,
            status: row.status,
            requestedAt: iso(row.requested_at),
          },
        };
      },
    }),

    define({
      // Quotes are estimates in the 0014 tables.
      id: 'quotes.list',
      access: 'read',
      risk: 'low',
      schema: {
        status: { type: 'string' },
        clientId: { type: 'string' },
        limit: { type: 'number' },
      },
      input: quotesListInput,
      run: async ({ companyId, input, context, options: opts }) => {
        const db = readDb(opts, context);
        const p = new Params(companyId);
        const where = ['company_id = $1'];
        if (input.status !== undefined) where.push(`status = ${p.add(input.status)}`);
        if (input.clientId !== undefined) where.push(`client_id = ${p.add(input.clientId)}`);
        const limit = input.limit ?? GROUP03_MAX_ROWS;
        const limitRef = p.add(limit + 1);
        const result = await db.query(
          `SELECT id, client_id, property_id, status, subtotal_cents, tax_cents, total_cents, sent_at, expires_at, created_at
             FROM estimates WHERE ${where.join(' AND ')}
            ORDER BY created_at DESC LIMIT ${limitRef}`,
          p.values,
        );
        return bounded(result.rows, limit, estimateShape);
      },
    }),

    define({
      // No referral table, and asking a customer is a customer contact. Approval is required first (category), then the
      // handler refuses: nothing is sent or recorded.
      id: 'referral_requests.create',
      access: 'write',
      risk: 'critical',
      category: 'customer_send',
      schema: { clientId: { type: 'string', required: true }, note: { type: 'string' } },
      input: referralRequestsCreateInput,
      run: () =>
        notImplemented(
          'No referral table exists, and asking a customer for a referral is a customer contact with no send path. Nothing was sent or recorded.',
        ),
    }),

    define({
      // No refund-request table. Refunds move money, so approval is required first, then the handler refuses.
      id: 'refund_requests.create',
      access: 'write',
      risk: 'critical',
      category: 'money',
      schema: {
        transactionId: { type: 'string', required: true },
        amountCents: { type: 'number', required: true },
        reason: { type: 'string', required: true },
      },
      input: refundRequestsCreateInput,
      run: () =>
        notImplemented(
          'No refund-request table exists. The refunds table records gateway refunds and has no company_id in the migrations. Nothing was created or paid.',
        ),
    }),

    define({
      // The refunds table has no company_id in the migrations, so a company-scoped read cannot be guaranteed. No query runs.
      id: 'refund_requests.list',
      access: 'read',
      risk: 'low',
      schema: { status: { type: 'string' }, limit: { type: 'number' } },
      input: refundRequestsListInput,
      run: () =>
        notImplemented(
          'The refunds table has no company_id in the migrations, so a company-scoped read cannot be guaranteed. No query was run.',
        ),
    }),

    define({
      // Preparing a refund works with money and needs a refund-request record, which does not exist. Approval first.
      id: 'refund_requests.prepare',
      access: 'write',
      risk: 'critical',
      category: 'money',
      schema: {
        transactionId: { type: 'string', required: true },
        amountCents: { type: 'number', required: true },
        reason: { type: 'string', required: true },
      },
      input: refundRequestsPrepareInput,
      run: () =>
        notImplemented(
          'Preparing a refund needs a refund-request record, which does not exist, and it works with money. Nothing was calculated or written.',
        ),
    }),

    define({
      // Read-only summary of the 0014 tables. Declared write to match TOOL_ACCESS (the catalogue's classification).
      id: 'reports.weekly_summary',
      access: 'write',
      risk: 'low',
      schema: { days: { type: 'number' } },
      input: reportsWeeklySummaryInput,
      run: async ({ companyId, input, context, options: opts }) => {
        const db = readDb(opts, context);
        const days = input.days ?? DEFAULT_SUMMARY_DAYS;
        const until = new Date();
        const since = new Date(until.getTime() - days * MS_PER_DAY);
        const result = await db.query(
          `SELECT
             (SELECT count(*)::int FROM estimates WHERE company_id = $1 AND sent_at >= $2::timestamptz AND sent_at < $3::timestamptz) AS estimates_sent,
             (SELECT count(*)::int FROM estimates WHERE company_id = $1 AND status IN ('draft', 'sent')) AS estimates_open,
             (SELECT count(*)::int FROM reviews WHERE company_id = $1 AND reviewed_at >= $2::timestamptz AND reviewed_at < $3::timestamptz) AS new_reviews,
             (SELECT round(avg(rating)::numeric, 2)::text FROM reviews WHERE company_id = $1 AND reviewed_at >= $2::timestamptz AND reviewed_at < $3::timestamptz) AS average_rating,
             (SELECT count(*)::int FROM complaints WHERE company_id = $1 AND status IN ('open', 'investigating')) AS open_complaints,
             (SELECT count(*)::int FROM property_issues WHERE company_id = $1 AND status IN ('open', 'monitoring')) AS open_property_issues,
             (SELECT count(*)::int FROM staff_tasks WHERE company_id = $1 AND status IN ('open', 'in_progress')) AS open_staff_tasks,
             (SELECT count(*)::int FROM purchase_orders WHERE company_id = $1 AND status IN ('draft', 'sent')) AS open_purchase_orders`,
          [companyId, since.toISOString(), until.toISOString()],
        );
        const row = firstRow(result.rows, 'weekly summary');
        return {
          windowStart: since.toISOString(),
          windowEnd: until.toISOString(),
          estimatesSent: Number(row.estimates_sent),
          estimatesOpen: Number(row.estimates_open),
          newReviews: Number(row.new_reviews),
          averageRating: row.average_rating ?? null,
          openComplaints: Number(row.open_complaints),
          openPropertyIssues: Number(row.open_property_issues),
          openStaffTasks: Number(row.open_staff_tasks),
          openPurchaseOrders: Number(row.open_purchase_orders),
        };
      },
    }),

    define({
      id: 'review_alerts.create',
      access: 'write',
      risk: 'medium',
      category: 'other',
      schema: { reviewId: { type: 'string', required: true }, summary: { type: 'string', required: true } },
      input: reviewAlertsCreateInput,
      run: async ({ companyId, input, context }) => {
        const db = writeDb(context);
        const p = new Params(companyId);
        const result = await db.query(
          `INSERT INTO review_alerts (company_id, review_id, summary)
           VALUES ($1, ${p.add(input.reviewId)}, ${p.add(input.summary)})
           RETURNING id, review_id, summary, status, created_at`,
          p.values,
        );
        const row = firstRow(result.rows, 'review alert insert');
        return {
          created: { id: row.id, reviewId: row.review_id, summary: row.summary, status: row.status, createdAt: iso(row.created_at) },
        };
      },
    }),

    define({
      id: 'reviews.list',
      access: 'read',
      risk: 'low',
      schema: { rating: { type: 'number' }, clientId: { type: 'string' }, limit: { type: 'number' } },
      input: reviewsListInput,
      run: async ({ companyId, input, context, options: opts }) => {
        const db = readDb(opts, context);
        const p = new Params(companyId);
        const where = ['company_id = $1'];
        if (input.rating !== undefined) where.push(`rating = ${p.add(input.rating)}`);
        if (input.clientId !== undefined) where.push(`client_id = ${p.add(input.clientId)}`);
        const limit = input.limit ?? GROUP03_MAX_ROWS;
        const limitRef = p.add(limit + 1);
        const result = await db.query(
          `SELECT id, client_id, rating, comment, source, reviewed_at
             FROM reviews WHERE ${where.join(' AND ')}
            ORDER BY reviewed_at DESC LIMIT ${limitRef}`,
          p.values,
        );
        return bounded(result.rows, limit, reviewShape);
      },
    }),

    define({
      // Asking a customer for a review is a customer contact. Approval first, then the handler refuses: nothing is sent.
      id: 'reviews.request',
      access: 'write',
      risk: 'critical',
      category: 'customer_send',
      schema: { clientId: { type: 'string', required: true }, note: { type: 'string' } },
      input: reviewsRequestInput,
      run: () =>
        notImplemented(
          'Asking a customer for a review is a customer contact with no send path, and no review-request record exists. Nothing was sent.',
        ),
    }),

    define({
      // An internal escalation: a staff_tasks row for a person to pick up. Risk high, so the ladder asks the owner first.
      id: 'safety.escalate_to_human',
      access: 'write',
      risk: 'high',
      category: 'other',
      schema: {
        title: { type: 'string', required: true },
        description: { type: 'string', required: true },
        priority: { type: 'string' },
        workOrderId: { type: 'string' },
        visitId: { type: 'string' },
      },
      input: safetyEscalateInput,
      run: async ({ companyId, input, context }) => {
        const db = writeDb(context);
        const p = new Params(companyId);
        const result = await db.query(
          `INSERT INTO staff_tasks (company_id, kind, title, description, priority, work_order_id, visit_id)
           VALUES ($1, 'staff', ${p.add(input.title)}, ${p.add(input.description)}, ${p.add(input.priority ?? 'urgent')},
                   ${p.add(input.workOrderId ?? null)}, ${p.add(input.visitId ?? null)})
           RETURNING id, kind, title, priority, status, work_order_id, visit_id, created_at`,
          p.values,
        );
        const row = firstRow(result.rows, 'escalation insert');
        return {
          created: {
            id: row.id,
            kind: row.kind,
            title: row.title,
            priority: row.priority,
            status: row.status,
            workOrderId: row.work_order_id ?? null,
            visitId: row.visit_id ?? null,
            createdAt: iso(row.created_at),
          },
        };
      },
    }),

    define({
      // A draft: the registry stages it and never runs this handler. The proposal is returned unsaved.
      id: 'service_agreements.draft_renewal',
      access: 'write',
      risk: 'medium',
      category: 'other',
      schema: {
        agreementId: { type: 'string', required: true },
        endsOn: { type: 'string' },
        priceCents: { type: 'number' },
      },
      input: serviceAgreementsDraftRenewalInput,
      run: ({ input }) => ({
        persisted: false,
        proposal: {
          agreementId: input.agreementId,
          status: 'draft',
          endsOn: input.endsOn ?? null,
          priceCents: input.priceCents ?? null,
        },
      }),
    }),

    define({
      id: 'service_agreements.list',
      access: 'read',
      risk: 'low',
      schema: { status: { type: 'string' }, clientId: { type: 'string' }, limit: { type: 'number' } },
      input: serviceAgreementsListInput,
      run: async ({ companyId, input, context, options: opts }) => {
        const db = readDb(opts, context);
        const p = new Params(companyId);
        const where = ['company_id = $1'];
        if (input.status !== undefined) where.push(`status = ${p.add(input.status)}`);
        if (input.clientId !== undefined) where.push(`client_id = ${p.add(input.clientId)}`);
        const limit = input.limit ?? GROUP03_MAX_ROWS;
        const limitRef = p.add(limit + 1);
        const result = await db.query(
          `SELECT id, client_id, property_id, name, status, starts_on, ends_on, price_cents, created_at
             FROM service_agreements WHERE ${where.join(' AND ')}
            ORDER BY created_at DESC LIMIT ${limitRef}`,
          p.values,
        );
        return bounded(result.rows, limit, agreementShape);
      },
    }),
  ];
}
