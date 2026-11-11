/*
 * Campaign service. Pure logic over injected ports. Nothing here sends a message by
 * itself: the only exit is SendTransport, and dispatchJob is the only caller of it.
 *
 * Send rules:
 *   - Every send batch (one campaign step) goes through the approvals gate. Humans and
 *     agents both go through it. There is no bypass.
 *   - The approval is bound to a hash of the recipient list and the step content. If
 *     either changes after approval, nothing is queued.
 *   - Consent is checked at request, at release, and again at dispatch. An address needs
 *     an active opt-in and must not be on the unsubscribe list. Unsubscribe always wins.
 *   - An audience with no opt-in record at all is refused outright.
 */
import { createHash, randomUUID } from 'node:crypto';
import { requireCompanyId } from '../chatbot/chatbot-scope.ts';
import {
  checkConsent,
  isValidTimezone,
  type CheckConsentInput,
  type ConsentDecision,
  type ConsentEvent,
  type Contact as ConsentContact,
  type QuietHours,
} from '../comms/consent.ts';
import { gateCommsAction } from '../comms/suggest-reply.ts';
import { getDefaultCompanySettingsStore, type CompanySettingsStore } from '../settings/company-settings.ts';
import { rewriteCampaignLinks } from './campaign-links.ts';
import type { SuppressionList } from '../comms/suppression.ts';
import type { ApprovalPort, CampaignStore, SendTransport } from './ports.ts';
import {
  CAMPAIGN_CHANNELS,
  MAX_BODY_LENGTH,
  MAX_SUBJECT_LENGTH,
  MAX_TAGS,
  SEND_ACTION,
  type Actor,
  type Audience,
  type Campaign,
  type CampaignChannel,
  type CampaignStep,
  type Contact,
  type OptInRecord,
  type SendJob,
  type SendJobStatus,
  type SkipReason,
  type UnsubscribeEntry,
} from './types.ts';

/** A campaign contact plus the recipient's IANA timezone, used for quiet hours. */
type StoredContact = Contact & { timezone?: string | null };

/** An agent actor may carry its autonomy tier. Absent means the ladder refuses it (fail closed). */
type AgentActor = Actor & { autonomy?: unknown };

export type CampaignErrorCode = 'invalid' | 'not_found' | 'forbidden' | 'conflict' | 'refused';

export class CampaignError extends Error {
  readonly code: CampaignErrorCode;

  constructor(message: string, code: CampaignErrorCode) {
    super(message);
    this.name = 'CampaignError';
    this.code = code;
  }
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9]\d{6,14}$/;

/** Trims and lowercases email. Validates E.164 for sms. Returns the stored form. */
export function normaliseAddress(channel: CampaignChannel, raw: unknown): string {
  if (typeof raw !== 'string') throw new CampaignError('address is required', 'invalid');
  const value = channel === 'email' ? raw.trim().toLowerCase() : raw.trim();
  const ok = channel === 'email' ? value.length <= 320 && EMAIL.test(value) : E164.test(value);
  if (!ok) throw new CampaignError(`address is not valid for ${channel}`, 'invalid');
  return value;
}

/** Hash over the sorted channel:address list. Order does not matter, membership does. */
export function recipientsHash(recipients: ReadonlyArray<{ channel: CampaignChannel; address: string }>): string {
  const lines = recipients.map((r) => `${r.channel}:${r.address}`).sort();
  return sha256(JSON.stringify(lines));
}

export function contentHash(step: { subject: string | null; body: string }): string {
  return sha256(JSON.stringify([step.subject, step.body]));
}

function assertChannel(value: unknown): CampaignChannel {
  if (typeof value !== 'string' || !(CAMPAIGN_CHANNELS as readonly string[]).includes(value)) {
    throw new CampaignError(`channel must be one of ${CAMPAIGN_CHANNELS.join(', ')}`, 'invalid');
  }
  return value as CampaignChannel;
}

function assertText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new CampaignError(`${field} must be a non-empty string up to ${max} chars`, 'invalid');
  }
  return value;
}

function assertTags(value: unknown, required: boolean): string[] {
  if (value === undefined) {
    if (required) throw new CampaignError('tags must list at least one tag', 'invalid');
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_TAGS || (required && value.length === 0)) {
    throw new CampaignError(`tags must be an array of 1 to ${MAX_TAGS} strings`, 'invalid');
  }
  if (!value.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 64)) {
    throw new CampaignError('each tag must be a non-empty string up to 64 chars', 'invalid');
  }
  return [...new Set(value as string[])];
}

/** Consent check used at request, release and dispatch. Defaults to checkConsent from comms/consent.ts. */
export type ConsentChecker = (input: CheckConsentInput) => ConsentDecision;

export interface CampaignServiceDeps {
  store: CampaignStore;
  approvals: ApprovalPort;
  transport?: SendTransport;
  /** Consent check. Not set: the checkConsent from comms/consent.ts is used. */
  consent?: ConsentChecker;
  /**
   * Quiet-hours window for a job's send. Not set by default: campaign data has no such setting,
   * so quiet hours are not enforced unless a caller supplies this. The window is read in the
   * recipient contact's timezone; the `timezone` value returned here is ignored.
   */
  quietHours?: (companyId: string, job: SendJob) => { quietHours: QuietHours; timezone: string } | null;
  /**
   * Company suppression list (bounces, complaints, invalid addresses, unsubscribes). Not set by
   * default: when absent, dispatchJob skips the suppression check.
   */
  suppression?: SuppressionList;
  /**
   * Company settings store. When it holds quiet hours for the job's company, those win over
   * deps.quietHours. When absent, the shared process store (getDefaultCompanySettingsStore) is used.
   * When the company has no setting, deps.quietHours applies as before.
   */
  companySettings?: CompanySettingsStore;
  now?: () => Date;
  newId?: () => string;
  /** How long a send request stays open for a decision. Default 60 minutes. */
  approvalTtlMs?: number;
}

export interface AudienceResolution {
  eligible: Contact[];
  excluded: Array<{ contact: Contact; reason: SkipReason }>;
  /** Number of opt-in records on this channel. Zero means refuse. */
  optInCount: number;
}

export type ReleaseState = 'awaiting_approval' | 'released' | 'rejected' | 'expired' | 'nothing_to_release';

export interface SendRequestResult {
  approvalId: string;
  state: ReleaseState;
  queued: number;
  skipped: number;
}

/** Options for dispatchJob. Both are optional; the defaults keep the original behaviour. */
export interface DispatchOptions {
  /**
   * Awaited right before the transport is called. If it throws, the transport is not called and
   * the job stays 'sending'. The send queue uses this to count attempts before any send.
   */
  onTransportAttempt?: (job: SendJob) => Promise<void> | void;
  /** On a transport error: 'requeue' returns the job to 'queued'; 'fail' (default) marks it 'failed'. */
  onTransportError?: 'fail' | 'requeue';
}

export interface CampaignService {
  defineAudience(companyId: string, input: { name: string; channel: unknown; tagsAll: unknown }): Promise<Audience>;
  addContact(companyId: string, input: { channel: unknown; address: unknown; displayName?: string | null; tags?: unknown; timezone?: unknown }): Promise<Contact>;
  recordOptIn(companyId: string, input: { channel: unknown; address: unknown; source: unknown }): Promise<OptInRecord>;
  unsubscribe(companyId: string, input: { channel: unknown; address: unknown; reason?: string | null }): Promise<UnsubscribeEntry>;
  createCampaign(companyId: string, input: { name: string; channel: unknown; audienceId: string }): Promise<Campaign>;
  addStep(companyId: string, campaignId: string, input: { delayHours?: unknown; subject?: unknown; body: unknown }): Promise<CampaignStep>;
  activateCampaign(companyId: string, actor: Actor, campaignId: string): Promise<Campaign>;
  resolveAudience(companyId: string, audienceId: string): Promise<AudienceResolution>;
  requestSend(companyId: string, actor: Actor, campaignId: string, stepId: string): Promise<SendRequestResult>;
  releaseApproved(companyId: string, approvalId: string): Promise<{ state: ReleaseState; queued: number; skipped: number }>;
  dispatchJob(companyId: string, jobId: string, options?: DispatchOptions): Promise<SendJob>;
  listJobs(companyId: string, filter?: { campaignId?: string; stepId?: string; approvalId?: string }): Promise<SendJob[]>;
}

const LIVE_STATUSES: readonly SendJobStatus[] = ['awaiting_approval', 'queued', 'sending', 'sent'];

export function createCampaignService(deps: CampaignServiceDeps): CampaignService {
  const { store, approvals } = deps;
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => randomUUID());
  const ttlMs = deps.approvalTtlMs ?? 60 * 60 * 1000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('campaigns: approvalTtlMs must be positive');

  async function loadCampaign(companyId: string, id: string): Promise<Campaign> {
    const c = await store.findCampaign(companyId, id);
    if (!c) throw new CampaignError('Campaign not found', 'not_found');
    return c;
  }

  /** Why a single address may not receive a send right now, or null when it may. */
  async function consentBlock(companyId: string, channel: CampaignChannel, address: string): Promise<SkipReason | null> {
    if (await store.findUnsubscribe(companyId, channel, address)) return 'unsubscribed';
    if (!(await store.hasActiveOptIn(companyId, channel, address))) return 'no_opt_in';
    return null;
  }

  // Without deps.companySettings, the shared process store applies, so quiet hours are enforced by default.
  const companySettings = deps.companySettings ?? getDefaultCompanySettingsStore();

  /**
   * Quiet-hours window for a job: the company setting when one exists, else deps.quietHours.
   * The window is not tied to a timezone here. checkConsent reads it in the recipient's timezone.
   */
  async function quietWindow(companyId: string, job: SendJob): Promise<QuietHours | null> {
    const stored = await companySettings.getQuietHours(companyId);
    if (stored && stored.ok && stored.settings) {
      const { startHour, endHour } = stored.settings;
      return { startHour, endHour };
    }
    return deps.quietHours?.(companyId, job)?.quietHours ?? null;
  }

  /** True when the suppression list blocks this job's address. Always false when no list is wired. */
  function suppressed(companyId: string, job: SendJob): boolean {
    if (!deps.suppression) return false;
    return deps.suppression.isSuppressed(companyId, { channel: job.channel, address: job.address });
  }

  /**
   * checkConsent for one job, read from the store's own consent records (active opt-ins and
   * the unsubscribe entry for the address). Opt-ins go in with source 'system', so no later
   * opt-in reinstates an unsubscribed address: unsubscribe always wins. Quiet hours come from
   * the company setting or deps.quietHours, and are read in the recipient contact's timezone.
   * A recipient with no valid timezone under a window is refused (fail closed).
   */
  async function sendConsentDecision(companyId: string, job: SendJob): Promise<ConsentDecision> {
    const optIns = (await store.listOptIns(companyId, job.channel))
      .filter((o) => o.address === job.address && o.revokedAt === null);
    const unsub = await store.findUnsubscribe(companyId, job.channel, job.address);
    const consents: ConsentEvent[] = [
      ...optIns.map((o): ConsentEvent => ({ channel: job.channel, action: 'opt_in', at: o.grantedAt, source: 'system' })),
      ...(unsub ? [{ channel: job.channel, action: 'opt_out', at: unsub.createdAt, source: 'system' } as ConsentEvent] : []),
    ];
    // The recipient's own timezone, from the stored campaign contact. Absent means null.
    const recipient = (await store.findContactByAddress(companyId, job.channel, job.address)) as StoredContact | null;
    const contact: ConsentContact = {
      handles: job.channel === 'email' ? { email: job.address } : { phone: job.address },
      consents,
      timezone: recipient?.timezone ?? null,
    };
    const decide = deps.consent ?? checkConsent;
    return decide({
      channel: job.channel,
      contact,
      now: now(),
      quietHours: await quietWindow(companyId, job),
    });
  }

  const service: CampaignService = {
    async defineAudience(rawCompanyId, input) {
      const companyId = requireCompanyId(rawCompanyId);
      const audience: Audience = {
        companyId,
        id: newId(),
        name: assertText(input.name, 'name', 120),
        channel: assertChannel(input.channel),
        tagsAll: assertTags(input.tagsAll, true),
        createdAt: now(),
      };
      await store.insertAudience(audience);
      return audience;
    },

    async addContact(rawCompanyId, input) {
      const companyId = requireCompanyId(rawCompanyId);
      const channel = assertChannel(input.channel);
      const address = normaliseAddress(channel, input.address);
      const existing = await store.findContactByAddress(companyId, channel, address);
      if (existing) return existing;
      // Optional IANA timezone of the recipient. Quiet hours are read in it. Null when not given.
      let timezone: string | null = null;
      if (input.timezone !== undefined && input.timezone !== null) {
        if (!isValidTimezone(input.timezone)) throw new CampaignError('timezone must be a valid IANA timezone', 'invalid');
        timezone = input.timezone;
      }
      const contact: StoredContact = {
        companyId,
        id: newId(),
        channel,
        address,
        displayName: input.displayName ?? null,
        tags: assertTags(input.tags, false),
        createdAt: now(),
        timezone,
      };
      await store.insertContact(contact);
      return contact;
    },

    async recordOptIn(rawCompanyId, input) {
      const companyId = requireCompanyId(rawCompanyId);
      const channel = assertChannel(input.channel);
      const record: OptInRecord = {
        companyId,
        id: newId(),
        channel,
        address: normaliseAddress(channel, input.address),
        source: assertText(input.source, 'source', 200),
        grantedAt: now(),
        revokedAt: null,
      };
      await store.insertOptIn(record);
      return record;
    },

    async unsubscribe(rawCompanyId, input) {
      const companyId = requireCompanyId(rawCompanyId);
      const channel = assertChannel(input.channel);
      const entry: UnsubscribeEntry = {
        companyId,
        channel,
        address: normaliseAddress(channel, input.address),
        reason: input.reason ?? null,
        createdAt: now(),
      };
      await store.upsertUnsubscribe(entry);
      return entry;
    },

    async createCampaign(rawCompanyId, input) {
      const companyId = requireCompanyId(rawCompanyId);
      const channel = assertChannel(input.channel);
      const audience = await store.findAudience(companyId, input.audienceId);
      if (!audience) throw new CampaignError('Audience not found', 'not_found');
      if (audience.channel !== channel) throw new CampaignError('Audience channel does not match the campaign channel', 'invalid');
      const at = now();
      const campaign: Campaign = {
        companyId,
        id: newId(),
        name: assertText(input.name, 'name', 120),
        channel,
        audienceId: audience.id,
        status: 'draft',
        createdAt: at,
        updatedAt: at,
      };
      await store.insertCampaign(campaign);
      return campaign;
    },

    async addStep(rawCompanyId, campaignId, input) {
      const companyId = requireCompanyId(rawCompanyId);
      const campaign = await loadCampaign(companyId, campaignId);
      if (campaign.status !== 'draft' && campaign.status !== 'paused') {
        throw new CampaignError('Steps can only be added to a draft or paused campaign', 'conflict');
      }
      const delay = input.delayHours ?? 0;
      if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0 || delay > 8760) {
        throw new CampaignError('delayHours must be an integer from 0 to 8760', 'invalid');
      }
      const body = assertText(input.body, 'body', MAX_BODY_LENGTH);
      let subject: string | null = null;
      if (campaign.channel === 'email') {
        subject = assertText(input.subject, 'subject', MAX_SUBJECT_LENGTH);
      } else if (input.subject !== undefined && input.subject !== null) {
        throw new CampaignError('sms steps take no subject', 'invalid');
      }
      const existing = await store.listSteps(companyId, campaign.id);
      const step: CampaignStep = {
        companyId,
        id: newId(),
        campaignId: campaign.id,
        position: existing.length + 1,
        delayHours: delay,
        subject,
        body,
        createdAt: now(),
      };
      await store.insertStep(step);
      return step;
    },

    async activateCampaign(rawCompanyId, actor, campaignId) {
      const companyId = requireCompanyId(rawCompanyId);
      if (actor.kind !== 'human') throw new CampaignError('Only a human may activate a campaign', 'forbidden');
      const campaign = await loadCampaign(companyId, campaignId);
      if (campaign.status !== 'draft' && campaign.status !== 'paused') {
        throw new CampaignError(`Campaign is ${campaign.status}`, 'conflict');
      }
      if ((await store.listSteps(companyId, campaign.id)).length === 0) {
        throw new CampaignError('Add at least one step before activating', 'conflict');
      }
      return (await store.updateCampaign(companyId, campaign.id, { status: 'active', updatedAt: now() })) ?? campaign;
    },

    async resolveAudience(rawCompanyId, audienceId) {
      const companyId = requireCompanyId(rawCompanyId);
      const audience = await store.findAudience(companyId, audienceId);
      if (!audience) throw new CampaignError('Audience not found', 'not_found');

      const contacts = (await store.listContacts(companyId, audience.channel)).filter((c) =>
        audience.tagsAll.every((t) => c.tags.includes(t)),
      );
      const optIns = await store.listOptIns(companyId, audience.channel);
      const activeOptIns = new Set(optIns.filter((o) => o.revokedAt === null).map((o) => o.address));
      const unsubscribed = new Set((await store.listUnsubscribes(companyId, audience.channel)).map((u) => u.address));

      const eligible: Contact[] = [];
      const excluded: AudienceResolution['excluded'] = [];
      for (const contact of contacts) {
        if (unsubscribed.has(contact.address)) excluded.push({ contact, reason: 'unsubscribed' });
        else if (!activeOptIns.has(contact.address)) excluded.push({ contact, reason: 'no_opt_in' });
        else eligible.push(contact);
      }
      return { eligible, excluded, optInCount: optIns.length };
    },

    async requestSend(rawCompanyId, actor, campaignId, stepId) {
      const companyId = requireCompanyId(rawCompanyId);
      const campaign = await loadCampaign(companyId, campaignId);
      if (campaign.status !== 'active') throw new CampaignError(`Campaign is ${campaign.status}, not active`, 'conflict');
      const step = await store.findStep(companyId, stepId);
      if (!step || step.campaignId !== campaign.id) throw new CampaignError('Step not found', 'not_found');

      const prior = await store.listJobs(companyId, { campaignId: campaign.id, stepId: step.id });
      if (prior.some((j) => LIVE_STATUSES.includes(j.status))) {
        throw new CampaignError('This step already has a send in progress or completed', 'conflict');
      }

      const resolution = await service.resolveAudience(companyId, campaign.audienceId);
      if (resolution.optInCount === 0) {
        throw new CampaignError('Audience has no opt-in records, so nothing can be sent', 'refused');
      }
      if (resolution.eligible.length === 0) {
        throw new CampaignError('No audience member is opted in and subscribed', 'refused');
      }

      // Agent-proposed launch: bulk_campaign is high risk. The authority ladder decides first. A tier
      // that cannot write (assist, suggest) or a missing tier is refused before any approval is opened.
      // At auto and predictive the ladder answers require_approval, and the gate below holds the send.
      // Staff launches skip this and keep the normal role guards at the route.
      if (actor.kind === 'agent') {
        const ladder = gateCommsAction({
          companyId,
          action: 'bulk_campaign',
          autonomy: (actor as AgentActor).autonomy,
          humanApproved: false,
          actorIsHuman: false,
        });
        if (ladder.decision === 'deny') {
          throw new CampaignError('This agent may not propose a bulk send at its autonomy tier', 'forbidden');
        }
      }

      const gate = await approvals.gateAction({
        companyId,
        requestedBy: actor.kind === 'human' ? actor.id : null,
        agentId: actor.kind === 'agent' ? actor.id : null,
        action: SEND_ACTION,
        params: {
          campaignId: campaign.id,
          stepId: step.id,
          audienceId: campaign.audienceId,
          channel: campaign.channel,
          recipientCount: resolution.eligible.length,
          recipientsSha256: recipientsHash(resolution.eligible),
          bodySha256: contentHash(step),
        },
        context: { stepPosition: step.position, excludedCount: resolution.excluded.length },
        urgency: 'normal',
        ttlMs,
      });

      // A company policy can decide an approval on its own (auto_approve or auto_deny). That is not a
      // human approval, so an agent-proposed launch is refused unless the approval is still pending
      // for a person. Nothing is queued in that case.
      if (actor.kind === 'agent' && gate.status !== 'pending') {
        throw new CampaignError('Agent-proposed bulk send needs a human approval', 'forbidden');
      }

      const at = now();
      const base = { companyId, campaignId: campaign.id, stepId: step.id, channel: campaign.channel, approvalId: gate.approval.id, externalId: null, createdAt: at, updatedAt: at };
      const jobs: SendJob[] = [
        ...resolution.eligible.map((c): SendJob => ({
          ...base,
          id: newId(),
          contactId: c.id,
          address: c.address,
          status: 'awaiting_approval',
          skipReason: null,
          inApprovedSet: true,
        })),
        ...resolution.excluded.map((e): SendJob => ({
          ...base,
          id: newId(),
          contactId: e.contact.id,
          address: e.contact.address,
          status: 'skipped',
          skipReason: e.reason,
          inApprovedSet: false,
        })),
      ];
      await store.insertJobs(jobs);

      const release = await service.releaseApproved(companyId, gate.approval.id);
      return { approvalId: gate.approval.id, ...release };
    },

    async releaseApproved(rawCompanyId, approvalId) {
      const companyId = requireCompanyId(rawCompanyId);
      const approval = await approvals.getApproval(companyId, approvalId);
      if (!approval) throw new CampaignError('Approval not found', 'not_found');
      const jobs = await store.listJobs(companyId, { approvalId });
      if (jobs.length === 0) throw new CampaignError('No send jobs for this approval', 'not_found');
      const awaiting = jobs.filter((j) => j.status === 'awaiting_approval');

      if (approval.status === 'pending') return { state: 'awaiting_approval', queued: 0, skipped: 0 };
      if (awaiting.length === 0) return { state: 'nothing_to_release', queued: 0, skipped: 0 };

      if (approval.status === 'rejected' || approval.status === 'expired') {
        const skipReason: SkipReason = approval.status === 'rejected' ? 'approval_rejected' : 'approval_expired';
        for (const job of awaiting) {
          await store.transitionJob(companyId, job.id, 'awaiting_approval', { status: 'skipped', skipReason, updatedAt: now() });
        }
        return { state: approval.status === 'rejected' ? 'rejected' : 'expired', queued: 0, skipped: awaiting.length };
      }

      // Approved: the approval must cover this exact step, content and recipient list.
      const { campaignId, stepId } = jobs[0];
      const p = approval.params;
      if (approval.action !== SEND_ACTION || p.campaignId !== campaignId || p.stepId !== stepId) {
        throw new CampaignError('Approval does not match this step', 'conflict');
      }
      const step = await store.findStep(companyId, stepId);
      if (!step) throw new CampaignError('Step not found', 'not_found');
      if (p.bodySha256 !== contentHash(step)) throw new CampaignError('Step content changed after approval', 'conflict');
      const approvedSet = jobs.filter((j) => j.inApprovedSet);
      if (p.recipientsSha256 !== recipientsHash(approvedSet) || p.recipientCount !== approvedSet.length) {
        throw new CampaignError('Recipient list changed after approval', 'conflict');
      }

      let queued = 0;
      let skipped = 0;
      for (const job of awaiting) {
        const block = await consentBlock(companyId, job.channel, job.address);
        if (block) {
          await store.transitionJob(companyId, job.id, 'awaiting_approval', { status: 'skipped', skipReason: block, updatedAt: now() });
          skipped += 1;
          continue;
        }
        const moved = await store.transitionJob(companyId, job.id, 'awaiting_approval', { status: 'queued', updatedAt: now() });
        if (moved) queued += 1;
      }
      if (queued > 0) await approvals.markExecuted(companyId, approvalId, null);
      return { state: 'released', queued, skipped };
    },

    async dispatchJob(rawCompanyId, jobId, options = {}) {
      const companyId = requireCompanyId(rawCompanyId);
      if (!deps.transport) throw new CampaignError('No send transport is configured', 'conflict');
      const job = await store.findJob(companyId, jobId);
      if (!job) throw new CampaignError('Send job not found', 'not_found');
      if (job.status !== 'queued') throw new CampaignError(`Send job is ${job.status}, not queued`, 'conflict');

      // The single choke point. Refuse anything that is not covered by an approved send for its step.
      if (!job.approvalId) throw new CampaignError('Send job has no approval', 'forbidden');
      const approval = await approvals.getApproval(companyId, job.approvalId);
      const covered =
        approval !== null &&
        approval.status === 'approved' &&
        approval.action === SEND_ACTION &&
        approval.params.campaignId === job.campaignId &&
        approval.params.stepId === job.stepId;
      if (!covered) throw new CampaignError('Send job is not covered by an approved send', 'forbidden');

      const block = await consentBlock(companyId, job.channel, job.address);
      if (block) {
        return (await store.transitionJob(companyId, job.id, 'queued', { status: 'skipped', skipReason: block, updatedAt: now() })) ?? job;
      }
      if (suppressed(companyId, job)) {
        return (await store.transitionJob(companyId, job.id, 'queued', { status: 'skipped', skipReason: 'suppressed', updatedAt: now() })) ?? job;
      }

      const claimed = await store.transitionJob(companyId, job.id, 'queued', { status: 'sending', updatedAt: now() });
      if (!claimed) throw new CampaignError('Send job was claimed by another worker', 'conflict');
      const step = await store.findStep(companyId, job.stepId);
      if (!step) throw new CampaignError('Step not found', 'not_found');

      // Immediately before the transport: consent is read again, so an opt-out that lands after
      // the first check is still caught. A refusal never reaches the transport.
      if (suppressed(companyId, claimed)) {
        return (await store.transitionJob(companyId, job.id, 'sending', { status: 'skipped', skipReason: 'suppressed', updatedAt: now() })) ?? claimed;
      }
      const decision = await sendConsentDecision(companyId, claimed);
      if (decision.allowed === false) {
        // Quiet hours are temporary: the job goes back to 'queued' (the status dispatchJob
        // accepts) so a later dispatch can send it. Every other refusal is permanent.
        if (decision.reason === 'quiet_hours') {
          return (await store.transitionJob(companyId, job.id, 'sending', { status: 'queued', updatedAt: now() })) ?? claimed;
        }
        return (await store.transitionJob(companyId, job.id, 'sending', { status: 'skipped', skipReason: decision.reason, updatedAt: now() })) ?? claimed;
      }

      // Every https link in the message gets campaign tracking before the provider adapter sees it.
      // A link that fails the check stops this message: it is marked failed, never sent, never retried.
      const linkContext = { companyId, campaignId: claimed.campaignId, channel: claimed.channel };
      const linkedBody = rewriteCampaignLinks({ text: step.body, baseContext: linkContext });
      const linkedSubject = step.subject === null
        ? { ok: true as const, text: null }
        : rewriteCampaignLinks({ text: step.subject, baseContext: linkContext });
      if (!linkedBody.ok || !linkedSubject.ok) {
        return (await store.transitionJob(companyId, job.id, 'sending', { status: 'failed', updatedAt: now() })) ?? claimed;
      }

      // Outside the try: if the attempt cannot be recorded, the transport is never called.
      if (options.onTransportAttempt) await options.onTransportAttempt(claimed);

      let result: { externalId: string };
      try {
        result = await deps.transport.send(companyId, claimed, { subject: linkedSubject.text, body: linkedBody.text });
      } catch {
        // Only a transport error reaches this branch. A failed 'sent' write below must never requeue
        // a message the provider has already accepted.
        const to: SendJobStatus = options.onTransportError === 'requeue' ? 'queued' : 'failed';
        return (await store.transitionJob(companyId, job.id, 'sending', { status: to, updatedAt: now() })) ?? claimed;
      }
      return (await store.transitionJob(companyId, job.id, 'sending', { status: 'sent', externalId: result.externalId, updatedAt: now() })) ?? claimed;
    },

    async listJobs(rawCompanyId, filter = {}) {
      return store.listJobs(requireCompanyId(rawCompanyId), filter);
    },
  };

  return service;
}
