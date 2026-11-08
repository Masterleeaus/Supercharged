/**
 * Group 01 tool definitions: 18 declared tools with no typed handler before this change.
 *
 * Most of these have no company-scoped table in shared/schema.ts and no ported implementation in this repo. Per the
 * group rules they return a `not_implemented` result with the reason. Nothing is invented and no data is returned.
 *
 * Side-effect tools (customer sends, survey sends, photo requests, identity verification) are never executed here.
 * Their category or risk makes the registry gate them behind owner approval (always-approval list, runtime/
 * always-approval.ts). Even after approval, the handler returns `not_implemented`: no provider is called.
 *
 * customer_messages.draft is the one implemented tool. It composes a draft for a person to review and sends nothing.
 * The registry stages every draft tool without running its handler, so this handler is a pure echo of its input.
 *
 * companyId comes only from the caller context, never from input. Input schemas are strict.
 * No network, database or environment access happens in this file.
 */
import { z } from 'zod';
import { requireCompanyId } from '../../../services/ai-runtime/company.ts';
import type { CompanyId } from '../../../services/ai-runtime/types.ts';
import type { ToolDefinition, ToolSchema } from '../../runtime/tool-registry.ts';

const READ_TIMEOUT_MS = 10000;
const WRITE_TIMEOUT_MS = 20000;

export interface NotImplemented {
  status: 'not_implemented';
  toolId: string;
  reason: string;
}

function notImplemented(toolId: string, reason: string): NotImplemented {
  return { status: 'not_implemented', toolId, reason };
}

// Inputs for tools with no data source yet accept no fields. companyId and any other key are rejected.
const noFieldsInput = z.object({}).strict();
const noFieldsSchema: ToolSchema = {};

const draftInput = z
  .object({
    channel: z.enum(['sms', 'email']).optional(),
    body: z.string().trim().min(1).max(2000),
    customerName: z.string().trim().min(1).max(120).optional(),
  })
  .strict();
const draftSchema: ToolSchema = {
  channel: { type: 'string' },
  body: { type: 'string', required: true },
  customerName: { type: 'string' },
};

interface Group01Spec {
  id: string;
  access: 'read' | 'write';
  risk: 'low' | 'medium' | 'high' | 'critical';
  category?: 'customer_send';
  timeoutMs: number;
  schema: ToolSchema;
  input: z.ZodType<unknown>;
  run: (companyId: CompanyId, input: unknown) => Promise<unknown>;
}

const NO_TABLE = (what: string) => `No ${what} table or source in shared/schema.ts. Nothing is invented.`;
const ESCALATION_REASON =
  'No escalation table or queue. workforce_tasks is run bookkeeping, not an escalation queue.';
const SEND_NOT_IN_PASS =
  'Real customer send is not in this pass. The registry gates this tool behind owner approval. Nothing is sent.';

/** A tool with no data source or no safe path yet: no fields accepted, returns not_implemented with the reason. */
function unimplemented(
  id: string,
  reason: string,
  risk: Group01Spec['risk'],
  access: 'read' | 'write',
  category?: 'customer_send',
): Group01Spec {
  return {
    id,
    access,
    risk,
    ...(category !== undefined ? { category } : {}),
    timeoutMs: access === 'read' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS,
    schema: noFieldsSchema,
    input: noFieldsInput,
    run: async () => notImplemented(id, reason),
  };
}

const SPECS: Group01Spec[] = [
  {
    id: 'customer_messages.draft',
    access: 'write',
    risk: 'low',
    timeoutMs: WRITE_TIMEOUT_MS,
    schema: draftSchema,
    input: draftInput,
    run: async (companyId, input) => {
      requireCompanyId(companyId);
      const args = draftInput.parse(input);
      return {
        status: 'draft',
        channel: args.channel ?? 'sms',
        customerName: args.customerName ?? null,
        body: args.body,
        sent: false,
      };
    },
  },
  unimplemented('customer_messages.send', SEND_NOT_IN_PASS, 'critical', 'write', 'customer_send'),
  unimplemented('feedback_surveys.send', SEND_NOT_IN_PASS, 'critical', 'write', 'customer_send'),
  unimplemented('job_photos.request_from_customer', SEND_NOT_IN_PASS, 'critical', 'write', 'customer_send'),
  unimplemented('identity.verify_request', 'No identity provider or verification table. No provider is called here.', 'critical', 'write'),
  unimplemented('crew_rosters.update', NO_TABLE('crew roster'), 'high', 'write'),
  unimplemented('disputes.create', NO_TABLE('disputes'), 'medium', 'write'),
  unimplemented('invoice_disputes.create', NO_TABLE('invoice disputes'), 'medium', 'write'),
  unimplemented('end_of_lease_checklists.create', NO_TABLE('end-of-lease checklist'), 'medium', 'write'),
  unimplemented('escalations.create', ESCALATION_REASON, 'low', 'write'),
  unimplemented('human_escalation.create', ESCALATION_REASON, 'low', 'write'),
  unimplemented('estimates.create', NO_TABLE('estimates'), 'high', 'write'),
  unimplemented('estimates.list', NO_TABLE('estimates'), 'low', 'read'),
  unimplemented('feedback_responses.create', 'No customer feedback table. userFeedback is product feedback keyed by user.', 'medium', 'write'),
  unimplemented('inventory.list', NO_TABLE('stock'), 'low', 'read'),
  unimplemented('job_checklists.list', NO_TABLE('job checklist'), 'low', 'read'),
  unimplemented('job_notes.create', NO_TABLE('job notes'), 'low', 'write'),
  unimplemented('job_photos.list', NO_TABLE('job photos'), 'low', 'read'),
];

/** The 18 tool ids this group owns, in the order of /tmp/grp01.txt. */
export const GROUP_01_TOOL_IDS: readonly string[] = SPECS.map((spec) => spec.id);

/** Zod input schema per tool id. Tests and callers parse with it. */
export const GROUP_01_INPUT_SCHEMAS: Readonly<Record<string, z.ZodType<unknown>>> = Object.fromEntries(
  SPECS.map((spec) => [spec.id, spec.input]),
);

/** Registry definitions for group 01. Each handler takes companyId from the caller context only. */
export function createGroup01ToolDefinitions(): ToolDefinition[] {
  return SPECS.map((spec) => ({
    id: spec.id,
    risk: spec.risk,
    access: spec.access,
    ...(spec.category !== undefined ? { category: spec.category } : {}),
    timeoutMs: spec.timeoutMs,
    schema: spec.schema,
    handler: async (params, context) => spec.run(requireCompanyId(context.companyId), spec.input.parse(params)),
  }));
}
