/**
 * Group 00 tool handlers: 18 workforce tool ids, bound to the workforce tables (migrations/0014_workforce_tool_tables.sql)
 *
 * Rules every handler follows:
 *   - companyId comes only from the authenticated context (ToolHandlerContext.companyId), checked by requireCompanyId.
 *     Input is parsed by a strict zod schema, so a companyId key in the input is refused.
 *   - reads run through the injected SqlExecutor with company_id = $1 in every query. Rows whose company_id differs
 *     from the caller are dropped again in JS. Output is a bounded list with an explicit field allow-list.
 *   - writes run through context.db, the executor of the action journal transaction, so they commit or roll back with
 *     the journal row. A write with no executor is refused.
 *   - no handler sends a message, moves money or contacts a customer. Those ids return not_implemented. The two that
 *     reach customers are registered with category 'customer_send', so the registry sends any call to owner approval.
 *
 * SQL text is fixed in this file. Caller values only ever go in as $n parameters.
 */
import { z } from 'zod';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { CompanyId } from '../../../services/ai-runtime/types.ts';
import type { SqlExecutor } from '../../runtime/pg-store.ts';
import type { RiskTier, ToolCategory, ToolDefinition, ToolHandlerContext, ToolSchema } from '../../runtime/tool-registry.ts';

export const GROUP00_MAX_ROWS = 50;
/** Client rows scanned by client_duplicates.list. Beyond this the result says it was truncated. */
const DUPLICATE_SCAN_LIMIT = 500;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 20_000;

// ---- Input schemas (strict: unknown keys, companyId included, are refused) --------------------------------------------

const uuid = z.string().uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const limitField = z.number().int().min(1).max(GROUP00_MAX_ROWS).optional();

function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').refine(isRealDate, 'not a real date');
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:MM');
const duration = z.number().int().min(5).max(1440);

const schemas = {
  'after_hours.page_on_call': z.object({ reason: text(500), severity: z.enum(['high', 'critical']).optional() }).strict(),
  'agreements.list': z
    .object({ clientId: uuid.optional(), status: z.enum(['active', 'lapsed', 'cancelled']).optional(), limit: limitField })
    .strict(),
  'agreements.renewal_draft': z.object({ agreementId: uuid }).strict(),
  'availability.read': z.object({ date: isoDate }).strict(),
  'booking_requests.create': z
    .object({
      contactName: text(255),
      appointmentDate: isoDate,
      appointmentTime: clockTime,
      duration,
      serviceName: text(255).optional(),
    })
    .strict(),
  'booking_requests.update': z
    .object({
      id: text(128),
      appointmentDate: isoDate.optional(),
      appointmentTime: clockTime.optional(),
      duration: duration.optional(),
      status: text(50).optional(),
      statusReason: text(500).optional(),
      notes: text(5000).optional(),
    })
    .strict()
    .refine((value) => Object.keys(value).some((key) => key !== 'id'), { message: 'no field to update' }),
  'campaign_messages.create': z.object({ subject: text(200), body: text(5000), audience: text(100).optional() }).strict(),
  'client_duplicates.list': z.object({ limit: limitField }).strict(),
  'client_merge_suggestions.create': z
    .object({ clientId: uuid, duplicateClientId: uuid, reason: text(1000).optional() })
    .strict()
    .refine((value) => value.clientId !== value.duplicateClientId, { message: 'clientId and duplicateClientId must differ' }),
  'clients.create': z
    .object({
      name: text(200),
      email: z.string().trim().email().max(255).optional(),
      phone: text(50).optional(),
      notes: text(5000).optional(),
    })
    .strict(),
  'clients.get': z.object({ id: uuid }).strict(),
  'clients.list': z.object({ q: text(100).optional(), limit: limitField }).strict(),
  'collection_notes.create': z.object({ clientId: uuid.optional(), invoiceRef: text(128), body: text(5000) }).strict(),
  'complaints.create': z
    .object({
      summary: text(2000),
      clientId: uuid.optional(),
      propertyId: uuid.optional(),
      workOrderId: uuid.optional(),
      category: text(100).optional(),
    })
    .strict(),
  'compliance_certificates.list': z
    .object({
      propertyId: uuid.optional(),
      status: z.enum(['valid', 'expiring', 'expired']).optional(),
      limit: limitField,
    })
    .strict(),
  'compliance_documents.list': z.object({ propertyId: uuid.optional(), limit: limitField }).strict(),
  'compliance_reminders.send': z.object({ certificateId: uuid, channel: z.enum(['email', 'sms']).optional() }).strict(),
  'crew_rosters.list': z
    .object({
      rosterDate: isoDate.optional(),
      status: z.enum(['draft', 'published']).optional(),
      limit: limitField,
    })
    .strict(),
} as const;

export type Group00Id = keyof typeof schemas;

/** Zod schemas by tool id. They are the stricter check. The registry uses the field-type schemas below. */
export const GROUP00_INPUT_SCHEMAS: Readonly<Record<Group00Id, z.ZodType>> = schemas;

// Field-type schemas for the registry (ToolSchema). They mirror the zod schemas above; zod is the stricter check.
const toolSchemas: Readonly<Record<Group00Id, ToolSchema>> = {
  'after_hours.page_on_call': { reason: { type: 'string', required: true }, severity: { type: 'string' } },
  'agreements.list': { clientId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' } },
  'agreements.renewal_draft': { agreementId: { type: 'string', required: true } },
  'availability.read': { date: { type: 'string', required: true } },
  'booking_requests.create': {
    contactName: { type: 'string', required: true },
    appointmentDate: { type: 'string', required: true },
    appointmentTime: { type: 'string', required: true },
    duration: { type: 'number', required: true },
    serviceName: { type: 'string' },
  },
  'booking_requests.update': {
    id: { type: 'string', required: true },
    appointmentDate: { type: 'string' },
    appointmentTime: { type: 'string' },
    duration: { type: 'number' },
    status: { type: 'string' },
    statusReason: { type: 'string' },
    notes: { type: 'string' },
  },
  'campaign_messages.create': {
    subject: { type: 'string', required: true },
    body: { type: 'string', required: true },
    audience: { type: 'string' },
  },
  'client_duplicates.list': { limit: { type: 'number' } },
  'client_merge_suggestions.create': {
    clientId: { type: 'string', required: true },
    duplicateClientId: { type: 'string', required: true },
    reason: { type: 'string' },
  },
  'clients.create': {
    name: { type: 'string', required: true },
    email: { type: 'string' },
    phone: { type: 'string' },
    notes: { type: 'string' },
  },
  'clients.get': { id: { type: 'string', required: true } },
  'clients.list': { q: { type: 'string' }, limit: { type: 'number' } },
  'collection_notes.create': {
    clientId: { type: 'string' },
    invoiceRef: { type: 'string', required: true },
    body: { type: 'string', required: true },
  },
  'complaints.create': {
    summary: { type: 'string', required: true },
    clientId: { type: 'string' },
    propertyId: { type: 'string' },
    workOrderId: { type: 'string' },
    category: { type: 'string' },
  },
  'compliance_certificates.list': { propertyId: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' } },
  'compliance_documents.list': { propertyId: { type: 'string' }, limit: { type: 'number' } },
  'compliance_reminders.send': { certificateId: { type: 'string', required: true }, channel: { type: 'string' } },
  'crew_rosters.list': { rosterDate: { type: 'string' }, status: { type: 'string' }, limit: { type: 'number' } },
};

// ---- Helpers ----------------------------------------------------------------------------------------------------------

export class Group00InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Group00InputError';
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Field names only. Values are never echoed back.
    const fields = result.error.issues.flatMap((issue) => {
      if (issue.code === 'unrecognized_keys') return issue.keys;
      return [issue.path.join('.') || '(input)'];
    });
    throw new Group00InputError(`invalid input: ${[...new Set(fields)].join(', ')}`);
  }
  return result.data;
}

type Row = Record<string, unknown> & { companyId: unknown };

function readDb(db: SqlExecutor | undefined): SqlExecutor {
  if (!db) throw new Error('group-00 read tools need a database executor');
  return db;
}

function writeDb(context: ToolHandlerContext): SqlExecutor {
  if (!context.db) throw new Error('group-00 write tools run only inside the action journal transaction');
  return context.db;
}

async function rowsOf(db: SqlExecutor, sql: string, values: readonly unknown[]): Promise<Row[]> {
  const result = await db.query(sql, values);
  return result.rows as Row[];
}

function companyOf(context: ToolHandlerContext): CompanyId {
  return requireCompanyId(context.companyId);
}

function pageSize(requested: number | undefined): number {
  return requested ?? GROUP00_MAX_ROWS;
}

/** Keeps the rows that belong to companyId, cuts to cap, and reports whether anything was cut. */
function bounded<T>(companyId: CompanyId, rows: Row[], shape: (row: Row) => T, cap: number) {
  const own = rows.filter((row) => row.companyId === companyId);
  const kept = own.slice(0, cap).map(shape);
  return { rows: kept, count: kept.length, truncated: own.length > cap, maxRows: GROUP00_MAX_ROWS };
}

/** Escapes LIKE wildcards so a search term matches literally. Postgres uses backslash as the default escape. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function notImplemented(id: Group00Id, reason: string) {
  return async (input: unknown) => {
    parse(schemas[id], input);
    return { status: 'not_implemented', reason };
  };
}

// ---- Shapes (explicit allow-lists) ------------------------------------------------------------------------------------

const agreementShape = (row: Row) => ({
  id: row.id,
  clientId: row.clientId,
  propertyId: row.propertyId,
  name: row.name,
  status: row.status,
  startsOn: row.startsOn,
  endsOn: row.endsOn,
  priceCents: row.priceCents,
});

const clientShape = (row: Row) => ({ id: row.id, name: row.name, email: row.email, phone: row.phone });

const clientDetailShape = (row: Row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  notes: row.notes,
});

const certificateShape = (row: Row) => ({
  id: row.id,
  propertyId: row.propertyId,
  certificateType: row.certificateType,
  reference: row.reference,
  issuedOn: row.issuedOn,
  expiresOn: row.expiresOn,
  status: row.status,
});

// No storageRef: it is a storage location, not something a list needs.
const documentShape = (row: Row) => ({
  id: row.id,
  propertyId: row.propertyId,
  title: row.title,
  documentType: row.documentType,
  expiresOn: row.expiresOn,
});

const rosterShape = (row: Row) => ({
  id: row.id,
  rosterDate: row.rosterDate,
  teamName: row.teamName,
  members: row.members,
  status: row.status,
});

// ---- Read handlers -----------------------------------------------------------------------------------------------------

type Run = (input: unknown, context: ToolHandlerContext, db: SqlExecutor | undefined) => Promise<unknown>;

const agreementsList: Run = async (input, context, db) => {
  const companyId = companyOf(context);
  const args = parse(schemas['agreements.list'], input);
  const cap = pageSize(args.limit);
  const rows = await rowsOf(
    readDb(db),
    `SELECT id, company_id AS "companyId", client_id AS "clientId", property_id AS "propertyId", name, status,
            to_char(starts_on, 'YYYY-MM-DD') AS "startsOn", to_char(ends_on, 'YYYY-MM-DD') AS "endsOn",
            price_cents AS "priceCents"
       FROM service_agreements
      WHERE company_id = $1
        AND ($2::uuid IS NULL OR client_id = $2::uuid)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY created_at DESC, id
      LIMIT $4`,
    [companyId, args.clientId ?? null, args.status ?? null, cap + 1],
  );
  return bounded(companyId, rows, agreementShape, cap);
};

const availabilityRead: Run = async (input, context, db) => {
  const companyId = companyOf(context);
  const args = parse(schemas['availability.read'], input);
  // JS getUTCDay: 0 = Sunday to 6 = Saturday, as business_hours.day_of_week stores it.
  const dayOfWeek = new Date(`${args.date}T00:00:00Z`).getUTCDay();
  const rows = await rowsOf(
    readDb(db),
    `SELECT id, company_id AS "companyId", to_char(opens_at, 'HH24:MI') AS "opensAt",
            to_char(closes_at, 'HH24:MI') AS "closesAt", capacity
       FROM business_hours
      WHERE company_id = $1 AND day_of_week = $2
      ORDER BY opens_at, id
      LIMIT $3`,
    [companyId, dayOfWeek, GROUP00_MAX_ROWS + 1],
  );
  const windows = bounded(
    companyId,
    rows,
    (row) => ({ opensAt: row.opensAt, closesAt: row.closesAt, capacity: row.capacity }),
    GROUP00_MAX_ROWS,
  );
  // Configured hours only. Booked time is not subtracted, so these are not free slots yet.
  return { date: args.date, dayOfWeek, windows, note: 'configured working windows; booked time is not subtracted' };
};

const clientDuplicatesList: Run = async (input, context, db) => {
  const companyId = companyOf(context);
  const args = parse(schemas['client_duplicates.list'], input);
  const cap = pageSize(args.limit);
  const rows = await rowsOf(
    readDb(db),
    `SELECT id, company_id AS "companyId", name, email, phone
       FROM clients
      WHERE company_id = $1
      ORDER BY created_at, id
      LIMIT $2`,
    [companyId, DUPLICATE_SCAN_LIMIT + 1],
  );
  const own = rows.filter((row) => row.companyId === companyId);
  const scanned = own.slice(0, DUPLICATE_SCAN_LIMIT);

  // Groups clients that share an email, or a phone number of at least 6 digits. Contact values are not returned.
  const groups = new Map<string, Row[]>();
  const add = (key: string, row: Row) => {
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  };
  for (const row of scanned) {
    const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
    if (email) add(`email:${email}`, row);
    const digits = typeof row.phone === 'string' ? row.phone.replace(/\D/g, '') : '';
    if (digits.length >= 6) add(`phone:${digits}`, row);
  }
  const matches = [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([key, members]) => ({
      matchOn: key.split(':')[0],
      clients: members.map((row) => ({ id: row.id, name: row.name })),
    }));
  const kept = matches.slice(0, cap);
  return {
    rows: kept,
    count: kept.length,
    truncated: matches.length > cap || own.length > DUPLICATE_SCAN_LIMIT,
    maxRows: GROUP00_MAX_ROWS,
    scanned: scanned.length,
    scanLimit: DUPLICATE_SCAN_LIMIT,
  };
};

const clientsGet: Run = async (input, context, db) => {
  const companyId = companyOf(context);
  const args = parse(schemas['clients.get'], input);
  const rows = await rowsOf(
    readDb(db),
    `SELECT id, company_id AS "companyId", name, email, phone, notes
       FROM clients
      WHERE company_id = $1 AND id = $2
      LIMIT 1`,
    [companyId, args.id],
  );
  const row = rows.find((candidate) => candidate.companyId === companyId);
  if (!row) return { found: false, row: null };
  return { found: true, row: clientDetailShape(row) };
};

const clientsList: Run = async (input, context, db) => {
  const companyId = companyOf(context);
  const args = parse(schemas['clients.list'], input);
  const cap = pageSize(args.limit);
  const rows = await rowsOf(
    readDb(db),
    `SELECT id, company_id AS "companyId", name, email, phone
       FROM clients
      WHERE company_id = $1
        AND ($2::text IS NULL OR name ILIKE $2 OR email ILIKE $2 OR phone ILIKE $2)
      ORDER BY name, id
      LIMIT $3`,
    [companyId, args.q ? likePattern(args.q) : null, cap + 1],
  );
  return bounded(companyId, rows, clientShape, cap);
};

const complianceCertificatesList: Run = async (input, context, db) => {
  const companyId = companyOf(context);
  const args = parse(schemas['compliance_certificates.list'], input);
  const cap = pageSize(args.limit);
  const rows = await rowsOf(
    readDb(db),
    `SELECT id, company_id AS "companyId", property_id AS "propertyId", certificate_type AS "certificateType",
            reference, to_char(issued_on, 'YYYY-MM-DD') AS "issuedOn", to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn",
            status
       FROM compliance_certificates
      WHERE company_id = $1
        AND ($2::uuid IS NULL OR property_id = $2::uuid)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY expires_on NULLS LAST, id
      LIMIT $4`,
    [companyId, args.propertyId ?? null, args.status ?? null, cap + 1],
  );
  return bounded(companyId, rows, certificateShape, cap);
};

const complianceDocumentsList: Run = async (input, context, db) => {
  const companyId = companyOf(context);
  const args = parse(schemas['compliance_documents.list'], input);
  const cap = pageSize(args.limit);
  const rows = await rowsOf(
    readDb(db),
    `SELECT id, company_id AS "companyId", property_id AS "propertyId", title, document_type AS "documentType",
            to_char(expires_on, 'YYYY-MM-DD') AS "expiresOn"
       FROM compliance_documents
      WHERE company_id = $1
        AND ($2::uuid IS NULL OR property_id = $2::uuid)
      ORDER BY title, id
      LIMIT $3`,
    [companyId, args.propertyId ?? null, cap + 1],
  );
  return bounded(companyId, rows, documentShape, cap);
};

const crewRostersList: Run = async (input, context, db) => {
  const companyId = companyOf(context);
  const args = parse(schemas['crew_rosters.list'], input);
  const cap = pageSize(args.limit);
  const rows = await rowsOf(
    readDb(db),
    `SELECT id, company_id AS "companyId", to_char(roster_date, 'YYYY-MM-DD') AS "rosterDate",
            team_name AS "teamName", members, status
       FROM crew_rosters
      WHERE company_id = $1
        AND ($2::date IS NULL OR roster_date = $2::date)
        AND ($3::text IS NULL OR status = $3)
      ORDER BY roster_date, team_name, id
      LIMIT $4`,
    [companyId, args.rosterDate ?? null, args.status ?? null, cap + 1],
  );
  return bounded(companyId, rows, rosterShape, cap);
};

// ---- Write handlers (plain record changes, through the journal executor) -----------------------------------------------

const clientsCreate: Run = async (input, context) => {
  const companyId = companyOf(context);
  const args = parse(schemas['clients.create'], input);
  const rows = await rowsOf(
    writeDb(context),
    `INSERT INTO clients (company_id, name, email, phone, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [companyId, args.name, args.email ?? null, args.phone ?? null, args.notes ?? null],
  );
  return { created: rows.length === 1, id: rows[0]?.id ?? null };
};

const clientMergeSuggestionsCreate: Run = async (input, context) => {
  const companyId = companyOf(context);
  const args = parse(schemas['client_merge_suggestions.create'], input);
  // The composite foreign keys reject a client id that belongs to another company.
  const rows = await rowsOf(
    writeDb(context),
    `INSERT INTO client_merge_suggestions (company_id, client_id, duplicate_client_id, reason, status)
     VALUES ($1, $2, $3, $4, 'open')
     RETURNING id, status`,
    [companyId, args.clientId, args.duplicateClientId, args.reason ?? null],
  );
  return { created: rows.length === 1, id: rows[0]?.id ?? null, status: rows[0]?.status ?? null };
};

const collectionNotesCreate: Run = async (input, context) => {
  const companyId = companyOf(context);
  const args = parse(schemas['collection_notes.create'], input);
  // author_user_id stays null: the tool context carries no acting user to record.
  const rows = await rowsOf(
    writeDb(context),
    `INSERT INTO collection_notes (company_id, client_id, invoice_ref, body, author_user_id)
     VALUES ($1, $2, $3, $4, NULL)
     RETURNING id`,
    [companyId, args.clientId ?? null, args.invoiceRef, args.body],
  );
  return { created: rows.length === 1, id: rows[0]?.id ?? null };
};

const complaintsCreate: Run = async (input, context) => {
  const companyId = companyOf(context);
  const args = parse(schemas['complaints.create'], input);
  const rows = await rowsOf(
    writeDb(context),
    `INSERT INTO complaints (company_id, client_id, property_id, work_order_id, summary, category, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'open')
     RETURNING id, status`,
    [companyId, args.clientId ?? null, args.propertyId ?? null, args.workOrderId ?? null, args.summary, args.category ?? null],
  );
  return { created: rows.length === 1, id: rows[0]?.id ?? null, status: rows[0]?.status ?? null };
};

// ---- Registry specs ----------------------------------------------------------------------------------------------------

interface Spec {
  id: Group00Id;
  access: 'read' | 'write';
  risk: RiskTier;
  category?: ToolCategory;
  run: Run;
}

const GROUP00_SPECS: readonly Spec[] = [
  {
    id: 'after_hours.page_on_call',
    access: 'write',
    risk: 'high',
    run: notImplemented(
      'after_hours.page_on_call',
      'No on-call roster or paging channel exists in the workforce tables. Paging a person is an outbound notification, so it stays unimplemented. Nothing was sent.',
    ),
  },
  { id: 'agreements.list', access: 'read', risk: 'low', run: agreementsList },
  {
    id: 'agreements.renewal_draft',
    access: 'write',
    risk: 'medium',
    run: notImplemented(
      'agreements.renewal_draft',
      'Renewal drafts need a draft store, and no table holds them. The id does not end in draft or draft_, so the registry draft path does not apply. Nothing was written.',
    ),
  },
  { id: 'availability.read', access: 'read', risk: 'low', run: availabilityRead },
  {
    id: 'booking_requests.create',
    access: 'write',
    risk: 'medium',
    run: notImplemented(
      'booking_requests.create',
      'The appointments table needs an owning user_id (NOT NULL), and the tool context carries no acting user. No booking_requests table exists. Nothing was written.',
    ),
  },
  {
    id: 'booking_requests.update',
    access: 'write',
    risk: 'medium',
    run: notImplemented(
      'booking_requests.update',
      'The live appointments table has no company_id column (only the archived DRAFT migration adds it), so the update cannot be scoped to the caller company. Nothing was written.',
    ),
  },
  {
    id: 'campaign_messages.create',
    access: 'write',
    risk: 'high',
    category: 'customer_send',
    run: notImplemented(
      'campaign_messages.create',
      'No campaign_messages table exists, and a campaign sends messages to customers. The customer_send category routes any call to owner approval. Nothing was sent.',
    ),
  },
  { id: 'client_duplicates.list', access: 'read', risk: 'low', run: clientDuplicatesList },
  { id: 'client_merge_suggestions.create', access: 'write', risk: 'medium', run: clientMergeSuggestionsCreate },
  { id: 'clients.create', access: 'write', risk: 'medium', run: clientsCreate },
  { id: 'clients.get', access: 'read', risk: 'low', run: clientsGet },
  { id: 'clients.list', access: 'read', risk: 'low', run: clientsList },
  { id: 'collection_notes.create', access: 'write', risk: 'medium', run: collectionNotesCreate },
  { id: 'complaints.create', access: 'write', risk: 'medium', run: complaintsCreate },
  { id: 'compliance_certificates.list', access: 'read', risk: 'low', run: complianceCertificatesList },
  { id: 'compliance_documents.list', access: 'read', risk: 'low', run: complianceDocumentsList },
  {
    id: 'compliance_reminders.send',
    access: 'write',
    risk: 'high',
    category: 'customer_send',
    run: notImplemented(
      'compliance_reminders.send',
      'Reminders go to customers, and no reminder table or send channel exists. The customer_send category routes any call to owner approval. Nothing was sent.',
    ),
  },
  { id: 'crew_rosters.list', access: 'read', risk: 'low', run: crewRostersList },
];

/** Every tool id this group defines. */
export const GROUP00_TOOL_IDS: readonly Group00Id[] = GROUP00_SPECS.map((spec) => spec.id);

/** Ids that return not_implemented. They are defined, but nothing they promise is done. */
export const GROUP00_NOT_IMPLEMENTED_IDS: ReadonlySet<Group00Id> = new Set<Group00Id>([
  'after_hours.page_on_call',
  'agreements.renewal_draft',
  'booking_requests.create',
  'booking_requests.update',
  'campaign_messages.create',
  'compliance_reminders.send',
]);

/**
 * Registry definitions for group 00. db is the read executor (a pg Pool or Client). Writes use context.db instead.
 * Reads get timeoutMs 10000, writes 20000.
 */
export function createGroup00ToolDefinitions(db?: SqlExecutor): ToolDefinition[] {
  return GROUP00_SPECS.map((spec) => ({
    id: spec.id,
    risk: spec.risk,
    access: spec.access,
    ...(spec.category !== undefined ? { category: spec.category } : {}),
    schema: toolSchemas[spec.id],
    timeoutMs: spec.access === 'read' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS,
    handler: (params, context) => spec.run(params, context, db),
  }));
}
