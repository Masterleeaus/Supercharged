/**
 * Group 04 workforce tool definitions: visits, work orders, sites, service schedules, staff and technician tasks,
 * timesheets, supplier bills, water tests, users and work notes.
 *
 * None of these tools has a company-scoped source table in shared/schema.ts (see tools/READ_TOOLS.md). Mapping them
 * to a table that means something else (appointments, users, workforce_tasks) would change what the tool does, so
 * every handler here returns a clear `not_implemented` result with the reason. Nothing is read or written.
 *
 * What still holds for every handler:
 *   - companyId comes only from the registry context and is required (requireCompanyId).
 *   - input is parsed with a strict zod schema. Unknown keys, including companyId, are refused.
 *   - no external send, payment, refund or provider call is made. None of these tools is one of those.
 *
 * Replace a handler when its table exists: scope every query by companyId and drop rows whose companyId differs.
 */
import { z } from 'zod';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { ToolDefinition, ToolSchema } from '../../runtime/tool-registry.ts';

const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 20_000;

const idField = z.string().trim().min(1).max(128);
const limitField = z.number().int().min(1).max(50).optional();
const isoField = z.string().trim().min(1).max(40);
const textField = (max: number) => z.string().trim().min(1).max(max);

/** Strict input for list tools: an optional page size and an optional status filter. */
const listInput = z.object({ status: textField(50).optional(), limit: limitField }).strict();
const idInput = z.object({ id: idField }).strict();

export type Group04Status = 'not_implemented';

export interface Group04Result {
  status: Group04Status;
  tool: string;
  reason: string;
}

interface Group04Tool {
  id: string;
  risk: 'low' | 'medium' | 'high';
  access: 'read' | 'write';
  timeoutMs: number;
  input: z.ZodType<Record<string, unknown>>;
  fields: ToolSchema;
  reason: string;
}

const NO_VISITS =
  'No visits or work orders table in shared/schema.ts. appointments holds bookings, not field visits, so it is not reused.';
const NO_SITES = 'No customer sites table in shared/schema.ts.';
const NO_SERVICE_VISITS =
  'No service visits table in shared/schema.ts. appointments holds bookings, not service visits, so it is not reused.';
const NO_TIMESHEETS = 'No timesheets table in shared/schema.ts.';
const NO_TASKS =
  'No staff or technician task table in shared/schema.ts. workforce_tasks tracks agent runs, not staff work.';

const GROUP_04_TOOLS: readonly Group04Tool[] = [
  // ---- reads ----
  { id: 'service_schedules.list', risk: 'low', access: 'read', timeoutMs: READ_TIMEOUT_MS, input: listInput,
    fields: { status: { type: 'string' }, limit: { type: 'number' } },
    reason: 'No service schedules table in shared/schema.ts. Recurring service plans are not stored.' },
  { id: 'service_visits.list', risk: 'low', access: 'read', timeoutMs: READ_TIMEOUT_MS, input: listInput,
    fields: { status: { type: 'string' }, limit: { type: 'number' } }, reason: NO_SERVICE_VISITS },
  { id: 'sites.list', risk: 'low', access: 'read', timeoutMs: READ_TIMEOUT_MS, input: listInput,
    fields: { status: { type: 'string' }, limit: { type: 'number' } }, reason: NO_SITES },
  { id: 'supplier_bills.list', risk: 'low', access: 'read', timeoutMs: READ_TIMEOUT_MS, input: listInput,
    fields: { status: { type: 'string' }, limit: { type: 'number' } },
    reason: 'No supplier bills table in shared/schema.ts.' },
  { id: 'timesheets.list', risk: 'low', access: 'read', timeoutMs: READ_TIMEOUT_MS, input: listInput,
    fields: { status: { type: 'string' }, limit: { type: 'number' } }, reason: NO_TIMESHEETS },
  { id: 'users.list', risk: 'low', access: 'read', timeoutMs: READ_TIMEOUT_MS, input: listInput,
    fields: { status: { type: 'string' }, limit: { type: 'number' } },
    reason: 'The users table holds login accounts and password hashes, and there is no staff roster record. Not exposed.' },
  { id: 'visits.get', risk: 'low', access: 'read', timeoutMs: READ_TIMEOUT_MS, input: idInput,
    fields: { id: { type: 'string', required: true } }, reason: NO_VISITS },
  { id: 'water_test_results.list', risk: 'low', access: 'read', timeoutMs: READ_TIMEOUT_MS, input: listInput,
    fields: { status: { type: 'string' }, limit: { type: 'number' } },
    reason: 'No pool water test results table in shared/schema.ts.' },
  { id: 'work_notes.list', risk: 'low', access: 'read', timeoutMs: READ_TIMEOUT_MS, input: listInput,
    fields: { status: { type: 'string' }, limit: { type: 'number' } },
    reason: 'No work notes table in shared/schema.ts.' },
  { id: 'work_orders.list', risk: 'low', access: 'read', timeoutMs: READ_TIMEOUT_MS, input: listInput,
    fields: { status: { type: 'string' }, limit: { type: 'number' } }, reason: NO_VISITS },

  // ---- writes (scheduling and task changes). None is performed here. ----
  { id: 'service_visits.reschedule', risk: 'high', access: 'write', timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ id: idField, startsAt: isoField }).strict(),
    fields: { id: { type: 'string', required: true }, startsAt: { type: 'string', required: true } },
    reason: NO_SERVICE_VISITS },
  { id: 'service_visits.schedule', risk: 'medium', access: 'write', timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ siteId: idField, startsAt: isoField }).strict(),
    fields: { siteId: { type: 'string', required: true }, startsAt: { type: 'string', required: true } },
    reason: NO_SERVICE_VISITS },
  { id: 'site_visits.schedule', risk: 'medium', access: 'write', timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ siteId: idField, startsAt: isoField }).strict(),
    fields: { siteId: { type: 'string', required: true }, startsAt: { type: 'string', required: true } },
    reason: NO_SITES },
  { id: 'staff_tasks.create', risk: 'low', access: 'write', timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ title: textField(200), description: textField(2000).optional(), relatedId: idField.optional() }).strict(),
    fields: { title: { type: 'string', required: true }, description: { type: 'string' }, relatedId: { type: 'string' } },
    reason: NO_TASKS },
  { id: 'technician_tasks.create', risk: 'medium', access: 'write', timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ title: textField(200), description: textField(2000).optional(), relatedId: idField.optional() }).strict(),
    fields: { title: { type: 'string', required: true }, description: { type: 'string' }, relatedId: { type: 'string' } },
    reason: NO_TASKS },
  { id: 'timesheet_flags.create', risk: 'low', access: 'write', timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ timesheetId: idField, reason: textField(500) }).strict(),
    fields: { timesheetId: { type: 'string', required: true }, reason: { type: 'string', required: true } },
    reason: NO_TIMESHEETS },
  { id: 'visits.transition', risk: 'medium', access: 'write', timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ id: idField, toState: textField(50) }).strict(),
    fields: { id: { type: 'string', required: true }, toState: { type: 'string', required: true } }, reason: NO_VISITS },
  { id: 'visits.update', risk: 'high', access: 'write', timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ id: idField, startsAt: isoField.optional(), assigneeId: idField.optional() }).strict(),
    fields: { id: { type: 'string', required: true }, startsAt: { type: 'string' }, assigneeId: { type: 'string' } },
    reason: NO_VISITS },
  { id: 'water_tests.schedule', risk: 'medium', access: 'write', timeoutMs: WRITE_TIMEOUT_MS,
    input: z.object({ poolId: idField, scheduledFor: isoField }).strict(),
    fields: { poolId: { type: 'string', required: true }, scheduledFor: { type: 'string', required: true } },
    reason: 'No pool or water test table in shared/schema.ts.' },
  { id: 'work_orders.start_visit', risk: 'medium', access: 'write', timeoutMs: WRITE_TIMEOUT_MS, input: idInput,
    fields: { id: { type: 'string', required: true } }, reason: NO_VISITS },
];

/** Strict zod input schema per tool id. Exported so the tests can check each one. */
export const GROUP_04_INPUT_SCHEMAS: Readonly<Record<string, z.ZodType<Record<string, unknown>>>> = Object.freeze(
  Object.fromEntries(GROUP_04_TOOLS.map((tool) => [tool.id, tool.input])),
);

/** Tool ids this group defines. Every one is not_implemented until its source table exists. */
export const GROUP_04_TOOL_IDS: readonly string[] = GROUP_04_TOOLS.map((tool) => tool.id);

function definitionFor(tool: Group04Tool): ToolDefinition {
  return {
    id: tool.id,
    risk: tool.risk,
    access: tool.access,
    timeoutMs: tool.timeoutMs,
    schema: tool.fields,
    handler: (params, context) => {
      requireCompanyId(context.companyId);
      const parsed = tool.input.safeParse(params);
      if (!parsed.success) {
        // Field names only. Values are never echoed back.
        const fields = parsed.error.issues.flatMap((issue) =>
          issue.code === 'unrecognized_keys' ? issue.keys : [issue.path.join('.') || '(input)'],
        );
        throw new Error(`invalid input for ${tool.id}: ${[...new Set(fields)].join(', ')}`);
      }
      const result: Group04Result = { status: 'not_implemented', tool: tool.id, reason: tool.reason };
      return result;
    },
  };
}

/** Registry definitions for group 04. Each handler checks companyId and input, then returns not_implemented. */
export function createGroup04ToolDefinitions(): ToolDefinition[] {
  return GROUP_04_TOOLS.map(definitionFor);
}
