/**
 * Workforce tool group 02: 20 tool ids backed by the workforce tool tables (migrations/0014_workforce_tool_tables.sql,
 * shared/schema.ts "Workforce tool tables").
 *
 * Reads (9): SQL against our tables. Every query has `company_id = $1` with the caller's company id from the
 *   registry context, never from the input. Rows are also filtered by company in JS (defence in depth), and each
 *   output uses an explicit field allow-list. Reads need a SqlExecutor passed to createGroup02ToolDefinitions({ db }).
 * Writes (5): plain record inserts or updates. They use context.db, the action journal executor, so the write commits
 *   with its journal row. Without the journal executor the handler throws and nothing is written.
 * Drafts (1): messages.draft_customer. The registry stages any '*.draft*' tool and never runs its handler. The handler
 *   returns a draft object only. It sends nothing.
 * Side effects (4 not_implemented + 1 approval-gated not_implemented): customer messages, customer sign-off requests,
 *   payment plans and ownership verification have no sender, table or safe path here. They return not_implemented.
 *   Customer sends and money are routed to the registry's always-approval categories through `category`.
 *
 * No network access. Nothing is sent and no money moves from this file.
 */
import { z } from 'zod';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { CompanyId } from '../../../services/ai-runtime/types.ts';
import type { SqlExecutor } from '../../runtime/pg-store.ts';
import { assertAssigneeInCompany } from './assignee-membership.ts';
import type { ToolDefinition, ToolHandlerContext, ToolSchema } from '../../runtime/tool-registry.ts';

export const GROUP_02_READ_TIMEOUT_MS = 10_000;
export const GROUP_02_WRITE_TIMEOUT_MS = 20_000;
export const GROUP_02_MAX_ROWS = 50;

type Row = Record<string, unknown>;
type Risk = ToolDefinition['risk'];
type Category = NonNullable<ToolDefinition['category']>;

// ---- Errors ----------------------------------------------------------------------------------------------------------

export class Group02InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Group02InputError';
  }
}

function requireExecutor(db: SqlExecutor | undefined): SqlExecutor {
  if (!db) throw new Error('read tools need a database executor: createGroup02ToolDefinitions({ db })');
  return db;
}

function journalExecutor(context: ToolHandlerContext): SqlExecutor {
  if (!context.db) throw new Error('write tools need the action journal executor; nothing was written');
  return context.db;
}

// ---- Input schemas (strict: unknown keys, companyId included, are rejected) ----------------------------------------

const uuid = z.string().uuid();
const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const datetimeField = z.string().datetime({ offset: true });
const shortText = (max: number) => z.string().trim().min(1).max(max);
const limitField = z.number().int().min(1).max(GROUP_02_MAX_ROWS).optional();
const money = z.number().int().min(0).max(10_000_000);

const projectsListInput = z
  .object({
    status: z.enum(['draft', 'scheduled', 'in_progress', 'completed', 'cancelled']).optional(),
    clientId: uuid.optional(),
    limit: limitField,
  })
  .strict();
const idInput = z.object({ id: uuid }).strict();
const projectVisitsListInput = z
  .object({
    projectId: uuid.optional(),
    status: z.enum(['scheduled', 'arrived', 'in_progress', 'completed', 'cancelled']).optional(),
    fromDate: dateField.optional(),
    toDate: dateField.optional(),
    limit: limitField,
  })
  .strict();
const propertiesListInput = z.object({ clientId: uuid.optional(), limit: limitField }).strict();
const propertyContactsListInput = z.object({ propertyId: uuid, limit: limitField }).strict();
const poolProfilesListInput = z.object({ propertyId: uuid.optional(), limit: limitField }).strict();
const poolEquipmentListInput = z
  .object({
    poolProfileId: uuid.optional(),
    status: z.enum(['ok', 'fault', 'retired']).optional(),
    limit: limitField,
  })
  .strict();
const partsListInput = z
  .object({
    workOrderId: uuid,
    status: z.enum(['needed', 'purchased', 'on_truck', 'not_needed']).optional(),
    limit: limitField,
  })
  .strict();
const materialsCheckInput = z.object({ workOrderId: uuid }).strict();

const jobSignoffRecordInput = z
  .object({ visitId: uuid, signerName: shortText(200), notes: shortText(1000).optional() })
  .strict();
const maintenancePlanCreateInput = z
  .object({
    clientId: uuid,
    propertyId: uuid.optional(),
    name: shortText(200),
    frequency: z.enum(['monthly', 'quarterly', 'biannual', 'annual']),
    services: z.array(shortText(100)).max(20).default([]),
    priceCents: money.default(0),
    nextScheduledDate: dateField.optional(),
    notes: shortText(2000).optional(),
  })
  .strict();
const opportunityCreateInput = z
  .object({
    clientId: uuid.optional(),
    title: shortText(200),
    stage: z.enum(['new', 'qualified', 'quoted']).default('new'),
    valueCents: money.default(0),
    source: shortText(100).optional(),
    notes: shortText(2000).optional(),
  })
  .strict();
const poolEquipmentFaultCreateInput = z
  .object({
    poolEquipmentId: uuid,
    summary: shortText(500),
    severity: z.enum(['minor', 'moderate', 'major', 'critical']).default('minor'),
  })
  .strict();
const visitItemInput = z
  .object({
    id: uuid.optional(),
    scheduledStart: datetimeField,
    scheduledEnd: datetimeField,
    assignedUserId: uuid.optional(),
    status: z.enum(['scheduled', 'cancelled']).optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.scheduledEnd) > Date.parse(v.scheduledStart), {
    message: 'scheduledEnd must be after scheduledStart',
  });
const projectVisitsBulkInput = z
  .object({ projectId: uuid, visits: z.array(visitItemInput).min(1).max(20) })
  .strict();

const draftCustomerInput = z
  .object({
    clientId: uuid,
    purpose: z.enum(['quote_follow_up', 'payment_reminder', 'appointment', 'general']),
    body: shortText(2000),
  })
  .strict();
const messageSendInput = z.object({ clientId: uuid, body: shortText(2000) }).strict();
const signoffRequestInput = z.object({ visitId: uuid, signerName: shortText(200) }).strict();
const paymentPlanProposeInput = z.object({ clientId: uuid, summary: shortText(1000) }).strict();
const ownershipVerifyInput = z.object({ propertyId: uuid, claimantName: shortText(200) }).strict();

// ---- Shared helpers ---------------------------------------------------------------------------------------------------

function pageSize(requested: number | undefined): number {
  return requested ?? GROUP_02_MAX_ROWS;
}

function iso(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  return value ?? null;
}

/** Builds `company_id = $1 AND ...` with numbered placeholders. Each clause takes one value through `?`. */
class Scope {
  readonly values: unknown[];
  private readonly clauses: string[] = ['company_id = $1'];

  constructor(companyId: CompanyId) {
    this.values = [companyId];
  }

  add(clause: string, value: unknown): this {
    this.values.push(value);
    this.clauses.push(clause.replace('?', `$${this.values.length}`));
    return this;
  }

  where(): string {
    return this.clauses.join(' AND ');
  }
}

/** Table and column names here are constants from this file. Caller values only ever go in `values`. */
async function selectRows(
  db: SqlExecutor | undefined,
  table: string,
  columns: string,
  scope: Scope,
  orderBy: string,
  fetch: number,
): Promise<Row[]> {
  const values = [...scope.values, fetch];
  const text = `SELECT company_id, ${columns} FROM ${table} WHERE ${scope.where()} ORDER BY ${orderBy} LIMIT $${values.length}`;
  const result = await requireExecutor(db).query(text, values);
  return result.rows;
}

interface BoundedList<T> {
  rows: T[];
  count: number;
  truncated: boolean;
  maxRows: number;
}

/** Drops any row that is not this company's, then cuts to the page size. `rows` was fetched with page size + 1. */
function bounded<T>(companyId: CompanyId, rows: Row[], limit: number, shape: (row: Row) => T): BoundedList<T> {
  const own = rows.filter((row) => row.company_id === companyId);
  const kept = own.slice(0, limit).map(shape);
  return { rows: kept, count: kept.length, truncated: own.length > limit, maxRows: GROUP_02_MAX_ROWS };
}

async function getOne(
  db: SqlExecutor | undefined,
  table: string,
  columns: string,
  companyId: CompanyId,
  id: string,
  shape: (row: Row) => unknown,
): Promise<{ found: boolean; row: unknown }> {
  const rows = await selectRows(db, table, columns, new Scope(companyId).add('id = ?', id), 'id', 1);
  const own = rows.find((row) => row.company_id === companyId && row.id === id);
  return own ? { found: true, row: shape(own) } : { found: false, row: null };
}

function notImplemented(toolId: string, reason: string) {
  return { status: 'not_implemented', toolId, reason, executed: false };
}

// ---- Row shapes (explicit allow-lists) ----------------------------------------------------------------------------------

const WORK_ORDER_LIST_COLS = 'id, client_id, property_id, title, status, total_cents, completed_at, created_at';
const WORK_ORDER_GET_COLS = `${WORK_ORDER_LIST_COLS}, scope, site_notes, safety_notes`;
const VISIT_COLS = 'id, work_order_id, assigned_user_id, status, scheduled_start, scheduled_end, arrived_at, completed_at';
const PROPERTY_COLS = 'id, client_id, name, address, city, state, zip';
const CONTACT_COLS = 'id, property_id, client_id, external_name, role';
const POOL_PROFILE_COLS = 'id, property_id, name, volume_litres, sanitiser';
const POOL_EQUIPMENT_COLS = 'id, pool_profile_id, kind, make, model, serial, installed_on, status';
const MATERIAL_LINE_COLS = 'id, work_order_id, name, quantity, unit_label, store_section, status, source, sku, sort_order';

function workOrderShape(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id,
    propertyId: row.property_id,
    title: row.title,
    status: row.status,
    totalCents: row.total_cents,
    completedAt: iso(row.completed_at),
    createdAt: iso(row.created_at),
  };
}

function workOrderDetailShape(row: Row) {
  return {
    ...workOrderShape(row),
    scope: row.scope ?? null,
    siteNotes: row.site_notes ?? null,
    safetyNotes: row.safety_notes ?? null,
  };
}

function visitShape(row: Row) {
  return {
    id: row.id,
    projectId: row.work_order_id,
    assignedUserId: row.assigned_user_id ?? null,
    status: row.status,
    scheduledStart: iso(row.scheduled_start),
    scheduledEnd: iso(row.scheduled_end),
    arrivedAt: iso(row.arrived_at),
    completedAt: iso(row.completed_at),
  };
}

function propertyShape(row: Row) {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name ?? null,
    address: row.address,
    city: row.city ?? null,
    state: row.state ?? null,
    zip: row.zip ?? null,
  };
}

/** Name and role only. Phone, email and notes are left out: this list is for routing, not for contacting. */
function contactShape(row: Row) {
  return {
    id: row.id,
    propertyId: row.property_id,
    clientId: row.client_id ?? null,
    name: row.external_name ?? null,
    role: row.role,
  };
}

function poolProfileShape(row: Row) {
  return {
    id: row.id,
    propertyId: row.property_id ?? null,
    name: row.name,
    volumeLitres: row.volume_litres ?? null,
    sanitiser: row.sanitiser ?? null,
  };
}

function poolEquipmentShape(row: Row) {
  return {
    id: row.id,
    poolProfileId: row.pool_profile_id,
    kind: row.kind,
    make: row.make ?? null,
    model: row.model ?? null,
    serial: row.serial ?? null,
    installedOn: iso(row.installed_on),
    status: row.status,
  };
}

function materialLineShape(row: Row) {
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    name: row.name,
    quantity: row.quantity,
    unitLabel: row.unit_label ?? null,
    storeSection: row.store_section ?? null,
    status: row.status,
    source: row.source,
    sku: row.sku ?? null,
    sortOrder: row.sort_order,
  };
}

// ---- Read handlers ------------------------------------------------------------------------------------------------------

interface Env {
  companyId: CompanyId;
  db: SqlExecutor | undefined;
  context: ToolHandlerContext;
}

async function projectsList(a: z.infer<typeof projectsListInput>, env: Env) {
  const scope = new Scope(env.companyId);
  if (a.status) scope.add('status = ?', a.status);
  if (a.clientId) scope.add('client_id = ?', a.clientId);
  const limit = pageSize(a.limit);
  const rows = await selectRows(env.db, 'work_orders', WORK_ORDER_LIST_COLS, scope, 'created_at DESC, id', limit + 1);
  return bounded(env.companyId, rows, limit, workOrderShape);
}

function projectsGet(a: z.infer<typeof idInput>, env: Env) {
  return getOne(env.db, 'work_orders', WORK_ORDER_GET_COLS, env.companyId, a.id, workOrderDetailShape);
}

async function projectVisitsList(a: z.infer<typeof projectVisitsListInput>, env: Env) {
  const scope = new Scope(env.companyId);
  if (a.projectId) scope.add('work_order_id = ?', a.projectId);
  if (a.status) scope.add('status = ?', a.status);
  if (a.fromDate) scope.add('scheduled_start::date >= ?::date', a.fromDate);
  if (a.toDate) scope.add('scheduled_start::date <= ?::date', a.toDate);
  const limit = pageSize(a.limit);
  const rows = await selectRows(env.db, 'visits', VISIT_COLS, scope, 'scheduled_start, id', limit + 1);
  return bounded(env.companyId, rows, limit, visitShape);
}

async function propertiesList(a: z.infer<typeof propertiesListInput>, env: Env) {
  const scope = new Scope(env.companyId);
  if (a.clientId) scope.add('client_id = ?', a.clientId);
  const limit = pageSize(a.limit);
  const rows = await selectRows(env.db, 'properties', PROPERTY_COLS, scope, 'address, id', limit + 1);
  return bounded(env.companyId, rows, limit, propertyShape);
}

async function propertyContactsList(a: z.infer<typeof propertyContactsListInput>, env: Env) {
  const limit = pageSize(a.limit);
  const scope = new Scope(env.companyId).add('property_id = ?', a.propertyId);
  const rows = await selectRows(env.db, 'property_contacts', CONTACT_COLS, scope, 'role, id', limit + 1);
  return bounded(env.companyId, rows, limit, contactShape);
}

async function poolProfilesList(a: z.infer<typeof poolProfilesListInput>, env: Env) {
  const scope = new Scope(env.companyId);
  if (a.propertyId) scope.add('property_id = ?', a.propertyId);
  const limit = pageSize(a.limit);
  const rows = await selectRows(env.db, 'pool_profiles', POOL_PROFILE_COLS, scope, 'name, id', limit + 1);
  return bounded(env.companyId, rows, limit, poolProfileShape);
}

async function poolEquipmentList(a: z.infer<typeof poolEquipmentListInput>, env: Env) {
  const scope = new Scope(env.companyId);
  if (a.poolProfileId) scope.add('pool_profile_id = ?', a.poolProfileId);
  if (a.status) scope.add('status = ?', a.status);
  const limit = pageSize(a.limit);
  const rows = await selectRows(env.db, 'pool_equipment', POOL_EQUIPMENT_COLS, scope, 'kind, id', limit + 1);
  return bounded(env.companyId, rows, limit, poolEquipmentShape);
}

async function partsList(a: z.infer<typeof partsListInput>, env: Env) {
  const scope = new Scope(env.companyId).add('work_order_id = ?', a.workOrderId);
  if (a.status) scope.add('status = ?', a.status);
  const limit = pageSize(a.limit);
  const rows = await selectRows(env.db, 'job_material_lines', MATERIAL_LINE_COLS, scope, 'sort_order, id', limit + 1);
  return bounded(env.companyId, rows, limit, materialLineShape);
}

async function materialsCheck(a: z.infer<typeof materialsCheckInput>, env: Env) {
  const scope = new Scope(env.companyId).add('work_order_id = ?', a.workOrderId);
  const rows = await selectRows(env.db, 'job_material_lines', MATERIAL_LINE_COLS, scope, 'sort_order, id', GROUP_02_MAX_ROWS + 1);
  const lines = bounded(env.companyId, rows, GROUP_02_MAX_ROWS, materialLineShape);
  const count = await requireExecutor(env.db).query(
    "SELECT company_id, count(*)::int AS needed FROM job_material_lines WHERE company_id = $1 AND work_order_id = $2 AND status = 'needed' GROUP BY company_id",
    [env.companyId, a.workOrderId],
  );
  const neededCount = Number(count.rows.find((row) => row.company_id === env.companyId)?.needed ?? 0);
  return { workOrderId: a.workOrderId, neededCount, ready: neededCount === 0, lines };
}

// ---- Write handlers (journal executor only) ----------------------------------------------------------------------------

async function jobSignoffRecord(a: z.infer<typeof jobSignoffRecordInput>, env: Env) {
  const result = await journalExecutor(env.context).query(
    `INSERT INTO job_signoffs (company_id, visit_id, signer_name, notes)
     VALUES ($1, $2, $3, $4)
     RETURNING id, visit_id, signer_name, signed_at, notes`,
    [env.companyId, a.visitId, a.signerName, a.notes ?? null],
  );
  const row = result.rows[0] ?? {};
  return { id: row.id, visitId: row.visit_id, signerName: row.signer_name, signedAt: iso(row.signed_at), notes: row.notes ?? null };
}

async function maintenancePlanCreate(a: z.infer<typeof maintenancePlanCreateInput>, env: Env) {
  const result = await journalExecutor(env.context).query(
    `INSERT INTO maintenance_plans
       (company_id, client_id, property_id, name, frequency, services, price_cents, next_scheduled_date, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, client_id, property_id, name, frequency, services, price_cents, status, next_scheduled_date`,
    [
      env.companyId,
      a.clientId,
      a.propertyId ?? null,
      a.name,
      a.frequency,
      a.services,
      a.priceCents,
      a.nextScheduledDate ?? null,
      a.notes ?? null,
    ],
  );
  const row = result.rows[0] ?? {};
  return {
    id: row.id,
    clientId: row.client_id,
    propertyId: row.property_id ?? null,
    name: row.name,
    frequency: row.frequency,
    services: row.services ?? [],
    priceCents: row.price_cents,
    status: row.status,
    nextScheduledDate: iso(row.next_scheduled_date),
  };
}

async function opportunityCreate(a: z.infer<typeof opportunityCreateInput>, env: Env) {
  const result = await journalExecutor(env.context).query(
    `INSERT INTO opportunities (company_id, client_id, title, stage, value_cents, source, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, client_id, title, stage, value_cents, source`,
    [env.companyId, a.clientId ?? null, a.title, a.stage, a.valueCents, a.source ?? null, a.notes ?? null],
  );
  const row = result.rows[0] ?? {};
  return { id: row.id, clientId: row.client_id ?? null, title: row.title, stage: row.stage, valueCents: row.value_cents, source: row.source ?? null };
}

async function poolFaultCreate(a: z.infer<typeof poolEquipmentFaultCreateInput>, env: Env) {
  const result = await journalExecutor(env.context).query(
    `INSERT INTO pool_equipment_faults (company_id, pool_equipment_id, summary, severity)
     VALUES ($1, $2, $3, $4)
     RETURNING id, pool_equipment_id, summary, severity, status, reported_at`,
    [env.companyId, a.poolEquipmentId, a.summary, a.severity],
  );
  const row = result.rows[0] ?? {};
  return {
    id: row.id,
    poolEquipmentId: row.pool_equipment_id,
    summary: row.summary,
    severity: row.severity,
    status: row.status,
    reportedAt: iso(row.reported_at),
  };
}

/**
 * Creates visits for a project, or revises visits already on it (when `id` is given). Runs in the journal transaction,
 * so one bad item rolls back the whole batch. A revised visit must belong to this project and this company.
 */
async function projectVisitsBulk(a: z.infer<typeof projectVisitsBulkInput>, env: Env) {
  const db = journalExecutor(env.context);
  const created: unknown[] = [];
  const updated: unknown[] = [];
  for (const item of a.visits) await assertAssigneeInCompany(db, env.companyId, item.assignedUserId);
  for (const item of a.visits) {
    if (item.id) {
      const result = await db.query(
        `UPDATE visits
            SET scheduled_start = $1,
                scheduled_end = $2,
                assigned_user_id = COALESCE($3, assigned_user_id),
                status = COALESCE($4, status),
                updated_at = now()
          WHERE company_id = $5 AND work_order_id = $6 AND id = $7
          RETURNING id`,
        [
          item.scheduledStart,
          item.scheduledEnd,
          item.assignedUserId ?? null,
          item.status ?? null,
          env.companyId,
          a.projectId,
          item.id,
        ],
      );
      if (result.rows.length === 0) throw new Error('visit not found on this project; batch rolled back');
      updated.push(item.id);
    } else {
      const result = await db.query(
        `INSERT INTO visits (company_id, work_order_id, assigned_user_id, status, scheduled_start, scheduled_end)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [env.companyId, a.projectId, item.assignedUserId ?? null, item.status ?? 'scheduled', item.scheduledStart, item.scheduledEnd],
      );
      created.push(result.rows[0]?.id);
    }
  }
  return { projectId: a.projectId, created, updated };
}

// ---- Draft (staged by the registry, never executed there) -----------------------------------------------------------------

async function messageDraftCustomer(a: z.infer<typeof draftCustomerInput>, env: Env) {
  const client = await requireExecutor(env.db).query(
    'SELECT company_id, id FROM clients WHERE company_id = $1 AND id = $2',
    [env.companyId, a.clientId],
  );
  if (!client.rows.some((row) => row.company_id === env.companyId && row.id === a.clientId)) {
    return { status: 'not_found', found: false };
  }
  return { status: 'draft', sent: false, draft: { clientId: a.clientId, purpose: a.purpose, body: a.body } };
}

// ---- Not implemented (no table, sender or safe path) -----------------------------------------------------------------------

const NOT_IMPLEMENTED_REASON: Record<string, string> = {
  'messages.send': 'No outbound customer message sender exists in this codebase. Approval is required, and this handler does not send.',
  'messages.send_customer': 'No outbound customer message sender exists in this codebase. Approval is required, and this handler does not send.',
  'job_signoff.request': 'No customer sign-off request sender exists. Approval is required, and this handler does not send.',
  'payment_plans.propose': 'There is no payment plan table. Payment plans are money decisions and need an owner-approved path that does not exist yet.',
  'ownership.verify': 'There is no ownership verification record. Ownership or identity checks need a verified source before anything can be written.',
};

// ---- Definitions ---------------------------------------------------------------------------------------------------------------

type FieldKind = 'string' | 'number' | 'boolean' | 'object' | 'array';
/** Field-type schema for the registry. `'string!'` marks a required field. Zod is the stricter check. */
function fields(spec: Record<string, FieldKind | `${FieldKind}!`>): ToolSchema {
  const out: Record<string, { type: FieldKind; required?: boolean }> = {};
  for (const [name, kind] of Object.entries(spec)) {
    out[name] = kind.endsWith('!') ? { type: kind.slice(0, -1) as FieldKind, required: true } : { type: kind as FieldKind };
  }
  return out;
}

interface Spec {
  id: string;
  access: 'read' | 'write';
  risk: Risk;
  category?: Category;
  schema: ToolSchema;
  input: z.ZodTypeAny;
  run: (args: unknown, env: Env) => Promise<unknown>;
}

function spec<S extends z.ZodTypeAny>(def: {
  id: string;
  access: 'read' | 'write';
  risk: Risk;
  category?: Category;
  schema: ToolSchema;
  input: S;
  run: (args: z.infer<S>, env: Env) => Promise<unknown>;
}): Spec {
  return {
    id: def.id,
    access: def.access,
    risk: def.risk,
    category: def.category,
    schema: def.schema,
    input: def.input,
    run: (args, env) => def.run(args as z.infer<S>, env),
  };
}

const READS: Spec[] = [
  spec({ id: 'projects.list', access: 'read', risk: 'low', schema: fields({ status: 'string', clientId: 'string', limit: 'number' }), input: projectsListInput, run: projectsList }),
  spec({ id: 'projects.get', access: 'read', risk: 'low', schema: fields({ id: 'string!' }), input: idInput, run: projectsGet }),
  spec({ id: 'project_visits.list', access: 'read', risk: 'low', schema: fields({ projectId: 'string', status: 'string', fromDate: 'string', toDate: 'string', limit: 'number' }), input: projectVisitsListInput, run: projectVisitsList }),
  spec({ id: 'properties.list', access: 'read', risk: 'low', schema: fields({ clientId: 'string', limit: 'number' }), input: propertiesListInput, run: propertiesList }),
  spec({ id: 'property_contacts.list', access: 'read', risk: 'low', schema: fields({ propertyId: 'string!', limit: 'number' }), input: propertyContactsListInput, run: propertyContactsList }),
  spec({ id: 'pool_profiles.list', access: 'read', risk: 'low', schema: fields({ propertyId: 'string', limit: 'number' }), input: poolProfilesListInput, run: poolProfilesList }),
  spec({ id: 'pool_equipment.list', access: 'read', risk: 'low', schema: fields({ poolProfileId: 'string', status: 'string', limit: 'number' }), input: poolEquipmentListInput, run: poolEquipmentList }),
  spec({ id: 'parts_lists.list', access: 'read', risk: 'low', schema: fields({ workOrderId: 'string!', status: 'string', limit: 'number' }), input: partsListInput, run: partsList }),
  spec({ id: 'materials.check', access: 'read', risk: 'low', schema: fields({ workOrderId: 'string!' }), input: materialsCheckInput, run: materialsCheck }),
];

const WRITES: Spec[] = [
  spec({ id: 'job_signoff.record', access: 'write', risk: 'high', schema: fields({ visitId: 'string!', signerName: 'string!', notes: 'string' }), input: jobSignoffRecordInput, run: jobSignoffRecord }),
  spec({ id: 'maintenance_plans.create', access: 'write', risk: 'high', schema: fields({ clientId: 'string!', propertyId: 'string', name: 'string!', frequency: 'string!', services: 'array', priceCents: 'number', nextScheduledDate: 'string', notes: 'string' }), input: maintenancePlanCreateInput, run: maintenancePlanCreate }),
  spec({ id: 'opportunities.create', access: 'write', risk: 'medium', schema: fields({ clientId: 'string', title: 'string!', stage: 'string', valueCents: 'number', source: 'string', notes: 'string' }), input: opportunityCreateInput, run: opportunityCreate }),
  spec({ id: 'pool_equipment_faults.create', access: 'write', risk: 'medium', schema: fields({ poolEquipmentId: 'string!', summary: 'string!', severity: 'string' }), input: poolEquipmentFaultCreateInput, run: poolFaultCreate }),
  spec({ id: 'project_visits.bulk', access: 'write', risk: 'high', schema: fields({ projectId: 'string!', visits: 'array!' }), input: projectVisitsBulkInput, run: projectVisitsBulk }),
];

const DRAFTS: Spec[] = [
  // Draft-named: the registry stages it and never runs this handler. The handler itself sends nothing.
  spec({ id: 'messages.draft_customer', access: 'write', risk: 'low', schema: fields({ clientId: 'string!', purpose: 'string!', body: 'string!' }), input: draftCustomerInput, run: messageDraftCustomer }),
];

const NOT_IMPLEMENTED: Spec[] = [
  spec({ id: 'messages.send', access: 'write', risk: 'critical', category: 'customer_send', schema: fields({ clientId: 'string!', body: 'string!' }), input: messageSendInput, run: async () => notImplemented('messages.send', NOT_IMPLEMENTED_REASON['messages.send']) }),
  spec({ id: 'messages.send_customer', access: 'write', risk: 'critical', category: 'customer_send', schema: fields({ clientId: 'string!', body: 'string!' }), input: messageSendInput, run: async () => notImplemented('messages.send_customer', NOT_IMPLEMENTED_REASON['messages.send_customer']) }),
  spec({ id: 'job_signoff.request', access: 'write', risk: 'critical', category: 'customer_send', schema: fields({ visitId: 'string!', signerName: 'string!' }), input: signoffRequestInput, run: async () => notImplemented('job_signoff.request', NOT_IMPLEMENTED_REASON['job_signoff.request']) }),
  spec({ id: 'payment_plans.propose', access: 'write', risk: 'critical', category: 'money', schema: fields({ clientId: 'string!', summary: 'string!' }), input: paymentPlanProposeInput, run: async () => notImplemented('payment_plans.propose', NOT_IMPLEMENTED_REASON['payment_plans.propose']) }),
  spec({ id: 'ownership.verify', access: 'write', risk: 'high', schema: fields({ propertyId: 'string!', claimantName: 'string!' }), input: ownershipVerifyInput, run: async () => notImplemented('ownership.verify', NOT_IMPLEMENTED_REASON['ownership.verify']) }),
];

const ALL_SPECS: Spec[] = [...READS, ...WRITES, ...DRAFTS, ...NOT_IMPLEMENTED];

/** Every tool id in group 02. */
export const GROUP_02_TOOL_IDS: readonly string[] = Object.freeze(ALL_SPECS.map((s) => s.id));

/** Ids whose handler returns not_implemented. They stay unmapped in the handler-map ratchet. */
export const GROUP_02_NOT_IMPLEMENTED_IDS: readonly string[] = Object.freeze(NOT_IMPLEMENTED.map((s) => s.id));

/** Zod input schema per id. The handler parses with these, and rejects unknown keys (companyId included). */
export const GROUP_02_INPUT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze(
  Object.fromEntries(ALL_SPECS.map((s) => [s.id, s.input])),
);

function parseInput(schema: z.ZodTypeAny, input: unknown): unknown {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Field names only. Values are never echoed back.
    const names = result.error.issues.flatMap((issue) => (issue.code === 'unrecognized_keys' ? issue.keys : [issue.path.join('.') || '(input)']));
    throw new Group02InputError(`invalid input: ${[...new Set(names)].join(', ')}`);
  }
  return result.data;
}

/**
 * Registry definitions for group 02. `db` is the read executor (a pool or client). Writes never use it: they use
 * context.db, the journal executor. Call with no argument and every read refuses until a db is passed.
 */
export function createGroup02ToolDefinitions(options: { db?: SqlExecutor } = {}): ToolDefinition[] {
  return ALL_SPECS.map((s) => ({
    id: s.id,
    risk: s.risk,
    access: s.access,
    ...(s.category !== undefined ? { category: s.category } : {}),
    schema: s.schema,
    timeoutMs: s.access === 'read' ? GROUP_02_READ_TIMEOUT_MS : GROUP_02_WRITE_TIMEOUT_MS,
    handler: async (params, context) => {
      const env: Env = { companyId: requireCompanyId(context.companyId), db: options.db, context };
      return s.run(parseInput(s.input, params), env);
    },
  }));
}
