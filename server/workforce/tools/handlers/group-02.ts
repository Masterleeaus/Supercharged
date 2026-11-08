/**
 * Group 02 workforce tools: job sign-off, maintenance plans, messages, opportunities, ownership checks, payment plans,
 * pool equipment and profiles, project visits, projects, properties and property contacts.
 *
 * None of these tools has a company-scoped data source in this repo (see shared/schema.ts and tools/READ_TOOLS.md).
 * Each handler therefore validates its input, checks the company id, and returns an explicit `not_implemented`
 * result with the reason. No data is read, no row is written, and no provider is called.
 *
 * Side-effect tools are routed by the registry, not by this file:
 *   - customer_send tools (messages.send, messages.send_customer, job_signoff.request) need owner approval first.
 *     After approval the handler still returns not_implemented, because no messaging provider is wired here.
 *   - money tools (payment_plans.propose) need owner approval first and are never executed here.
 *   - messages.draft_customer is a draft tool. The registry stages it and no handler runs.
 *
 * companyId comes only from the caller context, never from input. Input is parsed with a strict zod schema, so an
 * input that carries companyId (or any other unknown key) is rejected.
 */
import { z } from 'zod';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { ToolDefinition, ToolSchema } from '../../runtime/tool-registry.ts';

const MAX_LIMIT = 50;

export class Group02InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Group02InputError';
  }
}

// ---- Input schemas -------------------------------------------------------------------------------------------------

const id = z.string().trim().min(1).max(128);
const shortText = (max: number) => z.string().trim().min(1).max(max);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const time = z.string().regex(/^\d{2}:\d{2}$/, 'expected HH:MM');
const limit = z.number().int().min(1).max(MAX_LIMIT).optional();

const jobSignoffRecordInput = z
  .object({
    jobId: id,
    outcome: z.enum(['signed', 'declined']),
    signedByName: shortText(200),
    notes: z.string().max(2000).optional(),
  })
  .strict();
const jobSignoffRequestInput = z.object({ jobId: id, note: z.string().max(1000).optional() }).strict();
const maintenancePlansCreateInput = z
  .object({
    clientId: id,
    propertyId: id.optional(),
    serviceName: shortText(200),
    frequency: z.enum(['monthly', 'quarterly', 'biannual', 'annual']),
    startDate: date,
  })
  .strict();
const materialsCheckInput = z.object({ jobId: id }).strict();
const messagesDraftCustomerInput = z
  .object({ clientId: id, purpose: shortText(200), details: z.string().max(2000).optional() })
  .strict();
const messagesSendInput = z
  .object({ clientId: id, channel: z.enum(['sms', 'email']), body: shortText(2000) })
  .strict();
const opportunitiesCreateInput = z
  .object({
    clientId: id.optional(),
    title: shortText(200),
    valueCents: z.number().int().min(0).optional(),
    stage: shortText(50).optional(),
  })
  .strict();
const ownershipVerifyInput = z
  .object({
    clientId: id,
    method: z.enum(['document', 'callback', 'in_person']),
    reference: shortText(200).optional(),
  })
  .strict();
const partsListsListInput = z.object({ jobId: id, limit }).strict();
const paymentPlansProposeInput = z
  .object({
    invoiceId: id,
    installments: z.number().int().min(2).max(12),
    firstDueDate: date,
  })
  .strict();
const poolEquipmentListInput = z.object({ poolId: id.optional(), limit }).strict();
const poolEquipmentFaultsCreateInput = z
  .object({
    poolId: id,
    equipmentId: id.optional(),
    description: shortText(1000),
    severity: z.enum(['low', 'medium', 'high']).optional(),
  })
  .strict();
const poolProfilesListInput = z
  .object({ clientId: id.optional(), propertyId: id.optional(), limit })
  .strict();
const projectVisitsBulkInput = z
  .object({
    jobId: id,
    visits: z
      .array(
        z
          .object({
            scheduledDate: date,
            startTime: time.optional(),
            durationMinutes: z.number().int().min(1).max(1440),
          })
          .strict(),
      )
      .min(1)
      .max(MAX_LIMIT),
  })
  .strict();
const projectVisitsListInput = z.object({ jobId: id, limit }).strict();
const projectsGetInput = z.object({ id }).strict();
const projectsListInput = z.object({ status: shortText(50).optional(), limit }).strict();
const propertiesListInput = z.object({ clientId: id.optional(), limit }).strict();
const propertyContactsListInput = z.object({ propertyId: id, limit }).strict();

// ---- Specs ---------------------------------------------------------------------------------------------------------

type Risk = ToolDefinition['risk'];
type Access = NonNullable<ToolDefinition['access']>;
type Category = NonNullable<ToolDefinition['category']>;

export interface Group02Spec {
  id: string;
  risk: Risk;
  access: Access;
  category?: Category;
  input: z.ZodObject<z.ZodRawShape>;
  /** Why the handler returns not_implemented. Shown to the caller. */
  reason: string;
}

const NO_SOURCE = 'No matching table or data source in this repo.';

export const GROUP_02_SPECS: readonly Group02Spec[] = [
  {
    id: 'job_signoff.record',
    risk: 'high',
    access: 'write',
    input: jobSignoffRecordInput,
    reason: `${NO_SOURCE} Recording a sign-off needs a sign-off store first.`,
  },
  {
    id: 'job_signoff.request',
    risk: 'critical',
    access: 'write',
    category: 'customer_send',
    input: jobSignoffRequestInput,
    reason: `${NO_SOURCE} Customer send needs owner approval, and no messaging provider is wired, so nothing is sent.`,
  },
  {
    id: 'maintenance_plans.create',
    risk: 'high',
    access: 'write',
    input: maintenancePlansCreateInput,
    reason: `${NO_SOURCE} No maintenance plan table in shared/schema.ts.`,
  },
  {
    id: 'materials.check',
    risk: 'low',
    access: 'read',
    input: materialsCheckInput,
    reason: `${NO_SOURCE} No materials or parts table in shared/schema.ts.`,
  },
  {
    id: 'messages.draft_customer',
    risk: 'low',
    access: 'write',
    input: messagesDraftCustomerInput,
    reason: 'Draft tool: the registry stages drafts and no handler runs. No drafting data source exists in this repo.',
  },
  {
    id: 'messages.send',
    risk: 'critical',
    access: 'write',
    category: 'customer_send',
    input: messagesSendInput,
    reason: 'Customer send needs owner approval. No messaging provider is wired in this pass, so nothing is sent.',
  },
  {
    id: 'messages.send_customer',
    risk: 'critical',
    access: 'write',
    category: 'customer_send',
    input: messagesSendInput,
    reason: 'Customer send needs owner approval. No messaging provider is wired in this pass, so nothing is sent.',
  },
  {
    id: 'opportunities.create',
    risk: 'medium',
    access: 'write',
    input: opportunitiesCreateInput,
    reason:
      'leads has company_id, but its required user_id, source and phone fields have no mapping from this input. Not guessed.',
  },
  {
    id: 'ownership.verify',
    risk: 'high',
    access: 'write',
    input: ownershipVerifyInput,
    reason: `${NO_SOURCE} No identity verification provider is wired, so no check is made.`,
  },
  {
    id: 'parts_lists.list',
    risk: 'low',
    access: 'read',
    input: partsListsListInput,
    reason: `${NO_SOURCE} No parts list table in shared/schema.ts.`,
  },
  {
    id: 'payment_plans.propose',
    risk: 'critical',
    access: 'write',
    category: 'money',
    input: paymentPlansProposeInput,
    reason: `${NO_SOURCE} No payment plan table. Money is never moved here, and the proposal needs owner approval.`,
  },
  {
    id: 'pool_equipment.list',
    risk: 'low',
    access: 'read',
    input: poolEquipmentListInput,
    reason: `${NO_SOURCE} No pool equipment table in shared/schema.ts.`,
  },
  {
    id: 'pool_equipment_faults.create',
    risk: 'medium',
    access: 'write',
    input: poolEquipmentFaultsCreateInput,
    reason: `${NO_SOURCE} No pool equipment fault table in shared/schema.ts.`,
  },
  {
    id: 'pool_profiles.list',
    risk: 'low',
    access: 'read',
    input: poolProfilesListInput,
    reason: `${NO_SOURCE} No pool profile table in shared/schema.ts.`,
  },
  {
    id: 'project_visits.bulk',
    risk: 'high',
    access: 'write',
    input: projectVisitsBulkInput,
    reason: `${NO_SOURCE} No job visit table. appointments are booking requests with no job link.`,
  },
  {
    id: 'project_visits.list',
    risk: 'low',
    access: 'read',
    input: projectVisitsListInput,
    reason: `${NO_SOURCE} No job visit table. appointments are booking requests with no job link.`,
  },
  {
    id: 'projects.get',
    risk: 'low',
    access: 'read',
    input: projectsGetInput,
    reason: `${NO_SOURCE} No projects or jobs table in shared/schema.ts.`,
  },
  {
    id: 'projects.list',
    risk: 'low',
    access: 'read',
    input: projectsListInput,
    reason: `${NO_SOURCE} No projects or jobs table in shared/schema.ts.`,
  },
  {
    id: 'properties.list',
    risk: 'low',
    access: 'read',
    input: propertiesListInput,
    reason: `${NO_SOURCE} user_addresses holds Twilio regulatory addresses, not service properties.`,
  },
  {
    id: 'property_contacts.list',
    risk: 'low',
    access: 'read',
    input: propertyContactsListInput,
    reason: `${NO_SOURCE} No property contacts table in shared/schema.ts.`,
  },
];

// ---- Helpers -------------------------------------------------------------------------------------------------------

function parseInput(schema: z.ZodTypeAny, input: unknown): void {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Field names only. Values are never echoed back.
    const fields = result.error.issues.flatMap((issue) => {
      if (issue.code === 'unrecognized_keys') return issue.keys;
      return [issue.path.join('.') || '(input)'];
    });
    throw new Group02InputError(`invalid input: ${[...new Set(fields)].join(', ')}`);
  }
}

function fieldType(field: z.ZodTypeAny): ToolSchema[string]['type'] {
  const inner = field instanceof z.ZodOptional ? field.unwrap() : field;
  if (inner instanceof z.ZodNumber) return 'number';
  if (inner instanceof z.ZodArray) return 'array';
  if (inner instanceof z.ZodObject) return 'object';
  return 'string';
}

/** Field-type schema for the registry, derived from the zod shape so the two cannot drift apart. */
function toToolSchema(input: z.ZodObject<z.ZodRawShape>): ToolSchema {
  const entries = Object.entries(input.shape).map(([key, field]) => {
    const zodField = field as z.ZodTypeAny;
    return [key, { type: fieldType(zodField), required: !zodField.isOptional() }] as const;
  });
  return Object.fromEntries(entries);
}

async function run(spec: Group02Spec, rawCompanyId: unknown, input: unknown) {
  requireCompanyId(rawCompanyId);
  parseInput(spec.input, input);
  return { status: 'not_implemented', toolId: spec.id, reason: spec.reason };
}

/** Registry definitions for every group 02 tool. Reads timeout after 10 s, writes and side effects after 20 s. */
export function createGroup02ToolDefinitions(): ToolDefinition[] {
  return GROUP_02_SPECS.map((spec) => ({
    id: spec.id,
    risk: spec.risk,
    access: spec.access,
    ...(spec.category === undefined ? {} : { category: spec.category }),
    schema: toToolSchema(spec.input),
    timeoutMs: spec.access === 'read' ? 10000 : 20000,
    handler: (params, context) => run(spec, context.companyId, params),
  }));
}
