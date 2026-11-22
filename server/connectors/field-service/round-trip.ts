/**
 * Enquiry-to-job and job-status round trip for the field-service connectors (#355).
 *
 * Flow: a canonical lead becomes a customer and a job in the field-service tool (enquiryToJob). A job
 * status change in the tool comes back as a canonical status and, when the status matters to the
 * customer, a customer message plan (planCustomerStatusMessage). Sending the message is the caller's job.
 *
 * Vendor calls go through sdk/runner.ts (timeouts, audit, retry for reads). Tests inject scripted fetch
 * through the connector definitions. Nothing here touches a live vendor account.
 *
 * Jobber: job-update webhooks are signed (verifyWebhook) and carry only ids, so the status is read back
 * with getJob. ServiceM8: no webhook signature exists, so the status is polled with getJob.
 */
import { runAction } from '../sdk/runner.ts';
import type { ConnectorCredentials, ConnectorDefinition } from '../sdk/contract.ts';
import { mapRecord } from '../sdk/field-mapping.ts';
import type { CanonicalLead } from '../leads/lead-intake.ts';
import { JOBBER_JOB_MAPPING } from '../providers/jobber.ts';
import { SERVICEM8_JOB_MAPPING } from '../providers/servicem8.ts';
import type { CanonicalJobStatus } from '../providers/canonical-job-status.ts';

export type FieldServiceVendor = 'jobber' | 'servicem8';

export interface RoundTripContext {
  definition: ConnectorDefinition;
  companyId: string;
  credentials: ConnectorCredentials;
  timeoutMs: number;
  /** Runner retry policy. Reads only are retried; creates are single-attempt (see the provider headers). */
  retry: Parameters<typeof runAction>[0]['retry'];
  audit: Parameters<typeof runAction>[0]['audit'];
}

export interface EnquiryJobResult {
  vendor: FieldServiceVendor;
  customerId: string;
  jobId: string;
  status: CanonicalJobStatus | 'unknown';
}

export interface JobStatusRead {
  jobId: string;
  customerId: string | null;
  status: CanonicalJobStatus | 'unknown';
}

/** Statuses that matter to the customer. Other canonical statuses send no message. */
export const CUSTOMER_STATUS_MESSAGES: Partial<Record<CanonicalJobStatus, string>> = {
  scheduled: 'Your job has been scheduled. We will confirm the arrival time shortly.',
  in_progress: 'We have started your job.',
  completed: 'Your job is complete. Thank you for choosing us.',
  invoiced: 'Your invoice for the job is ready.',
  cancelled: 'Your job has been cancelled. Get in touch if this was not expected.',
};

export interface CustomerMessagePlan {
  channel: 'message';
  to: string;
  body: string;
  status: CanonicalJobStatus;
}

const TITLE_MAX = 120;

function act(ctx: RoundTripContext, action: string, input: unknown, stableId?: string): Promise<unknown> {
  return runAction({
    definition: ctx.definition,
    companyId: ctx.companyId,
    action,
    input,
    credentials: ctx.credentials,
    timeoutMs: ctx.timeoutMs,
    retry: ctx.retry,
    audit: ctx.audit,
    ...(stableId ? { stableId } : {}),
  }).then((r) => r.value);
}

function splitName(name: string): { firstName: string; lastName?: string } {
  const parts = name.trim().split(/\s+/);
  const firstName = parts[0] || name.trim();
  const lastName = parts.slice(1).join(' ');
  return lastName ? { firstName, lastName } : { firstName };
}

function jobTitle(lead: CanonicalLead): string {
  return lead.message.slice(0, TITLE_MAX);
}

/** Creates the customer and the job for one enquiry in the field-service tool. */
export async function enquiryToJob(vendor: FieldServiceVendor, ctx: RoundTripContext, lead: CanonicalLead): Promise<EnquiryJobResult> {
  const stableId = `enquiry:${lead.source}:${lead.sourceRef ?? lead.receivedAt}`;
  if (vendor === 'jobber') {
    const client = (await act(ctx, 'createClient', splitName(lead.name), `${stableId}:client`)) as { id?: string } | null;
    if (!client?.id) throw new Error('jobber createClient returned no id');
    const job = (await act(ctx, 'createJob', { customerId: client.id, title: jobTitle(lead) }, `${stableId}:job`)) as Record<string, unknown> | null;
    const mapped = mapRecord(job, JOBBER_JOB_MAPPING);
    return { vendor, customerId: client.id, jobId: String(job?.id ?? ''), status: (mapped.status as EnquiryJobResult['status']) ?? 'unknown' };
  }
  const contact = (await act(ctx, 'createContact', { name: lead.name, email: lead.email }, `${stableId}:contact`)) as { uuid?: string } | null;
  if (!contact?.uuid) throw new Error('servicem8 createContact returned no uuid');
  const created = (await act(ctx, 'createJob', { customerId: contact.uuid, title: jobTitle(lead) }, `${stableId}:job`)) as { uuid?: string } | null;
  if (!created?.uuid) throw new Error('servicem8 createJob returned no uuid');
  const read = await readJobStatus('servicem8', ctx, created.uuid);
  return { vendor, customerId: contact.uuid, jobId: created.uuid, status: read.status };
}

/** Reads one job and maps it onto the canonical status. */
export async function readJobStatus(vendor: FieldServiceVendor, ctx: RoundTripContext, jobId: string): Promise<JobStatusRead> {
  const record = await act(ctx, 'getJob', { id: jobId });
  const mapping = vendor === 'jobber' ? JOBBER_JOB_MAPPING : SERVICEM8_JOB_MAPPING;
  const mapped = mapRecord(record, mapping);
  const customerId = typeof mapped.customerId === 'string' ? mapped.customerId : null;
  return { jobId, customerId, status: (mapped.status as JobStatusRead['status']) ?? 'unknown' };
}

/** Message plan for a customer-visible status change. Null when nothing changed or no message applies. */
export function planCustomerStatusMessage(read: JobStatusRead, lastStatus: string | null): CustomerMessagePlan | null {
  if (read.status === lastStatus || read.customerId === null) return null;
  const body = CUSTOMER_STATUS_MESSAGES[read.status as CanonicalJobStatus];
  if (!body) return null;
  return { channel: 'message', to: read.customerId, body, status: read.status as CanonicalJobStatus };
}

export interface JobberWebhookResult {
  ok: boolean;
  reason?: 'bad_signature' | 'ignored_topic' | 'duplicate';
  changed?: boolean;
  status?: CanonicalJobStatus | 'unknown';
  message?: CustomerMessagePlan | null;
}

/**
 * Handles one Jobber JOB_UPDATE webhook. Signature is checked on the raw body first. The event id
 * (topic, itemId, occurredAt) is recorded in `seen` so a redelivery does nothing (Jobber is at-least-once).
 */
export async function handleJobberJobUpdate(
  ctx: RoundTripContext,
  input: { rawBody: string; signature: string; secret: string; lastStatus: string | null; seen: Set<string> },
): Promise<JobberWebhookResult> {
  if (!ctx.definition.verifyWebhook?.(input.rawBody, input.signature, input.secret)) return { ok: false, reason: 'bad_signature' };
  const event = (JSON.parse(input.rawBody) as { data?: { webhookEvent?: { topic?: string; itemId?: string; occurredAt?: string } } })
    .data?.webhookEvent;
  if (event?.topic !== 'JOB_UPDATE' || !event.itemId) return { ok: false, reason: 'ignored_topic' };
  const eventKey = `JOB_UPDATE:${event.itemId}:${event.occurredAt ?? ''}`;
  if (input.seen.has(eventKey)) return { ok: true, reason: 'duplicate', changed: false };
  input.seen.add(eventKey);
  const read = await readJobStatus('jobber', ctx, event.itemId);
  const message = planCustomerStatusMessage(read, input.lastStatus);
  return { ok: true, changed: read.status !== input.lastStatus, status: read.status, message };
}

/** ServiceM8 has no webhook signature, so the status is polled. Returns the same shape as a webhook result. */
export async function pollServiceM8JobStatus(ctx: RoundTripContext, jobId: string, lastStatus: string | null): Promise<JobberWebhookResult> {
  const read = await readJobStatus('servicem8', ctx, jobId);
  return { ok: true, changed: read.status !== lastStatus, status: read.status, message: planCustomerStatusMessage(read, lastStatus) };
}
