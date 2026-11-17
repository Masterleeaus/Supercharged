// Plans and runs the follow-up sequence for quotes, invoices and leads (#361).
//
// planFollowUp is pure: given an item, its schedule and `now`, it says what happens next.
// runFollowUpPass carries out those plans. Every message goes through gatedSend, and a
// payment demand is never sent without an approval for that exact step.
//
// Outcomes of a pass for one item:
//   send       a message went out (attempts go up by one)
//   deferred   quiet hours, retried on a later pass, attempts unchanged
//   approval   a payment demand is waiting for a person's approval (a request is raised)
//   escalated  a person takes over (attempts used up, or the client cannot be messaged)
//   expired    a quote passed its expiry; no more messages
//   waiting    not yet due

import type { PreSendSurface } from '../../comms/presend-gate.ts';
import type { Channel } from '../../comms/consent.ts';
import { gatedSend, type GatedSendPorts } from './gated-send.ts';
import type { FollowUpKind, FollowUpSchedule, FollowUpStep } from './follow-up-schedule.ts';

export interface FollowUpItem {
  companyId: string;
  id: string;
  kind: FollowUpKind;
  /** ISO time: sent_at for a quote, due date for an invoice, created_at for a lead. */
  anchorAt: string;
  channel: Channel;
  address: string;
  /** Quote accepted, invoice paid, or lead replied. Resolved items get no more messages. */
  resolved: boolean;
  /** Messages sent so far with no resolution. */
  attempts: number;
  expired: boolean;
  escalated: boolean;
  /** Text for the step's message, filled in by the caller for this company. */
  subject: string | null;
  body: string;
}

export type FollowUpPlan =
  | { type: 'waiting'; nextAt: string; stepIndex: number }
  | { type: 'send'; stepIndex: number; step: FollowUpStep }
  | { type: 'expire' }
  | { type: 'escalate'; reason: 'attempts_exhausted' }
  | { type: 'none'; reason: 'resolved' | 'escalated' | 'expired' | 'no_steps_left' };

const HOUR_MS = 3_600_000;

export function planFollowUp(item: FollowUpItem, schedule: FollowUpSchedule, now: Date): FollowUpPlan {
  if (schedule.kind !== item.kind) throw new RangeError('schedule does not match the item kind');
  if (item.resolved) return { type: 'none', reason: 'resolved' };
  if (item.expired) return { type: 'none', reason: 'expired' };

  const anchor = Date.parse(item.anchorAt);
  if (!Number.isFinite(anchor)) throw new RangeError('anchorAt is not a valid time');
  const elapsedHours = (now.getTime() - anchor) / HOUR_MS;

  if (schedule.expireAfterHours !== null && elapsedHours >= schedule.expireAfterHours) {
    return { type: 'expire' };
  }
  if (item.escalated) return { type: 'none', reason: 'escalated' };

  if (item.attempts >= schedule.escalateAfterAttempts) {
    return { type: 'escalate', reason: 'attempts_exhausted' };
  }
  if (item.attempts >= schedule.steps.length) {
    return { type: 'none', reason: 'no_steps_left' };
  }

  const stepIndex = item.attempts;
  const step = schedule.steps[stepIndex];
  if (elapsedHours < step.afterHours) {
    const nextAt = new Date(anchor + step.afterHours * HOUR_MS).toISOString();
    return { type: 'waiting', nextAt, stepIndex };
  }
  return { type: 'send', stepIndex, step };
}

export interface FollowUpStore {
  update(companyId: string, id: string, patch: Partial<Pick<FollowUpItem, 'attempts' | 'expired' | 'escalated'>>): Promise<void>;
}

export interface FollowUpApprovals {
  /** True only for an approval that covers this item and this step. */
  isApproved(companyId: string, itemId: string, stepIndex: number): Promise<boolean>;
  /** Raises a request for a person to approve the step. */
  request(companyId: string, itemId: string, stepIndex: number): Promise<void>;
}

export interface FollowUpEscalations {
  /** Hands the item to a person, with the reason. */
  escalate(companyId: string, itemId: string, reason: string): Promise<void>;
}

export interface FollowUpRunDeps extends GatedSendPorts {
  store: FollowUpStore;
  approvals: FollowUpApprovals;
  escalations: FollowUpEscalations;
  now: () => Date;
}

export interface FollowUpRunResult {
  itemId: string;
  outcome: 'send' | 'deferred' | 'approval' | 'escalated' | 'expired' | 'waiting' | 'none' | 'blocked';
  reason?: string;
}

export async function runFollowUpPass(
  deps: FollowUpRunDeps,
  items: FollowUpItem[],
  schedules: Record<FollowUpKind, FollowUpSchedule>,
): Promise<FollowUpRunResult[]> {
  const results: FollowUpRunResult[] = [];
  const now = deps.now();

  for (const item of items) {
    const schedule = schedules[item.kind];
    const plan = planFollowUp(item, schedule, now);

    if (plan.type === 'waiting') {
      results.push({ itemId: item.id, outcome: 'waiting' });
      continue;
    }
    if (plan.type === 'none') {
      results.push({ itemId: item.id, outcome: 'none', reason: plan.reason });
      continue;
    }
    if (plan.type === 'expire') {
      await deps.store.update(item.companyId, item.id, { expired: true });
      results.push({ itemId: item.id, outcome: 'expired' });
      continue;
    }
    if (plan.type === 'escalate') {
      await deps.store.update(item.companyId, item.id, { escalated: true });
      await deps.escalations.escalate(item.companyId, item.id, plan.reason);
      results.push({ itemId: item.id, outcome: 'escalated', reason: plan.reason });
      continue;
    }

    // plan.type === 'send'
    const requiresApproval = plan.step.kind === 'payment_demand';
    const approved = requiresApproval
      ? await deps.approvals.isApproved(item.companyId, item.id, plan.stepIndex)
      : false;
    if (requiresApproval && !approved) {
      // Nothing is sent. A request is raised and the step waits for a person.
      await deps.approvals.request(item.companyId, item.id, plan.stepIndex);
      results.push({ itemId: item.id, outcome: 'approval' });
      continue;
    }

    const surface: PreSendSurface = 'marketing';
    const outcome = await gatedSend(deps, {
      companyId: item.companyId,
      channel: item.channel,
      address: item.address,
      subject: item.subject,
      body: item.body,
      workflow: `${item.kind}_follow_up`,
      subjectId: item.id,
      surface,
      requiresApproval,
      approved,
    });

    if (outcome.status === 'sent') {
      await deps.store.update(item.companyId, item.id, { attempts: item.attempts + 1 });
      results.push({ itemId: item.id, outcome: 'send' });
    } else if (outcome.status === 'deferred') {
      results.push({ itemId: item.id, outcome: 'deferred', reason: outcome.reason });
    } else if (outcome.status === 'blocked' && outcome.reason === 'approval_required') {
      await deps.approvals.request(item.companyId, item.id, plan.stepIndex);
      results.push({ itemId: item.id, outcome: 'approval' });
    } else if (outcome.status === 'blocked') {
      // The client cannot be messaged (no consent, opted out, suppressed). A person decides next.
      await deps.store.update(item.companyId, item.id, { escalated: true });
      await deps.escalations.escalate(item.companyId, item.id, `not_contactable:${outcome.reason}`);
      results.push({ itemId: item.id, outcome: 'blocked', reason: outcome.reason });
    } else {
      // Transport failure. Attempts are not counted, so the step is tried again on a later pass.
      results.push({ itemId: item.id, outcome: 'none', reason: 'transport_failed' });
    }
  }

  return results;
}
