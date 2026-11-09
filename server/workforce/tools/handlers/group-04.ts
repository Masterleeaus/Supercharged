/**
 * Group 04 workforce tool handlers: visits and service visits, work orders, service schedules, properties (sites),
 * water tests, staff and technician tasks, timesheets, supplier bills and users.
 *
 * Each tool id maps to one table in shared/schema.ts (migration 0014), or returns not_implemented with a reason.
 *   - Every query is scoped by the companyId in the handler context, which the registry takes from the authenticated
 *     caller. It is never read from the input. Input schemas are strict, so a companyId key is refused.
 *   - Reads select an explicit column list. Rows whose company_id differs are dropped again here, as a second check.
 *   - Writes are plain record changes on one table. None sends a message, moves money or contacts a customer, so
 *     no send, pay, refund or escalate path is needed. Every write is access 'write' and goes through the registry
 *     gate (risk tier, policy, approval and audit) like any other write.
 *   - Queries run on context.db when the registry passes an action-journal transaction (writes only). Otherwise they
 *     run on the executor passed to createGroup04ToolDefinitions.
 *
 * Only this module and read-handlers.ts (which spreads its definitions in) import it. No network, no environment.
 */
import { z } from 'zod';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { CompanyId } from '../../../services/ai-runtime/types.ts';
import type { SqlExecutor } from '../../runtime/pg-store.ts';
import type { RiskTier, ToolDefinition, ToolHandlerContext, ToolSchema } from '../../runtime/tool-registry.ts';

export const GROUP04_MAX_ROWS = 50;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 20_000;

/** Tool ids in this group that have no table and no safe path. They return not_implemented and are not counted as bound. */
export const GROUP04_NOT_IMPLEMENTED: readonly string[] = ['site_visits.schedule'];

export interface Group04Options {
  /** Executor for reads, and for writes that do not run inside the action journal. */
  db?: SqlExecutor;
}

export class Group04InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Group04InputError';
  }
}

// ---- Input schemas (strict: unknown keys, companyId included, are refused) --------------------------------------

const uuid = z.string().uuid();
const limit = z.number().int().min(1).max(GROUP04_MAX_ROWS).optional();
const isoTime = z.string().datetime({ offset: true });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const shortText = (max: number) => z.string().trim().min(1).max(max);

const visitStatus = z.enum(['scheduled', 'arrived', 'in_progress', 'completed', 'cancelled']);
const workOrderStatus = z.enum(['draft', 'scheduled', 'in_progress', 'completed', 'cancelled']);
const planStatus = z.enum(['active', 'paused', 'cancelled']);
const planFrequency = z.enum(['monthly', 'quarterly', 'biannual', 'annual']);
const timesheetStatus = z.enum(['open', 'submitted', 'approved']);
const supplierBillStatus = z.enum(['received', 'matched', 'disputed', 'paid']);
const taskPriority = z.enum(['low', 'normal', 'high', 'urgent']);

/** A visit window must end after it starts. Checked only when both ends are given. */
const windowOk = (v: { scheduledStart?: string; scheduledEnd?: string }): boolean =>
  v.scheduledStart === undefined || v.scheduledEnd === undefined || Date.parse(v.scheduledEnd) > Date.parse(v.scheduledStart);
const windowMessage = { message: 'scheduledEnd must be after scheduledStart', path: ['scheduledEnd'] };

const taskInput = z
  .object({
    title: shortText(200),
    description: z.string().max(2000).optional(),
    priority: taskPriority.optional(),
    dueAt: isoTime.optional(),
    assigneeUserId: uuid.optional(),
    workOrderId: uuid.optional(),
    visitId: uuid.optional(),
  })
  .strict();

const visitWindowInput = z
  .object({
    scheduledStart: isoTime,
    scheduledEnd: isoTime,
    assignedUserId: uuid.optional(),
  })
  .strict();

const schemas = {
  'service_schedules.list': z
    .object({ status: planStatus.optional(), frequency: planFrequency.optional(), dueBefore: day.optional(), limit })
    .strict(),
  'service_visits.list': z
    .object({
      status: visitStatus.optional(),
      workOrderId: uuid.optional(),
      fromDate: day.optional(),
      toDate: day.optional(),
      limit,
    })
    .strict(),
  'service_visits.schedule': z
    .object({ workOrderId: uuid, scheduledStart: isoTime, scheduledEnd: isoTime, assignedUserId: uuid.optional() })
    .strict()
    .refine(windowOk, windowMessage),
  'service_visits.reschedule': z
    .object({ visitId: uuid })
    .merge(visitWindowInput)
    .strict()
    .refine(windowOk, windowMessage),
  'site_visits.schedule': z.object({ propertyId: uuid.optional() }).strict(),
  'sites.list': z.object({ clientId: uuid.optional(), limit }).strict(),
  'staff_tasks.create': taskInput,
  'technician_tasks.create': taskInput,
  'supplier_bills.list': z
    .object({ status: supplierBillStatus.optional(), purchaseOrderId: uuid.optional(), limit })
    .strict(),
  'timesheets.list': z
    .object({
      userId: uuid.optional(),
      status: timesheetStatus.optional(),
      fromDate: day.optional(),
      toDate: day.optional(),
      limit,
    })
    .strict(),
  'timesheet_flags.create': z.object({ timesheetId: uuid, reason: shortText(500) }).strict(),
  'users.list': z.object({ limit }).strict(),
  'visits.get': z.object({ id: uuid }).strict(),
  'visits.transition': z
    .object({ id: uuid, to: z.enum(['arrived', 'in_progress', 'completed', 'cancelled']) })
    .strict(),
  'visits.update': z
    .object({
      id: uuid,
      scheduledStart: isoTime.optional(),
      scheduledEnd: isoTime.optional(),
      assignedUserId: uuid.optional(),
      techNotes: z.string().max(5000).optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).some((key) => key !== 'id'), {
      message: 'at least one field to change is required',
      path: ['id'],
    })
    .refine(windowOk, windowMessage),
  'water_test_results.list': z.object({ poolProfileId: uuid.optional(), limit }).strict(),
  'water_tests.schedule': z.object({ poolProfileId: uuid, scheduledFor: isoTime }).strict(),
  'work_notes.list': z
    .object({ workOrderId: uuid.optional(), visitId: uuid.optional(), limit })
    .strict()
    .refine((v) => v.workOrderId !== undefined || v.visitId !== undefined, {
      message: 'workOrderId or visitId is required',
      path: ['workOrderId'],
    }),
  'work_orders.list': z
    .object({
      status: workOrderStatus.optional(),
      clientId: uuid.optional(),
      propertyId: uuid.optional(),
      limit,
    })
    .strict(),
  'work_orders.start_visit': z.object({ workOrderId: uuid, visitId: uuid }).strict(),
} as const;

/** The zod schema each id is checked against. Exported so tests can exercise it directly. */
export const GROUP04_INPUT_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = schemas;

// ---- Helpers ----------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** Builds positional parameters. $1 is always the company id, so every query is scoped by its first parameter. */
class Params {
  readonly values: unknown[];

  constructor(companyId: CompanyId) {
    this.values = [companyId];
  }

  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

function parseInput<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Field names only. Values are never echoed back.
    const fields = result.error.issues.flatMap((issue) => {
      if (issue.code === 'unrecognized_keys') return issue.keys;
      return [issue.path.join('.') || '(input)'];
    });
    throw new Group04InputError(`invalid input: ${[...new Set(fields)].join(', ')}`);
  }
  return result.data;
}

function iso(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : (value ?? null);
}

/** A date-only column comes back as a local-midnight Date from the driver. Format it in local time, not UTC. */
function dateOnly(value: unknown): unknown {
  if (!(value instanceof Date)) return value ?? null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/**
 * Runs a list query with LIMIT cap + 1, keeps only rows of this company, cuts to cap, and reports truncation.
 * The query text must start its WHERE clause with `company_id = $1` (the Params company id).
 */
async function listRows(
  db: SqlExecutor,
  companyId: CompanyId,
  text: string,
  params: Params,
  requested: number | undefined,
  shape: (row: Row) => Row,
): Promise<{ rows: Row[]; count: number; truncated: boolean; maxRows: number }> {
  const cap = requested ?? GROUP04_MAX_ROWS;
  const limitRef = params.add(cap + 1);
  const result = await db.query(`${text} LIMIT ${limitRef}`, params.values);
  const own = result.rows.filter((row) => row.company_id === companyId);
  const kept = own.slice(0, cap).map(shape);
  return { rows: kept, count: kept.length, truncated: own.length > cap, maxRows: GROUP04_MAX_ROWS };
}

async function getOne(
  db: SqlExecutor,
  companyId: CompanyId,
  text: string,
  id: string,
  shape: (row: Row) => Row,
): Promise<{ found: boolean; row: Row | null }> {
  const params = new Params(companyId);
  const idRef = params.add(id);
  const result = await db.query(`${text} AND id = ${idRef}`, params.values);
  const row = result.rows.find((r) => r.company_id === companyId && r.id === id);
  return row ? { found: true, row: shape(row) } : { found: false, row: null };
}

// ---- Shapes (explicit allow-lists: no free-text bodies beyond what the tool needs, no gateway or credential fields) --

const planShape = (r: Row) => ({
  id: r.id,
  clientId: r.client_id,
  propertyId: r.property_id ?? null,
  name: r.name,
  frequency: r.frequency,
  status: r.status,
  nextScheduledDate: dateOnly(r.next_scheduled_date),
});

const visitShape = (r: Row) => ({
  id: r.id,
  workOrderId: r.work_order_id,
  assignedUserId: r.assigned_user_id ?? null,
  status: r.status,
  scheduledStart: iso(r.scheduled_start),
  scheduledEnd: iso(r.scheduled_end),
  arrivedAt: iso(r.arrived_at),
  completedAt: iso(r.completed_at),
});

const propertyShape = (r: Row) => ({
  id: r.id,
  clientId: r.client_id,
  name: r.name ?? null,
  address: r.address,
  city: r.city ?? null,
  state: r.state ?? null,
  zip: r.zip ?? null,
});

const supplierBillShape = (r: Row) => ({
  id: r.id,
  purchaseOrderId: r.purchase_order_id ?? null,
  supplierName: r.supplier_name,
  billNumber: r.bill_number ?? null,
  amountCents: r.amount_cents,
  dueDate: dateOnly(r.due_date),
  status: r.status,
  receivedAt: iso(r.received_at),
});

const timesheetShape = (r: Row) => ({
  id: r.id,
  userId: r.user_id,
  workDate: dateOnly(r.work_date),
  startedAt: iso(r.started_at),
  endedAt: iso(r.ended_at),
  hours: r.hours,
  status: r.status,
});

const waterResultShape = (r: Row) => ({
  id: r.id,
  waterTestId: r.water_test_id ?? null,
  poolProfileId: r.pool_profile_id,
  testedAt: iso(r.tested_at),
  freeChlorine: r.free_chlorine ?? null,
  ph: r.ph ?? null,
  totalAlkalinityPpm: r.total_alkalinity_ppm ?? null,
  notes: r.notes ?? null,
});

const jobNoteShape = (r: Row) => ({
  id: r.id,
  workOrderId: r.work_order_id ?? null,
  visitId: r.visit_id ?? null,
  body: r.body,
  authorUserId: r.author_user_id ?? null,
  createdAt: iso(r.created_at),
});

const workOrderShape = (r: Row) => ({
  id: r.id,
  clientId: r.client_id,
  propertyId: r.property_id ?? null,
  title: r.title,
  status: r.status,
  totalCents: r.total_cents,
  completedAt: iso(r.completed_at),
});

const userShape = (r: Row) => ({ id: r.id, name: r.name, isActive: r.is_active });

// ---- Definitions ------------------------------------------------------------------------------------------------

interface Spec<S extends z.ZodTypeAny> {
  id: string;
  access: 'read' | 'write';
  risk: RiskTier;
  timeoutMs: number;
  schema: ToolSchema;
  input: S;
  /** db resolves the executor lazily, so a tool that returns not_implemented never needs one. */
  run: (db: () => SqlExecutor, companyId: CompanyId, args: z.output<S>) => Promise<unknown>;
}

function fields(types: Record<string, 'string' | 'number'>, required: readonly string[] = []): ToolSchema {
  const out: Record<string, { type: 'string' | 'number'; required?: boolean }> = {};
  for (const [name, type] of Object.entries(types)) {
    out[name] = required.includes(name) ? { type, required: true } : { type };
  }
  return out;
}

function define<S extends z.ZodTypeAny>(spec: Spec<S>): Spec<S> {
  return spec;
}

/** Scheduling and visits share one write shape: a single visit row, guarded by company_id. */
const VISIT_OPEN = "('scheduled', 'arrived', 'in_progress')";

/** The status each visit transition may start from. */
const TRANSITION_FROM: Readonly<Record<string, readonly string[]>> = {
  arrived: ['scheduled'],
  in_progress: ['scheduled', 'arrived'],
  completed: ['in_progress'],
  cancelled: ['scheduled', 'arrived', 'in_progress'],
};

const notImplemented = (reason: string) => async () => ({ status: 'not_implemented', reason });

const SPECS: ReadonlyArray<Spec<z.ZodTypeAny>> = [
  define({
    id: 'service_schedules.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    schema: fields({ status: 'string', frequency: 'string', dueBefore: 'string', limit: 'number' }),
    input: schemas['service_schedules.list'],
    run: async (db, companyId, a) => {
      const p = new Params(companyId);
      const where = ['company_id = $1'];
      if (a.status) where.push(`status = ${p.add(a.status)}`);
      if (a.frequency) where.push(`frequency = ${p.add(a.frequency)}`);
      if (a.dueBefore) where.push(`next_scheduled_date <= ${p.add(a.dueBefore)}::date`);
      const text = `SELECT company_id, id, client_id, property_id, name, frequency, status, next_scheduled_date FROM maintenance_plans WHERE ${where.join(' AND ')} ORDER BY next_scheduled_date ASC NULLS LAST, id`;
      return listRows(db(), companyId, text, p, a.limit, planShape);
    },
  }),

  define({
    id: 'service_visits.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    schema: fields({ status: 'string', workOrderId: 'string', fromDate: 'string', toDate: 'string', limit: 'number' }),
    input: schemas['service_visits.list'],
    run: async (db, companyId, a) => {
      const p = new Params(companyId);
      const where = ['company_id = $1'];
      if (a.status) where.push(`status = ${p.add(a.status)}`);
      if (a.workOrderId) where.push(`work_order_id = ${p.add(a.workOrderId)}`);
      if (a.fromDate) where.push(`scheduled_start >= ${p.add(a.fromDate)}::date`);
      if (a.toDate) where.push(`scheduled_start < (${p.add(a.toDate)}::date + 1)`);
      const text = `SELECT company_id, id, work_order_id, assigned_user_id, status, scheduled_start, scheduled_end, arrived_at, completed_at FROM visits WHERE ${where.join(' AND ')} ORDER BY scheduled_start ASC, id`;
      return listRows(db(), companyId, text, p, a.limit, visitShape);
    },
  }),

  define({
    id: 'service_visits.schedule',
    access: 'write',
    risk: 'medium',
    timeoutMs: WRITE_TIMEOUT_MS,
    schema: fields({ workOrderId: 'string', scheduledStart: 'string', scheduledEnd: 'string', assignedUserId: 'string' }, ['workOrderId', 'scheduledStart', 'scheduledEnd']),
    input: schemas['service_visits.schedule'],
    run: async (db, companyId, a) => {
      // Creates a scheduled visit only under an open work order of this company.
      const p = new Params(companyId);
      const woRef = p.add(a.workOrderId);
      const startRef = p.add(a.scheduledStart);
      const endRef = p.add(a.scheduledEnd);
      refuseUnverifiedAssignee(a.assignedUserId);
      const assignRef = p.add(a.assignedUserId ?? null);
      const result = await db().query(
        `INSERT INTO visits (company_id, work_order_id, assigned_user_id, status, scheduled_start, scheduled_end)
         SELECT $1::uuid, ${woRef}::uuid, ${assignRef}::uuid, 'scheduled', ${startRef}::timestamptz, ${endRef}::timestamptz
         WHERE EXISTS (SELECT 1 FROM work_orders WHERE company_id = $1 AND id = ${woRef}::uuid AND status IN ('draft', 'scheduled', 'in_progress'))
         RETURNING id, status`,
        p.values,
      );
      const row = result.rows[0];
      return row ? { created: true, id: row.id, status: row.status } : { created: false, reason: 'work_order_not_open' };
    },
  }),

  define({
    id: 'service_visits.reschedule',
    access: 'write',
    risk: 'high',
    timeoutMs: WRITE_TIMEOUT_MS,
    schema: fields({ visitId: 'string', scheduledStart: 'string', scheduledEnd: 'string', assignedUserId: 'string' }, ['visitId', 'scheduledStart', 'scheduledEnd']),
    input: schemas['service_visits.reschedule'],
    run: async (db, companyId, a) => {
      // Only a visit that is still scheduled can move. Started or closed visits are left alone.
      refuseUnverifiedAssignee(a.assignedUserId);
      const result = await db().query(
        `UPDATE visits SET scheduled_start = $3, scheduled_end = $4, assigned_user_id = COALESCE($5, assigned_user_id), updated_at = now()
         WHERE company_id = $1 AND id = $2 AND status = 'scheduled'
         RETURNING id, status, scheduled_start, scheduled_end`,
        [companyId, a.visitId, a.scheduledStart, a.scheduledEnd, a.assignedUserId ?? null],
      );
      const row = result.rows[0];
      return row ? { updated: true, id: row.id, scheduledStart: iso(row.scheduled_start), scheduledEnd: iso(row.scheduled_end) } : { updated: false, reason: 'not_found_or_not_scheduled' };
    },
  }),

  define({
    id: 'site_visits.schedule',
    access: 'write',
    risk: 'medium',
    timeoutMs: WRITE_TIMEOUT_MS,
    schema: fields({ propertyId: 'string' }),
    input: schemas['site_visits.schedule'],
    run: notImplemented(
      'a visit row needs a work order (visits.work_order_id is not null) and the schema has no site-visit kind, so a site visit cannot be stored without inventing a record',
    ),
  }),

  define({
    id: 'sites.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    schema: fields({ clientId: 'string', limit: 'number' }),
    input: schemas['sites.list'],
    run: async (db, companyId, a) => {
      const p = new Params(companyId);
      const where = ['company_id = $1'];
      if (a.clientId) where.push(`client_id = ${p.add(a.clientId)}`);
      // Site notes are left out: they can hold access instructions.
      const text = `SELECT company_id, id, client_id, name, address, city, state, zip FROM properties WHERE ${where.join(' AND ')} ORDER BY address ASC, id`;
      return listRows(db(), companyId, text, p, a.limit, propertyShape);
    },
  }),

  define({
    id: 'staff_tasks.create',
    access: 'write',
    risk: 'low',
    timeoutMs: WRITE_TIMEOUT_MS,
    schema: fields({ title: 'string', description: 'string', priority: 'string', dueAt: 'string', assigneeUserId: 'string', workOrderId: 'string', visitId: 'string' }, ['title']),
    input: schemas['staff_tasks.create'],
    run: async (db, companyId, a) => insertTask(db(), companyId, 'staff', a),
  }),

  define({
    id: 'technician_tasks.create',
    access: 'write',
    risk: 'medium',
    timeoutMs: WRITE_TIMEOUT_MS,
    schema: fields({ title: 'string', description: 'string', priority: 'string', dueAt: 'string', assigneeUserId: 'string', workOrderId: 'string', visitId: 'string' }, ['title']),
    input: schemas['technician_tasks.create'],
    run: async (db, companyId, a) => insertTask(db(), companyId, 'technician', a),
  }),

  define({
    id: 'supplier_bills.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    schema: fields({ status: 'string', purchaseOrderId: 'string', limit: 'number' }),
    input: schemas['supplier_bills.list'],
    run: async (db, companyId, a) => {
      const p = new Params(companyId);
      const where = ['company_id = $1'];
      if (a.status) where.push(`status = ${p.add(a.status)}`);
      if (a.purchaseOrderId) where.push(`purchase_order_id = ${p.add(a.purchaseOrderId)}`);
      const text = `SELECT company_id, id, purchase_order_id, supplier_name, bill_number, amount_cents, due_date, status, received_at FROM supplier_bills WHERE ${where.join(' AND ')} ORDER BY received_at DESC, id`;
      return listRows(db(), companyId, text, p, a.limit, supplierBillShape);
    },
  }),

  define({
    id: 'timesheets.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    schema: fields({ userId: 'string', status: 'string', fromDate: 'string', toDate: 'string', limit: 'number' }),
    input: schemas['timesheets.list'],
    run: async (db, companyId, a) => {
      const p = new Params(companyId);
      const where = ['company_id = $1'];
      if (a.userId) where.push(`user_id = ${p.add(a.userId)}`);
      if (a.status) where.push(`status = ${p.add(a.status)}`);
      if (a.fromDate) where.push(`work_date >= ${p.add(a.fromDate)}::date`);
      if (a.toDate) where.push(`work_date <= ${p.add(a.toDate)}::date`);
      const text = `SELECT company_id, id, user_id, work_date, started_at, ended_at, hours, status FROM timesheets WHERE ${where.join(' AND ')} ORDER BY work_date DESC, id`;
      return listRows(db(), companyId, text, p, a.limit, timesheetShape);
    },
  }),

  define({
    id: 'timesheet_flags.create',
    access: 'write',
    risk: 'low',
    timeoutMs: WRITE_TIMEOUT_MS,
    schema: fields({ timesheetId: 'string', reason: 'string' }, ['timesheetId', 'reason']),
    input: schemas['timesheet_flags.create'],
    run: async (db, companyId, a) => {
      // The composite foreign key on (company_id, timesheet_id) refuses a timesheet from another company.
      const result = await db().query(
        `INSERT INTO timesheet_flags (company_id, timesheet_id, reason, status) VALUES ($1, $2, $3, 'open') RETURNING id, status`,
        [companyId, a.timesheetId, a.reason],
      );
      const row = result.rows[0];
      return { created: true, id: row?.id ?? null, status: row?.status ?? 'open' };
    },
  }),

  define({
    id: 'users.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    schema: fields({ limit: 'number' }),
    input: schemas['users.list'],
    run: async (db, companyId, a) => {
      // Only id, name and active state. Email, password and every other login field stay out of the output.
      const p = new Params(companyId);
      const text = `SELECT company_id, id, name, is_active FROM users WHERE company_id = $1 AND is_active = true AND is_deleted = false ORDER BY name, id`;
      return listRows(db(), companyId, text, p, a.limit, userShape);
    },
  }),

  define({
    id: 'visits.get',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    schema: fields({ id: 'string' }, ['id']),
    input: schemas['visits.get'],
    run: async (db, companyId, a) =>
      getOne(
        db(),
        companyId,
        `SELECT company_id, id, work_order_id, assigned_user_id, status, scheduled_start, scheduled_end, arrived_at, completed_at FROM visits WHERE company_id = $1`,
        a.id,
        visitShape,
      ),
  }),

  define({
    id: 'visits.transition',
    access: 'write',
    risk: 'medium',
    timeoutMs: WRITE_TIMEOUT_MS,
    schema: fields({ id: 'string', to: 'string' }, ['id', 'to']),
    input: schemas['visits.transition'],
    run: async (db, companyId, a) => {
      const from = TRANSITION_FROM[a.to] ?? [];
      const result = await db().query(
        `UPDATE visits SET status = $3,
           arrived_at = CASE WHEN $3 IN ('arrived', 'in_progress') THEN COALESCE(arrived_at, now()) ELSE arrived_at END,
           completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END,
           updated_at = now()
         WHERE company_id = $1 AND id = $2 AND status = ANY($4::text[])
         RETURNING id, status`,
        [companyId, a.id, a.to, from],
      );
      return result.rows.length > 0 ? { updated: true, id: a.id, status: a.to } : { updated: false, reason: 'not_found_or_invalid_transition' };
    },
  }),

  define({
    id: 'visits.update',
    access: 'write',
    risk: 'high',
    timeoutMs: WRITE_TIMEOUT_MS,
    schema: fields({ id: 'string', scheduledStart: 'string', scheduledEnd: 'string', assignedUserId: 'string', techNotes: 'string' }, ['id']),
    input: schemas['visits.update'],
    run: async (db, companyId, a) => {
      // Fields not given keep their stored value (COALESCE). Closed visits are not changed.
      refuseUnverifiedAssignee(a.assignedUserId);
      const result = await db().query(
        `UPDATE visits SET
           scheduled_start = COALESCE($3, scheduled_start),
           scheduled_end = COALESCE($4, scheduled_end),
           assigned_user_id = COALESCE($5, assigned_user_id),
           tech_notes = COALESCE($6, tech_notes),
           updated_at = now()
         WHERE company_id = $1 AND id = $2 AND status IN ${VISIT_OPEN}
         RETURNING id, status, scheduled_start, scheduled_end, assigned_user_id`,
        [companyId, a.id, a.scheduledStart ?? null, a.scheduledEnd ?? null, a.assignedUserId ?? null, a.techNotes ?? null],
      );
      const row = result.rows[0];
      return row ? { updated: true, id: row.id, status: row.status } : { updated: false, reason: 'not_found_or_closed' };
    },
  }),

  define({
    id: 'water_test_results.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    schema: fields({ poolProfileId: 'string', limit: 'number' }),
    input: schemas['water_test_results.list'],
    run: async (db, companyId, a) => {
      const p = new Params(companyId);
      const where = ['company_id = $1'];
      if (a.poolProfileId) where.push(`pool_profile_id = ${p.add(a.poolProfileId)}`);
      const text = `SELECT company_id, id, water_test_id, pool_profile_id, tested_at, free_chlorine, ph, total_alkalinity_ppm, notes FROM water_test_results WHERE ${where.join(' AND ')} ORDER BY tested_at DESC, id`;
      return listRows(db(), companyId, text, p, a.limit, waterResultShape);
    },
  }),

  define({
    id: 'water_tests.schedule',
    access: 'write',
    risk: 'medium',
    timeoutMs: WRITE_TIMEOUT_MS,
    schema: fields({ poolProfileId: 'string', scheduledFor: 'string' }, ['poolProfileId', 'scheduledFor']),
    input: schemas['water_tests.schedule'],
    run: async (db, companyId, a) => {
      // Only for a pool profile of this company: the query selects from pool_profiles under the same company id.
      const result = await db().query(
        `INSERT INTO water_tests (company_id, pool_profile_id, scheduled_for, status)
         SELECT $1::uuid, $2::uuid, $3::timestamptz, 'scheduled'
         WHERE EXISTS (SELECT 1 FROM pool_profiles WHERE company_id = $1 AND id = $2::uuid)
         RETURNING id, status, scheduled_for`,
        [companyId, a.poolProfileId, a.scheduledFor],
      );
      const row = result.rows[0];
      return row ? { created: true, id: row.id, status: row.status } : { created: false, reason: 'pool_profile_not_found' };
    },
  }),

  define({
    id: 'work_notes.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    schema: fields({ workOrderId: 'string', visitId: 'string', limit: 'number' }),
    input: schemas['work_notes.list'],
    run: async (db, companyId, a) => {
      const p = new Params(companyId);
      const where = ['company_id = $1'];
      if (a.workOrderId) where.push(`work_order_id = ${p.add(a.workOrderId)}`);
      if (a.visitId) where.push(`visit_id = ${p.add(a.visitId)}`);
      const text = `SELECT company_id, id, work_order_id, visit_id, body, author_user_id, created_at FROM job_notes WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id`;
      return listRows(db(), companyId, text, p, a.limit, jobNoteShape);
    },
  }),

  define({
    id: 'work_orders.list',
    access: 'read',
    risk: 'low',
    timeoutMs: READ_TIMEOUT_MS,
    schema: fields({ status: 'string', clientId: 'string', propertyId: 'string', limit: 'number' }),
    input: schemas['work_orders.list'],
    run: async (db, companyId, a) => {
      // Scope and safety notes are left out of the list. The title and status are what scheduling needs.
      const p = new Params(companyId);
      const where = ['company_id = $1'];
      if (a.status) where.push(`status = ${p.add(a.status)}`);
      if (a.clientId) where.push(`client_id = ${p.add(a.clientId)}`);
      if (a.propertyId) where.push(`property_id = ${p.add(a.propertyId)}`);
      const text = `SELECT company_id, id, client_id, property_id, title, status, total_cents, completed_at FROM work_orders WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id`;
      return listRows(db(), companyId, text, p, a.limit, workOrderShape);
    },
  }),

  define({
    id: 'work_orders.start_visit',
    access: 'write',
    risk: 'medium',
    timeoutMs: WRITE_TIMEOUT_MS,
    schema: fields({ workOrderId: 'string', visitId: 'string' }, ['workOrderId', 'visitId']),
    input: schemas['work_orders.start_visit'],
    run: async (db, companyId, a) => {
      // One statement, so the visit and the work order move together or not at all.
      const result = await db().query(
        `WITH v AS (
           UPDATE visits SET status = 'in_progress', arrived_at = COALESCE(arrived_at, now()), updated_at = now()
           WHERE company_id = $1 AND id = $2 AND work_order_id = $3 AND status IN ('scheduled', 'arrived')
             AND EXISTS (SELECT 1 FROM work_orders w WHERE w.company_id = $1 AND w.id = $3 AND w.status IN ('draft', 'scheduled', 'in_progress'))
           RETURNING id
         ), wo AS (
           UPDATE work_orders SET status = 'in_progress', updated_at = now()
           WHERE company_id = $1 AND id = $3 AND status IN ('draft', 'scheduled') AND EXISTS (SELECT 1 FROM v)
           RETURNING id
         )
         SELECT EXISTS (SELECT 1 FROM v) AS visit_started, EXISTS (SELECT 1 FROM wo) AS order_started`,
        [companyId, a.visitId, a.workOrderId],
      );
      const row = result.rows[0] ?? {};
      return { started: row.visit_started === true, workOrderStarted: row.order_started === true };
    },
  }),
];

/**
 * Refuses an assignee id. The live schema has no user-to-company link (no migration gives users a company_id), so a
 * user id cannot be checked against the caller's company with a scoped query. Nothing is written.
 */
function refuseUnverifiedAssignee(userId: unknown): void {
  if (userId === undefined || userId === null) return;
  throw new Error('assignee cannot be verified as a member of this company (no user-to-company link in the live schema); nothing was written');
}

/** Inserts a staff or technician task. The composite foreign keys keep work_order_id and visit_id inside the company. */
async function insertTask(
  db: SqlExecutor,
  companyId: CompanyId,
  kind: 'staff' | 'technician',
  a: z.output<typeof taskInput>,
): Promise<{ created: true; id: unknown; status: unknown; priority: unknown }> {
  refuseUnverifiedAssignee(a.assigneeUserId);
  const result = await db.query(
    `INSERT INTO staff_tasks (company_id, kind, title, description, assignee_user_id, work_order_id, visit_id, status, priority, due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'open', $8, $9)
     RETURNING id, status, priority`,
    [
      companyId,
      kind,
      a.title,
      a.description ?? null,
      a.assigneeUserId ?? null,
      a.workOrderId ?? null,
      a.visitId ?? null,
      a.priority ?? 'normal',
      a.dueAt ?? null,
    ],
  );
  const row = result.rows[0] ?? {};
  return { created: true, id: row.id ?? null, status: row.status ?? 'open', priority: row.priority ?? 'normal' };
}

/** Ids in this group, in the order the specs list them. */
export const GROUP04_IDS: readonly string[] = SPECS.map((spec) => spec.id);

/**
 * Registry definitions for group 04. Read definitions have access 'read' and risk 'low'. Write definitions have access
 * 'write' and the risk tier their table change needs. Every definition has its own timeoutMs.
 */
export function createGroup04ToolDefinitions(options: Group04Options = {}): ToolDefinition[] {
  return SPECS.map((spec) => ({
    id: spec.id,
    risk: spec.risk,
    access: spec.access,
    timeoutMs: spec.timeoutMs,
    schema: spec.schema,
    handler: async (params: Record<string, unknown>, context: ToolHandlerContext) => {
      const args = parseInput(spec.input, params);
      const companyId = requireCompanyId(context.companyId);
      // The journal's transaction executor is used when present, so a write commits with its journal row.
      const resolve = (): SqlExecutor => {
        const db = context.db ?? options.db;
        if (db === undefined) throw new Error(`no database executor is bound for ${spec.id}`);
        return db;
      };
      return spec.run(resolve, companyId, args);
    },
  }));
}
