/*
 * Ports for campaigns. Every method takes companyId and scopes to it. Status changes go
 * through transitionJob, which only applies when the row still has the expected status
 * (compare-and-set). The Drizzle version must do the same with WHERE status = from.
 */
import type {
  Audience,
  Campaign,
  CampaignChannel,
  CampaignStatus,
  CampaignStep,
  Contact,
  OptInRecord,
  SendJob,
  SendJobStatus,
  SkipReason,
  UnsubscribeEntry,
} from './types.ts';

export interface CampaignStore {
  insertContact(contact: Contact): Promise<void>;
  findContactByAddress(companyId: string, channel: CampaignChannel, address: string): Promise<Contact | null>;
  listContacts(companyId: string, channel: CampaignChannel): Promise<Contact[]>;

  insertAudience(audience: Audience): Promise<void>;
  findAudience(companyId: string, id: string): Promise<Audience | null>;

  insertCampaign(campaign: Campaign): Promise<void>;
  findCampaign(companyId: string, id: string): Promise<Campaign | null>;
  updateCampaign(companyId: string, id: string, patch: Partial<{ status: CampaignStatus; updatedAt: Date }>): Promise<Campaign | null>;

  insertStep(step: CampaignStep): Promise<void>;
  findStep(companyId: string, id: string): Promise<CampaignStep | null>;
  listSteps(companyId: string, campaignId: string): Promise<CampaignStep[]>;

  insertOptIn(record: OptInRecord): Promise<void>;
  listOptIns(companyId: string, channel: CampaignChannel): Promise<OptInRecord[]>;

  upsertUnsubscribe(entry: UnsubscribeEntry): Promise<void>;
  findUnsubscribe(companyId: string, channel: CampaignChannel, address: string): Promise<UnsubscribeEntry | null>;
  listUnsubscribes(companyId: string, channel: CampaignChannel): Promise<UnsubscribeEntry[]>;
  /** True when at least one opt-in for this address is still active (revokedAt is null). */
  hasActiveOptIn(companyId: string, channel: CampaignChannel, address: string): Promise<boolean>;

  insertJobs(jobs: SendJob[]): Promise<void>;
  findJob(companyId: string, id: string): Promise<SendJob | null>;
  listJobs(companyId: string, filter: { campaignId?: string; stepId?: string; approvalId?: string }): Promise<SendJob[]>;
  /** Applies the patch only if the job's current status is `from`. Returns null otherwise. */
  transitionJob(
    companyId: string,
    id: string,
    from: SendJobStatus,
    patch: Partial<{ status: SendJobStatus; skipReason: SkipReason | null; externalId: string | null; updatedAt: Date }>,
  ): Promise<SendJob | null>;
}

/** The only place a message leaves the module. Tests inject a fake that records calls. */
export interface SendTransport {
  send(companyId: string, job: SendJob, content: { subject: string | null; body: string }): Promise<{ externalId: string }>;
}

/*
 * Structural subset of the approvals module (server/modules/approvals/approval-service.ts).
 * ApprovalService satisfies this shape. No approvals runtime code is imported.
 */
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalGateRequest {
  companyId: string;
  requestedBy: string | null;
  agentId: string | null;
  action: string;
  params: Record<string, unknown>;
  context: Record<string, unknown>;
  urgency: 'low' | 'normal' | 'high' | 'critical';
  ttlMs: number;
}

export interface ApprovalGateResult {
  status: ApprovalState;
  approval: { id: string };
  decision: string;
  policyId: string | null;
}

export interface ApprovalRecord {
  id: string;
  action: string;
  params: Record<string, unknown>;
  status: ApprovalState;
}

export interface ApprovalPort {
  gateAction(request: ApprovalGateRequest): Promise<ApprovalGateResult>;
  getApproval(companyId: string, id: string): Promise<ApprovalRecord | null>;
  /** Returns null when the approval is missing or already executed. */
  markExecuted(companyId: string, id: string, actorId: string | null): Promise<ApprovalRecord | null>;
}
