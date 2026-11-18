// Runs one outreach workflow over a list of candidates (#360). Each candidate is sent at most once
// per cycle, through gatedSend. Outcomes (review received, client rebooked) are attributed back to
// the send that came before them, so campaign results can be counted.
//
// The store is an injected port. A durable adapter is not part of this change.

import type { Channel } from '../../comms/consent.ts';
import type { PreSendSurface } from '../../comms/presend-gate.ts';
import { gatedSend, type GatedSendPorts, type GatedSendOutcome } from './gated-send.ts';
import {
  BULK_WORKFLOWS,
  DEFAULT_TEMPLATES,
  renderTemplate,
  WORKFLOW_SURFACE,
  type OutreachWorkflow,
} from './outreach-rules.ts';

export interface OutreachCandidate {
  workflow: OutreachWorkflow;
  subjectId: string;
  channel: Channel;
  address: string;
  /** Distinguishes cycles of the same workflow, for example a season key or a visit id. */
  cycleKey: string;
  /** Values for the template placeholders. */
  vars: Record<string, string>;
  /** Overrides the default copy for this company, when set. */
  templateOverride?: { subject: string | null; body: string } | null;
}

export interface SendRecord {
  companyId: string;
  key: string;
  workflow: OutreachWorkflow;
  subjectId: string;
  channel: Channel;
  campaignId: string;
  at: string;
  externalId: string;
}

export interface OutreachStore {
  hasSent(companyId: string, key: string): Promise<boolean>;
  recordSend(record: SendRecord): Promise<void>;
  listSends(companyId: string, subjectId: string): Promise<SendRecord[]>;
}

export interface OutreachRunDeps extends GatedSendPorts {
  store: OutreachStore;
  now: () => Date;
  /** Campaign id per workflow, so outcomes can be grouped by campaign. */
  campaignIdFor: (workflow: OutreachWorkflow) => string;
  /**
   * Approval gate for bulk workflows (BULK_WORKFLOWS). True only when a person approved this
   * exact cycle. Not set: bulk cycles are never approved, so nothing is sent for them.
   */
  isApproved?: (companyId: string, workflow: OutreachWorkflow, cycleKey: string) => Promise<boolean>;
}

export interface OutreachRunSummary {
  sent: number;
  skippedAlreadySent: number;
  blocked: Partial<Record<string, number>>;
  deferred: number;
  failed: number;
  renderFailed: number;
}

export function outreachKey(companyId: string, c: Pick<OutreachCandidate, 'workflow' | 'subjectId' | 'cycleKey'>): string {
  return `${companyId}:${c.workflow}:${c.subjectId}:${c.cycleKey}`;
}

export async function runOutreach(
  deps: OutreachRunDeps,
  companyId: string,
  candidates: OutreachCandidate[],
): Promise<OutreachRunSummary> {
  const summary: OutreachRunSummary = {
    sent: 0,
    skippedAlreadySent: 0,
    blocked: {},
    deferred: 0,
    failed: 0,
    renderFailed: 0,
  };

  for (const c of candidates) {
    const key = outreachKey(companyId, c);
    if (await deps.store.hasSent(companyId, key)) {
      summary.skippedAlreadySent += 1;
      continue;
    }

    const template = c.templateOverride ?? DEFAULT_TEMPLATES[c.workflow];
    let subject: string | null;
    let body: string;
    try {
      subject = template.subject === null ? null : renderTemplate(template.subject, c.vars);
      body = renderTemplate(template.body, c.vars);
    } catch {
      // Missing data is a skip for this one candidate. The rest of the run continues.
      summary.renderFailed += 1;
      continue;
    }

    const surface: PreSendSurface = WORKFLOW_SURFACE[c.workflow];
    const requiresApproval = BULK_WORKFLOWS.has(c.workflow);
    const approved =
      requiresApproval && deps.isApproved !== undefined
        ? await deps.isApproved(companyId, c.workflow, c.cycleKey)
        : false;
    const outcome: GatedSendOutcome = await gatedSend(deps, {
      companyId,
      channel: c.channel,
      address: c.address,
      subject,
      body,
      workflow: c.workflow,
      subjectId: c.subjectId,
      surface,
      requiresApproval,
      approved,
    });

    if (outcome.status === 'sent') {
      summary.sent += 1;
      await deps.store.recordSend({
        companyId,
        key,
        workflow: c.workflow,
        subjectId: c.subjectId,
        channel: c.channel,
        campaignId: deps.campaignIdFor(c.workflow),
        at: deps.now().toISOString(),
        externalId: outcome.externalId,
      });
    } else if (outcome.status === 'blocked') {
      summary.blocked[outcome.reason] = (summary.blocked[outcome.reason] ?? 0) + 1;
    } else if (outcome.status === 'deferred') {
      summary.deferred += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

export type OutreachOutcome =
  | { kind: 'review_received'; subjectId: string; at: string }
  | { kind: 'rebooked'; subjectId: string; at: string };

/**
 * Attributes an outcome to the most recent send to the same subject that came before it, within
 * `windowDays`. Returns null when no send qualifies. Only sends of the matching workflow count.
 */
export function attributeOutcome(
  sends: SendRecord[],
  outcome: OutreachOutcome,
  windowDays = 30,
): SendRecord | null {
  const workflowFor: Record<OutreachOutcome['kind'], OutreachWorkflow[]> = {
    review_received: ['review_request'],
    rebooked: ['client_reactivation', 'seasonal_reminder', 'stale_job_nudge'],
  };
  const at = Date.parse(outcome.at);
  if (!Number.isFinite(at)) throw new RangeError('outcome time is invalid');
  const floor = at - windowDays * 86_400_000;
  let best: SendRecord | null = null;
  for (const s of sends) {
    if (s.subjectId !== outcome.subjectId) continue;
    if (!workflowFor[outcome.kind].includes(s.workflow)) continue;
    const sentAt = Date.parse(s.at);
    if (!Number.isFinite(sentAt) || sentAt > at || sentAt < floor) continue;
    if (best === null || sentAt > Date.parse(best.at)) best = s;
  }
  return best;
}
