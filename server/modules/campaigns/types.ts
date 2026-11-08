/*
 * Campaign types: campaign, audience (a company-scoped segment), step, send job, and the
 * consent records (opt-in and unsubscribe) that gate every send. Every entity carries
 * company_id. Types and constants only.
 */

export const CAMPAIGN_CHANNELS = ['email', 'sms'] as const;
export type CampaignChannel = (typeof CAMPAIGN_CHANNELS)[number];

export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'completed', 'cancelled'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** A person who can receive campaign messages. address is the email or E.164 number. */
export interface Contact {
  companyId: string;
  id: string;
  channel: CampaignChannel;
  address: string;
  displayName: string | null;
  tags: string[];
  createdAt: Date;
}

/** Segment: every contact on `channel` that carries all of `tagsAll`. */
export interface Audience {
  companyId: string;
  id: string;
  name: string;
  channel: CampaignChannel;
  tagsAll: string[];
  createdAt: Date;
}

/** Consent for one address on one channel. Active while revokedAt is null. */
export interface OptInRecord {
  companyId: string;
  id: string;
  channel: CampaignChannel;
  address: string;
  source: string;
  grantedAt: Date;
  revokedAt: Date | null;
}

export interface UnsubscribeEntry {
  companyId: string;
  channel: CampaignChannel;
  address: string;
  reason: string | null;
  createdAt: Date;
}

export interface Campaign {
  companyId: string;
  id: string;
  name: string;
  channel: CampaignChannel;
  audienceId: string;
  status: CampaignStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignStep {
  companyId: string;
  id: string;
  campaignId: string;
  position: number;
  delayHours: number;
  subject: string | null;
  body: string;
  createdAt: Date;
}

/**
 * awaiting_approval: created, waiting for the gate. queued: approved and rechecked, ready
 * for the transport. sending: claimed by the transport. sent / failed: transport result.
 * skipped: not sent, with skipReason.
 */
export type SendJobStatus = 'awaiting_approval' | 'queued' | 'sending' | 'sent' | 'skipped' | 'failed';

/**
 * Why a job was not sent. The consent values mirror ConsentReason in comms/consent.ts, so a
 * consent refusal is stored without a cast.
 */
export type SkipReason =
  | 'unsubscribed'
  | 'no_opt_in'
  | 'approval_rejected'
  | 'approval_expired'
  | 'no_consent'
  | 'channel_not_consented'
  | 'opted_out'
  | 'quiet_hours'
  | 'invalid_contact'
  | 'suppressed';

export interface SendJob {
  companyId: string;
  id: string;
  campaignId: string;
  stepId: string;
  contactId: string;
  channel: CampaignChannel;
  address: string;
  status: SendJobStatus;
  skipReason: SkipReason | null;
  /** True for recipients in the batch that the approval covers. Fixed at request time. */
  inApprovedSet: boolean;
  approvalId: string | null;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Verified caller. Comes from the session or agent runtime, never from request input. */
export interface Actor {
  kind: 'human' | 'agent';
  id: string;
}

/** Approval action for one campaign step batch. */
export const SEND_ACTION = 'campaigns.send_step';

export const MAX_BODY_LENGTH = 20000;
export const MAX_SUBJECT_LENGTH = 300;
export const MAX_TAGS = 50;
