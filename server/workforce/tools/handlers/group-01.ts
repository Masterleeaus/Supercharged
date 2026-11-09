/**
 * Handlers for the 18 tool ids in group 01. Each id gets a definition (access, risk, optional category, schema,
 * timeoutMs and handler) and a strict zod input schema. Nothing here sends a message, moves money or calls an outside
 * service.
 *
 * Data access. Handlers use a SqlExecutor (runtime/pg-store.ts), the port the other workforce stores use, with
 * parameterised SQL. Reads use `options.db`. Writes use `context.db` when the registry sets it (the action-journal
 * transaction, so the write commits with its journal row) and fall back to `options.db`. With no executor, a call
 * throws Group01UnavailableError before any SQL runs. No executor is wired by the composition root yet.
 *
 * Company scope. companyId comes only from the registry context (requireCompanyId). It is never read from input, and
 * every input object is strict, so a companyId key is rejected. Every statement filters on company_id = $1, and every
 * row that comes back is checked against companyId again before it is returned.
 *
 * Side-effect tools (no send, no money movement):
 *   - customer_messages.draft: a draft tool. The registry stages it and never runs this handler. The handler only
 *     returns the draft text for a person to review.
 *   - customer_messages.send, feedback_surveys.send, job_photos.request_from_customer: category customer_send, so the
 *     registry needs owner approval first (runtime/always-approval.ts). This build has no outbound messaging provider,
 *     so after approval the handler returns not_implemented and nothing is sent.
 *   - escalations.create, human_escalation.create, identity.verify_request: there is no table and no safe write path,
 *     so the handler returns not_implemented and writes nothing.
 */
import { z } from 'zod';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { CompanyId } from '../../../services/ai-runtime/types.ts';
import type { SqlExecutor } from '../../runtime/pg-store.ts';
import type {
  RiskTier,
  ToolCategory,
  ToolDefinition,
  ToolField,
  ToolFieldType,
  ToolHandlerContext,
  ToolSchema,
} from '../../runtime/tool-registry.ts';

/** Same cap as MAX_READ_ROWS in read-handlers.ts. Not imported there: read-handlers imports this module. */
export const GROUP01_MAX_ROWS = 50;
export const GROUP01_READ_TIMEOUT_MS = 10_000;
export const GROUP01_WRITE_TIMEOUT_MS = 20_000;

export const GROUP01_TOOL_IDS = [
  'crew_rosters.update',
  'customer_messages.draft',
  'customer_messages.send',
  'disputes.create',
  'end_of_lease_checklists.create',
  'escalations.create',
  'estimates.create',
  'estimates.list',
  'feedback_responses.create',
  'feedback_surveys.send',
  'human_escalation.create',
  'identity.verify_request',
  'inventory.list',
  'invoice_disputes.create',
  'job_checklists.list',
  'job_notes.create',
  'job_photos.list',
  'job_photos.request_from_customer',
] as const;
/** Ids whose handler returns { status: 'not_implemented' } and sends or escalates nothing (no provider or table in this build). */
export const GROUP01_NOT_IMPLEMENTED_IDS: ReadonlySet<string> = new Set([
  'customer_messages.send',
  'feedback_surveys.send',
  'job_photos.request_from_customer',
  'escalations.create',
  'human_escalation.create',
  'identity.verify_request',
]);

export type Group01ToolId = (typeof GROUP01_TOOL_IDS)[number];

export class Group01InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Group01InputError';
  }
}

export class Group01UnavailableError extends Error {
  constructor() {
    super('database executor is not wired for this tool');
    this.name = 'Group01UnavailableError';
  }
}

export interface Group01Options {
  /** Executor for reads, and for writes outside a journal transaction. Absent: those calls throw before any SQL. */
  db?: SqlExecutor;
}

// ---- Input schemas (strict: unknown keys, companyId included, are rejected) ---------------------------------------

const uuid = z.string().uuid();
const shortText = (max: number) => z.string().trim().min(1).max(max);
const cents = z.number().int().min(0).max(100_000_000);
const rating = z.number().int().min(1).max(5);
const limit = z.number().int().min(1).max(GROUP01_MAX_ROWS).optional();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const channel = z.enum(['sms', 'email']);
const photoCategory = z.enum(['before', 'after', 'receipt']);
const ROSTER_UPDATE_FIELDS = ['rosterDate', 'teamName', 'members', 'status'] as const;

const estimatesListInput = z
  .object({
    status: z.enum(['draft', 'sent', 'approved', 'declined', 'expired']).optional(),
    clientId: uuid.optional(),
    limit,
  })
  .strict();
const inventoryListInput = z.object({ belowReorderOnly: z.boolean().optional(), limit }).strict();
const checklistListInput = z.object({ visitId: uuid, limit }).strict();
const photoListInput = z.object({ visitId: uuid, category: photoCategory.optional(), limit }).strict();

const estimateCreateInput = z
  .object({
    clientId: uuid,
    propertyId: uuid.optional(),
    workOrderId: uuid.optional(),
    subtotalCents: cents,
    taxCents: cents.optional(),
    notes: shortText(2000).optional(),
    internalNotes: shortText(2000).optional(),
  })
  .strict();
const rosterUpdateInput = z
  .object({
    id: uuid,
    rosterDate: isoDate.optional(),
    teamName: shortText(120).optional(),
    members: z.array(shortText(120)).max(50).optional(),
    status: z.enum(['draft', 'published']).optional(),
  })
  .strict()
  .refine((value) => ROSTER_UPDATE_FIELDS.some((key) => (value as Record<string, unknown>)[key] !== undefined), {
    message: 'nothing to update',
  });
const disputeCreateInput = z.object({ clientId: uuid.optional(), summary: shortText(4000) }).strict();
const invoiceDisputeCreateInput = z
  .object({ clientId: uuid.optional(), invoiceRef: shortText(128), summary: shortText(4000) })
  .strict();
const endOfLeaseCreateInput = z
  .object({
    title: shortText(200),
    propertyId: uuid.optional(),
    items: z.array(z.object({ label: shortText(200), done: z.boolean().optional() }).strict()).max(200).optional(),
  })
  .strict();
const feedbackCreateInput = z
  .object({
    visitId: uuid.optional(),
    clientId: uuid.optional(),
    rating: rating.optional(),
    comment: shortText(2000).optional(),
  })
  .strict();
const jobNoteCreateInput = z
  .object({ workOrderId: uuid.optional(), visitId: uuid.optional(), body: shortText(4000) })
  .strict()
  .refine((value) => value.workOrderId !== undefined || value.visitId !== undefined, {
    message: 'workOrderId or visitId is required',
    path: ['workOrderId'],
  });

const messageInput = z.object({ clientId: uuid, channel, body: shortText(1000) }).strict();
const surveySendInput = z.object({ clientId: uuid, visitId: uuid.optional() }).strict();
const photoRequestInput = z
  .object({ visitId: uuid, category: photoCategory.optional(), message: shortText(1000).optional() })
  .strict();
const escalationInput = z
  .object({ reason: shortText(1000), visitId: uuid.optional(), clientId: uuid.optional() })
  .strict();
const identityInput = z.object({ clientId: uuid, method: shortText(50).optional() }).strict();

// ---- Field-type schemas for the registry (ToolSchema). zod above is the stricter check. --------------------------

const field = (type: ToolFieldType, required = false): ToolField => ({ type, required });

// ---- Shared helpers ------------------------------------------------------------------------------------------------

/** Numbered SQL parameters. add() returns the placeholder, so statements and values cannot drift apart. */
class SqlParams {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

interface BoundedList<T> {
  rows: T[];
  count: number;
  truncated: boolean;
  maxRows: number;
}

/** Keeps rows that belong to companyId, cuts to the page size, and reports whether anything was cut. */
function bounded<T>(
  companyId: CompanyId,
  rows: Record<string, unknown>[],
  cap: number,
  shape: (row: Record<string, unknown>) => T,
): BoundedList<T> {
  const own = rows.filter((row) => row.company_id === companyId);
  const kept = own.slice(0, cap).map(shape);
  return { rows: kept, count: kept.length, truncated: own.length > cap, maxRows: GROUP01_MAX_ROWS };
}

function pageCap(requested: number | undefined): number {
  return requested ?? GROUP01_MAX_ROWS;
}

function need(db: SqlExecutor | undefined): SqlExecutor {
  if (db === undefined) throw new Group01UnavailableError();
  return db;
}

function parseInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Field names only. Values are never echoed back.
    const fields = result.error.issues.flatMap((issue) => {
      if (issue.code === 'unrecognized_keys') return issue.keys;
      return [issue.path.join('.') || '(input)'];
    });
    throw new Group01InputError(`invalid input: ${[...new Set(fields)].join(', ')}`);
  }
  return result.data;
}

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null;

function notImplemented(reason: string) {
  return { status: 'not_implemented', reason };
}

function firstRow(rows: Record<string, unknown>[], what: string): Record<string, unknown> {
  const row = rows[0];
  if (row === undefined) throw new Error(`${what} returned no row`);
  return row;
}

// ---- Output shapes (explicit allow-lists) --------------------------------------------------------------------------

function estimateOut(row: Record<string, unknown>) {
  // internal_notes is left out: it is for staff only.
  return {
    id: row.id,
    clientId: row.client_id,
    propertyId: row.property_id ?? null,
    workOrderId: row.work_order_id ?? null,
    status: row.status,
    totalCents: Number(row.total_cents),
    notes: row.notes ?? null,
    sentAt: iso(row.sent_at),
    expiresAt: iso(row.expires_at),
    createdAt: iso(row.created_at),
  };
}

function inventoryOut(row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku ?? null,
    unitLabel: row.unit_label ?? null,
    storeSection: row.store_section ?? null,
    quantity: row.quantity,
    reorderLevel: row.reorder_level,
    belowReorder: Number(row.quantity) <= Number(row.reorder_level),
  };
}

function checklistItemOut(row: Record<string, unknown>) {
  return {
    id: row.id,
    visitId: row.visit_id,
    section: row.section,
    itemKey: row.item_key,
    label: row.label,
    disposition: row.disposition ?? null,
    note: row.note ?? null,
    sortOrder: Number(row.sort_order),
  };
}

function photoOut(row: Record<string, unknown>) {
  // filename is the storage key and is left out.
  return {
    id: row.id,
    visitId: row.visit_id,
    category: row.category,
    originalName: row.original_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: iso(row.created_at),
  };
}

// ---- Specs -----------------------------------------------------------------------------------------------------------

interface Group01Spec<S extends z.ZodTypeAny = z.ZodTypeAny> {
  id: Group01ToolId;
  access: 'read' | 'write';
  risk: RiskTier;
  category?: ToolCategory;
  input: S;
  fields: ToolSchema;
  /** db is the executor for this call (see the module header). Undefined when none is wired. */
  run: (args: z.output<S>, companyId: CompanyId, db: SqlExecutor | undefined) => Promise<unknown>;
}

const SPECS: readonly Group01Spec[] = [
  // ---- reads
  {
    id: 'estimates.list',
    access: 'read',
    risk: 'low',
    input: estimatesListInput,
    fields: {
      status: field('string'),
      clientId: field('string'),
      limit: field('number'),
    },
    run: async (args, companyId, db) => {
      const params = new SqlParams();
      const where = [`company_id = ${params.add(companyId)}`];
      if (args.status !== undefined) where.push(`status = ${params.add(args.status)}`);
      if (args.clientId !== undefined) where.push(`client_id = ${params.add(args.clientId)}`);
      const cap = pageCap(args.limit);
      const result = await need(db).query(
        `SELECT id, company_id, client_id, property_id, work_order_id, status, total_cents, notes,
                sent_at, expires_at, created_at
           FROM estimates
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC, id
          LIMIT ${params.add(cap + 1)}`,
        params.values,
      );
      return bounded(companyId, result.rows, cap, estimateOut);
    },
  },
  {
    id: 'inventory.list',
    access: 'read',
    risk: 'low',
    input: inventoryListInput,
    fields: { belowReorderOnly: field('boolean'), limit: field('number') },
    run: async (args, companyId, db) => {
      const params = new SqlParams();
      const where = [`company_id = ${params.add(companyId)}`];
      if (args.belowReorderOnly === true) where.push('quantity <= reorder_level');
      const cap = pageCap(args.limit);
      const result = await need(db).query(
        `SELECT id, company_id, name, sku, unit_label, store_section, quantity, reorder_level
           FROM inventory_items
          WHERE ${where.join(' AND ')}
          ORDER BY name, id
          LIMIT ${params.add(cap + 1)}`,
        params.values,
      );
      return bounded(companyId, result.rows, cap, inventoryOut);
    },
  },
  {
    id: 'job_checklists.list',
    access: 'read',
    risk: 'low',
    input: checklistListInput,
    fields: { visitId: field('string', true), limit: field('number') },
    run: async (args, companyId, db) => {
      const params = new SqlParams();
      const cap = pageCap(args.limit);
      const result = await need(db).query(
        `SELECT id, company_id, visit_id, section, item_key, label, disposition, note, sort_order
           FROM visit_checklist_items
          WHERE company_id = ${params.add(companyId)} AND visit_id = ${params.add(args.visitId)}
          ORDER BY sort_order, id
          LIMIT ${params.add(cap + 1)}`,
        params.values,
      );
      return bounded(companyId, result.rows, cap, checklistItemOut);
    },
  },
  {
    id: 'job_photos.list',
    access: 'read',
    risk: 'low',
    input: photoListInput,
    fields: { visitId: field('string', true), category: field('string'), limit: field('number') },
    run: async (args, companyId, db) => {
      const params = new SqlParams();
      const where = [`company_id = ${params.add(companyId)}`, `visit_id = ${params.add(args.visitId)}`];
      if (args.category !== undefined) where.push(`category = ${params.add(args.category)}`);
      const cap = pageCap(args.limit);
      const result = await need(db).query(
        `SELECT id, company_id, visit_id, category, original_name, mime_type, size_bytes, created_at
           FROM visit_media
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC, id
          LIMIT ${params.add(cap + 1)}`,
        params.values,
      );
      return bounded(companyId, result.rows, cap, photoOut);
    },
  },

  // ---- plain record writes
  {
    id: 'estimates.create',
    access: 'write',
    risk: 'high',
    input: estimateCreateInput,
    fields: {
      clientId: field('string', true),
      propertyId: field('string'),
      workOrderId: field('string'),
      subtotalCents: field('number', true),
      taxCents: field('number'),
      notes: field('string'),
      internalNotes: field('string'),
    },
    run: async (args, companyId, db) => {
      // Always a draft. Sending a quote is a customer contact and is not done here.
      const taxCents = args.taxCents ?? 0;
      const totalCents = args.subtotalCents + taxCents;
      const result = await need(db).query(
        `INSERT INTO estimates
           (company_id, client_id, property_id, work_order_id, status, subtotal_cents, tax_cents, total_cents,
            notes, internal_notes)
         VALUES ($1, $2, $3, $4, 'draft', $5, $6, $7, $8, $9)
         RETURNING id, status, total_cents`,
        [
          companyId,
          args.clientId,
          args.propertyId ?? null,
          args.workOrderId ?? null,
          args.subtotalCents,
          taxCents,
          totalCents,
          args.notes ?? null,
          args.internalNotes ?? null,
        ],
      );
      const row = firstRow(result.rows, 'estimate insert');
      return { created: true, id: row.id, status: row.status, totalCents: Number(row.total_cents) };
    },
  },
  {
    id: 'crew_rosters.update',
    access: 'write',
    risk: 'high',
    input: rosterUpdateInput,
    fields: {
      id: field('string', true),
      rosterDate: field('string'),
      teamName: field('string'),
      members: field('array'),
      status: field('string'),
    },
    run: async (args, companyId, db) => {
      const params = new SqlParams();
      const companyRef = params.add(companyId);
      const idRef = params.add(args.id);
      const sets: string[] = [];
      if (args.rosterDate !== undefined) sets.push(`roster_date = ${params.add(args.rosterDate)}`);
      if (args.teamName !== undefined) sets.push(`team_name = ${params.add(args.teamName)}`);
      if (args.members !== undefined) sets.push(`members = ${params.add(JSON.stringify(args.members))}::jsonb`);
      if (args.status !== undefined) sets.push(`status = ${params.add(args.status)}`);
      sets.push('updated_at = now()');
      const result = await need(db).query(
        `UPDATE crew_rosters
            SET ${sets.join(', ')}
          WHERE company_id = ${companyRef} AND id = ${idRef}
          RETURNING id, company_id, team_name, status`,
        params.values,
      );
      const row = result.rows.find((candidate) => candidate.company_id === companyId);
      if (row === undefined) return { updated: false };
      return { updated: true, id: row.id, teamName: row.team_name, status: row.status };
    },
  },
  {
    id: 'disputes.create',
    access: 'write',
    risk: 'medium',
    input: disputeCreateInput,
    fields: { clientId: field('string'), summary: field('string', true) },
    run: async (args, companyId, db) => {
      const result = await need(db).query(
        `INSERT INTO disputes (company_id, client_id, kind, summary, status)
         VALUES ($1, $2, 'general', $3, 'open')
         RETURNING id, status`,
        [companyId, args.clientId ?? null, args.summary],
      );
      const row = firstRow(result.rows, 'dispute insert');
      return { created: true, id: row.id, status: row.status };
    },
  },
  {
    id: 'invoice_disputes.create',
    access: 'write',
    risk: 'medium',
    input: invoiceDisputeCreateInput,
    fields: {
      clientId: field('string'),
      invoiceRef: field('string', true),
      summary: field('string', true),
    },
    run: async (args, companyId, db) => {
      const result = await need(db).query(
        `INSERT INTO disputes (company_id, client_id, kind, invoice_ref, summary, status)
         VALUES ($1, $2, 'invoice', $3, $4, 'open')
         RETURNING id, status`,
        [companyId, args.clientId ?? null, args.invoiceRef, args.summary],
      );
      const row = firstRow(result.rows, 'invoice dispute insert');
      return { created: true, id: row.id, status: row.status };
    },
  },
  {
    id: 'end_of_lease_checklists.create',
    access: 'write',
    risk: 'medium',
    input: endOfLeaseCreateInput,
    fields: { title: field('string', true), propertyId: field('string'), items: field('array') },
    run: async (args, companyId, db) => {
      const items = (args.items ?? []).map((item) => ({ label: item.label, done: item.done ?? false }));
      const result = await need(db).query(
        `INSERT INTO end_of_lease_checklists (company_id, property_id, title, status, items)
         VALUES ($1, $2, $3, 'open', $4::jsonb)
         RETURNING id, status`,
        [companyId, args.propertyId ?? null, args.title, JSON.stringify(items)],
      );
      const row = firstRow(result.rows, 'end-of-lease checklist insert');
      return { created: true, id: row.id, status: row.status };
    },
  },
  {
    id: 'feedback_responses.create',
    access: 'write',
    risk: 'medium',
    input: feedbackCreateInput,
    fields: {
      visitId: field('string'),
      clientId: field('string'),
      rating: field('number'),
      comment: field('string'),
    },
    run: async (args, companyId, db) => {
      const result = await need(db).query(
        `INSERT INTO feedback_responses (company_id, visit_id, client_id, rating, comment)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, responded_at`,
        [companyId, args.visitId ?? null, args.clientId ?? null, args.rating ?? null, args.comment ?? null],
      );
      const row = firstRow(result.rows, 'feedback insert');
      return { created: true, id: row.id, respondedAt: iso(row.responded_at) };
    },
  },
  {
    id: 'job_notes.create',
    access: 'write',
    risk: 'low',
    input: jobNoteCreateInput,
    fields: { workOrderId: field('string'), visitId: field('string'), body: field('string', true) },
    run: async (args, companyId, db) => {
      const result = await need(db).query(
        `INSERT INTO job_notes (company_id, work_order_id, visit_id, body)
         VALUES ($1, $2, $3, $4)
         RETURNING id, created_at`,
        [companyId, args.workOrderId ?? null, args.visitId ?? null, args.body],
      );
      const row = firstRow(result.rows, 'job note insert');
      return { created: true, id: row.id, createdAt: iso(row.created_at) };
    },
  },

  // ---- draft (the registry stages drafts and does not run this handler; it is a safe fallback)
  {
    id: 'customer_messages.draft',
    access: 'write',
    risk: 'low',
    input: messageInput,
    fields: { clientId: field('string', true), channel: field('string', true), body: field('string', true) },
    run: async (args) => ({
      status: 'draft',
      sent: false,
      clientId: args.clientId,
      channel: args.channel,
      body: args.body,
    }),
  },

  // ---- customer contact: owner approval first (always-approval list); no outbound provider in this build
  {
    id: 'customer_messages.send',
    access: 'write',
    risk: 'critical',
    category: 'customer_send',
    input: messageInput,
    fields: { clientId: field('string', true), channel: field('string', true), body: field('string', true) },
    run: async () =>
      notImplemented('No outbound messaging provider is wired in this build. Nothing was sent.'),
  },
  {
    id: 'feedback_surveys.send',
    access: 'write',
    risk: 'critical',
    category: 'customer_send',
    input: surveySendInput,
    fields: { clientId: field('string', true), visitId: field('string') },
    run: async () =>
      notImplemented('No outbound messaging provider is wired in this build. Nothing was sent.'),
  },
  {
    id: 'job_photos.request_from_customer',
    access: 'write',
    risk: 'critical',
    category: 'customer_send',
    input: photoRequestInput,
    fields: { visitId: field('string', true), category: field('string'), message: field('string') },
    run: async () =>
      notImplemented('No outbound messaging provider is wired in this build. Nothing was sent.'),
  },

  // ---- no table and no safe write path
  {
    id: 'escalations.create',
    access: 'write',
    risk: 'low',
    input: escalationInput,
    fields: { reason: field('string', true), visitId: field('string'), clientId: field('string') },
    run: async () =>
      notImplemented(
        'No escalation table or owner-review write path exists. The review inbox is derived from runs and is not a write target. Nothing was recorded.',
      ),
  },
  {
    id: 'human_escalation.create',
    access: 'write',
    risk: 'low',
    input: escalationInput,
    fields: { reason: field('string', true), visitId: field('string'), clientId: field('string') },
    run: async () =>
      notImplemented(
        'No escalation table or owner-review write path exists. The review inbox is derived from runs and is not a write target. Nothing was recorded.',
      ),
  },
  {
    id: 'identity.verify_request',
    access: 'write',
    risk: 'critical',
    category: 'customer_send',
    input: identityInput,
    fields: { clientId: field('string', true), method: field('string') },
    run: async () =>
      notImplemented(
        'No identity verification record table exists, and a verification request would contact the customer with no approved path. Nothing was sent.',
      ),
  },
];

/** Input schema per tool id. Tests use it to check valid and invalid inputs. */
export const GROUP01_INPUT_SCHEMAS: Readonly<Record<Group01ToolId, z.ZodTypeAny>> = Object.freeze(
  Object.fromEntries(SPECS.map((spec) => [spec.id, spec.input])) as Record<Group01ToolId, z.ZodTypeAny>,
);

/** Registry definitions for the 18 group 01 tool ids. */
export function createGroup01ToolDefinitions(options: Group01Options = {}): ToolDefinition[] {
  return SPECS.map((spec) => ({
    id: spec.id,
    risk: spec.risk,
    access: spec.access,
    ...(spec.category !== undefined ? { category: spec.category } : {}),
    schema: spec.fields,
    timeoutMs: spec.access === 'read' ? GROUP01_READ_TIMEOUT_MS : GROUP01_WRITE_TIMEOUT_MS,
    handler: async (params: Record<string, unknown>, context: ToolHandlerContext) => {
      const companyId = requireCompanyId(context.companyId);
      const args = parseInput(spec.input, params);
      const db = spec.access === 'read' ? options.db : (context.db ?? options.db);
      return spec.run(args, companyId, db);
    },
  }));
}
