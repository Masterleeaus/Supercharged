/**
 * Typed read handlers for the workforce tools that roles declare. Each handler takes (companyId, input):
 *   - companyId comes only from the caller argument. It is checked with requireCompanyId and never read from input.
 *   - input is parsed with a strict zod schema. Unknown keys (including companyId) are rejected.
 *   - every store call is scoped by companyId, and any row whose companyId differs is dropped again here.
 *   - output is a bounded list (at most MAX_READ_ROWS) with an explicit allow-list of fields. No secrets, no
 *     gateway identifiers, and personal contact fields only where the tool needs them.
 *
 * Only tools with a real company-scoped data source are bound here (see READ_TOOLS.md). The store is an injected
 * port: no existing storage method is scoped by companyId yet, so this module does not query the database.
 * No network, database or environment access happens in this file.
 */
import { z } from 'zod';
import { requireCompanyId } from '../../services/ai-runtime/company.ts';
import type { CompanyId } from '../../services/ai-runtime/types.ts';
import type { ToolDefinition, ToolSchema } from '../runtime/tool-registry.ts';
import type { SqlExecutor } from '../runtime/pg-store.ts';
import { createGroup00ToolDefinitions } from './handlers/group-00.ts';
import { createGroup01ToolDefinitions } from './handlers/group-01.ts';
import { createGroup02ToolDefinitions } from './handlers/group-02.ts';

export const MAX_READ_ROWS = 50;

export class ReadToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadToolInputError';
  }
}

// ---- Store port -----------------------------------------------------------------------------------------------

/** Appointment rows (table `appointments`, scoped by company_id). */
export interface BookingRow {
  companyId: CompanyId;
  id: string;
  contactName: string;
  appointmentDate: string;
  appointmentTime: string;
  duration: number;
  serviceName: string | null;
  status: string;
}

/** Invoice rows (table `invoices`, scoped by company_id). */
export interface InvoiceRow {
  companyId: CompanyId;
  id: string;
  invoiceNumber: string;
  customerName: string;
  total: string;
  currency: string;
  status: string;
  issuedAt: string;
  dueAt: string | null;
  paidAt: string | null;
}

/** Payment rows (table `payment_transactions`, scoped by company_id). */
export interface PaymentRow {
  companyId: CompanyId;
  id: string;
  type: string;
  amount: string;
  currency: string;
  status: string;
  description: string;
  createdAt: string;
  completedAt: string | null;
}

/**
 * Each query asks for `limit` rows at most. The handler passes MAX_READ_ROWS + 1 so it can tell when a list was cut.
 * Every method takes companyId as its first argument and must scope the read to it.
 */
export interface BookingQuery {
  status?: string;
  fromDate?: string;
  toDate?: string;
  limit: number;
}
export interface InvoiceQuery {
  status?: 'draft' | 'sent' | 'paid' | 'void';
  limit: number;
}
export interface PaymentQuery {
  status?: 'pending' | 'completed' | 'failed' | 'refunded' | 'partially_refunded';
  limit: number;
}

export interface ReadStore {
  listBookings(companyId: CompanyId, query: BookingQuery): Promise<BookingRow[]>;
  getBooking(companyId: CompanyId, id: string): Promise<BookingRow | null>;
  listInvoices(companyId: CompanyId, query: InvoiceQuery): Promise<InvoiceRow[]>;
  getInvoice(companyId: CompanyId, id: string): Promise<InvoiceRow | null>;
  listPayments(companyId: CompanyId, query: PaymentQuery): Promise<PaymentRow[]>;
}

// ---- Input schemas (strict: unknown keys, companyId included, are rejected) ------------------------------------

const limitField = z.number().int().min(1).max(MAX_READ_ROWS).optional();
const idField = z.string().trim().min(1).max(128);
const dateField = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD').optional();

const bookingListInput = z
  .object({
    status: z.string().trim().min(1).max(50).optional(),
    fromDate: dateField,
    toDate: dateField,
    limit: limitField,
  })
  .strict();
const bookingGetInput = z.object({ id: idField }).strict();
const invoiceListInput = z
  .object({ status: z.enum(['draft', 'sent', 'paid', 'void']).optional(), limit: limitField })
  .strict();
const invoiceGetInput = z.object({ id: idField }).strict();
const paymentListInput = z
  .object({
    status: z.enum(['pending', 'completed', 'failed', 'refunded', 'partially_refunded']).optional(),
    limit: limitField,
  })
  .strict();

// Field-type schemas for the registry (ToolSchema). They mirror the zod schemas above; zod is the stricter check.
const bookingListSchema: ToolSchema = {
  status: { type: 'string' },
  fromDate: { type: 'string' },
  toDate: { type: 'string' },
  limit: { type: 'number' },
};
const idSchema: ToolSchema = { id: { type: 'string', required: true } };
const invoiceListSchema: ToolSchema = { status: { type: 'string' }, limit: { type: 'number' } };
const paymentListSchema: ToolSchema = { status: { type: 'string' }, limit: { type: 'number' } };

// ---- Output shaping ---------------------------------------------------------------------------------------------

export interface BoundedList<T> {
  rows: T[];
  count: number;
  truncated: boolean;
  maxRows: number;
}

/** Keeps the rows that belong to companyId, cuts to MAX_READ_ROWS, and reports whether anything was cut. */
function boundRows<R extends { companyId: CompanyId }, T>(
  companyId: CompanyId,
  rows: R[],
  shape: (row: R) => T,
  cap: number,
): BoundedList<T> {
  const own = rows.filter((row) => row.companyId === companyId);
  const kept = own.slice(0, cap).map(shape);
  return { rows: kept, count: kept.length, truncated: own.length > cap, maxRows: MAX_READ_ROWS };
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Field names only. Values are never echoed back.
    const fields = result.error.issues.flatMap((issue) => {
      if (issue.code === 'unrecognized_keys') return issue.keys;
      return [issue.path.join('.') || '(input)'];
    });
    throw new ReadToolInputError(`invalid input: ${[...new Set(fields)].join(', ')}`);
  }
  return result.data;
}

/** The page size a call asked for, capped at MAX_READ_ROWS. */
function pageSize(requested: number | undefined): number {
  return requested ?? MAX_READ_ROWS;
}

function bookingShape(row: BookingRow) {
  // No contact phone or email: the booking list needs the name and the slot, not the contact details.
  return {
    id: row.id,
    contactName: row.contactName,
    appointmentDate: row.appointmentDate,
    appointmentTime: row.appointmentTime,
    duration: row.duration,
    serviceName: row.serviceName,
    status: row.status,
  };
}

function invoiceShape(row: InvoiceRow) {
  // No customer email or address, and no line items. The invoice queries need the number, amounts and dates.
  return {
    id: row.id,
    invoiceNumber: row.invoiceNumber,
    customerName: row.customerName,
    total: row.total,
    currency: row.currency,
    status: row.status,
    issuedAt: row.issuedAt,
    dueAt: row.dueAt,
    paidAt: row.paidAt,
  };
}

function paymentShape(row: PaymentRow) {
  // No gateway transaction ids, subscription ids or metadata.
  return {
    id: row.id,
    type: row.type,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    description: row.description,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

// ---- Handlers ----------------------------------------------------------------------------------------------------

export type ReadHandler = (companyId: CompanyId, input: unknown) => Promise<unknown>;

export interface ReadToolSpec {
  id: string;
  schema: ToolSchema;
  run: ReadHandler;
}

export function createReadToolSpecs(store: ReadStore): ReadToolSpec[] {
  if (!store || typeof store !== 'object') throw new Error('read tools need a store');

  const bookingsList: ReadToolSpec = {
    id: 'booking_requests.list',
    schema: bookingListSchema,
    run: async (rawCompanyId, input) => {
      const companyId = requireCompanyId(rawCompanyId);
      const args = parseInput(bookingListInput, input);
      const rows = await store.listBookings(companyId, {
        status: args.status,
        fromDate: args.fromDate,
        toDate: args.toDate,
        limit: pageSize(args.limit) + 1,
      });
      return boundRows(companyId, rows, bookingShape, pageSize(args.limit));
    },
  };

  const bookingsGet: ReadToolSpec = {
    id: 'booking_requests.get',
    schema: idSchema,
    run: async (rawCompanyId, input) => {
      const companyId = requireCompanyId(rawCompanyId);
      const args = parseInput(bookingGetInput, input);
      const row = await store.getBooking(companyId, args.id);
      if (!row || row.companyId !== companyId) return { found: false, row: null };
      return { found: true, row: bookingShape(row) };
    },
  };

  const invoicesList: ReadToolSpec = {
    id: 'invoices.list',
    schema: invoiceListSchema,
    run: async (rawCompanyId, input) => {
      const companyId = requireCompanyId(rawCompanyId);
      const args = parseInput(invoiceListInput, input);
      const rows = await store.listInvoices(companyId, { status: args.status, limit: pageSize(args.limit) + 1 });
      return boundRows(companyId, rows, invoiceShape, pageSize(args.limit));
    },
  };

  const invoicesGet: ReadToolSpec = {
    id: 'invoices.get',
    schema: idSchema,
    run: async (rawCompanyId, input) => {
      const companyId = requireCompanyId(rawCompanyId);
      const args = parseInput(invoiceGetInput, input);
      const row = await store.getInvoice(companyId, args.id);
      if (!row || row.companyId !== companyId) return { found: false, row: null };
      return { found: true, row: invoiceShape(row) };
    },
  };

  const paymentsList: ReadToolSpec = {
    id: 'payments.list',
    schema: paymentListSchema,
    run: async (rawCompanyId, input) => {
      const companyId = requireCompanyId(rawCompanyId);
      const args = parseInput(paymentListInput, input);
      const rows = await store.listPayments(companyId, { status: args.status, limit: pageSize(args.limit) + 1 });
      return boundRows(companyId, rows, paymentShape, pageSize(args.limit));
    },
  };

  return [bookingsList, bookingsGet, invoicesList, invoicesGet, paymentsList];
}

/**
 * Registry definitions for every bound read tool, plus the handler group 00 (reads and writes on the workforce
 * tables), group 01 (handlers/group-01.ts) and group 02 (write and draft tools included). Each read spec runs with
 * access 'read' and risk 'low'. group00Db is the read executor for group 00, and the same executor is passed to
 * groups 01 and 02. Groups 01 and 02 declare their own access and risk per tool.
 */
export function createReadToolDefinitions(store: ReadStore, group00Db?: SqlExecutor): ToolDefinition[] {
  return [
    ...createReadToolSpecs(store).map((spec) => ({
      id: spec.id,
      risk: 'low' as const,
      access: 'read' as const,
      schema: spec.schema,
      handler: (params: Record<string, unknown>, context: { companyId: CompanyId }) => spec.run(context.companyId, params),
    })),
    ...createGroup00ToolDefinitions(group00Db),
    ...createGroup01ToolDefinitions({ db: group00Db }),
    ...createGroup02ToolDefinitions({ db: group00Db }),
  ];
}

/** Minimal shape of the registry that registerReadTools needs. */
export interface ReadToolRegistry {
  register(definition: ToolDefinition): void;
}

/** Registers every bound read tool and group 00. The store and group00Db are passed in by the composition root. */
export function registerReadTools(registry: ReadToolRegistry, store: ReadStore, group00Db?: SqlExecutor): void {
  for (const definition of createReadToolDefinitions(store, group00Db)) registry.register(definition);
}
