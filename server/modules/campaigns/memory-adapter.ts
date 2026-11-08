/*
 * In-memory adapters for tests and local runs. Every record carries companyId and every
 * read filters on it first. Nothing here touches a database, a provider or a network.
 */
import type {
  ApprovalGateRequest,
  ApprovalGateResult,
  ApprovalPort,
  ApprovalRecord,
  ApprovalState,
  CampaignStore,
  SendTransport,
} from './ports.ts';
import type {
  Audience,
  Campaign,
  CampaignChannel,
  CampaignStep,
  Contact,
  OptInRecord,
  SendJob,
  SendJobStatus,
  SkipReason,
  UnsubscribeEntry,
} from './types.ts';

function requireCo(companyId: string): string {
  if (typeof companyId !== 'string' || companyId.trim() === '') throw new TypeError('campaigns: companyId is required');
  return companyId;
}

const clone = <T>(value: T): T => ({ ...value });

export class InMemoryCampaignStore implements CampaignStore {
  private readonly contacts: Contact[] = [];
  private readonly audiences: Audience[] = [];
  private readonly campaigns: Campaign[] = [];
  private readonly steps: CampaignStep[] = [];
  private readonly optIns: OptInRecord[] = [];
  private readonly unsubs: UnsubscribeEntry[] = [];
  private readonly jobs: SendJob[] = [];

  async insertContact(contact: Contact): Promise<void> {
    requireCo(contact.companyId);
    this.contacts.push(clone(contact));
  }

  async findContactByAddress(companyId: string, channel: CampaignChannel, address: string): Promise<Contact | null> {
    const found = this.contacts.find((c) => c.companyId === requireCo(companyId) && c.channel === channel && c.address === address);
    return found ? clone(found) : null;
  }

  async listContacts(companyId: string, channel: CampaignChannel): Promise<Contact[]> {
    return this.contacts.filter((c) => c.companyId === requireCo(companyId) && c.channel === channel).map(clone);
  }

  async insertAudience(audience: Audience): Promise<void> {
    requireCo(audience.companyId);
    this.audiences.push(clone(audience));
  }

  async findAudience(companyId: string, id: string): Promise<Audience | null> {
    const found = this.audiences.find((a) => a.companyId === requireCo(companyId) && a.id === id);
    return found ? clone(found) : null;
  }

  async insertCampaign(campaign: Campaign): Promise<void> {
    requireCo(campaign.companyId);
    this.campaigns.push(clone(campaign));
  }

  async findCampaign(companyId: string, id: string): Promise<Campaign | null> {
    const found = this.campaigns.find((c) => c.companyId === requireCo(companyId) && c.id === id);
    return found ? clone(found) : null;
  }

  async updateCampaign(companyId: string, id: string, patch: Partial<{ status: Campaign['status']; updatedAt: Date }>): Promise<Campaign | null> {
    const row = this.campaigns.find((c) => c.companyId === requireCo(companyId) && c.id === id);
    if (!row) return null;
    Object.assign(row, patch);
    return clone(row);
  }

  async insertStep(step: CampaignStep): Promise<void> {
    requireCo(step.companyId);
    this.steps.push(clone(step));
  }

  async findStep(companyId: string, id: string): Promise<CampaignStep | null> {
    const found = this.steps.find((s) => s.companyId === requireCo(companyId) && s.id === id);
    return found ? clone(found) : null;
  }

  async listSteps(companyId: string, campaignId: string): Promise<CampaignStep[]> {
    return this.steps
      .filter((s) => s.companyId === requireCo(companyId) && s.campaignId === campaignId)
      .sort((a, b) => a.position - b.position)
      .map(clone);
  }

  async insertOptIn(record: OptInRecord): Promise<void> {
    requireCo(record.companyId);
    this.optIns.push(clone(record));
  }

  async listOptIns(companyId: string, channel: CampaignChannel): Promise<OptInRecord[]> {
    return this.optIns.filter((o) => o.companyId === requireCo(companyId) && o.channel === channel).map(clone);
  }

  async hasActiveOptIn(companyId: string, channel: CampaignChannel, address: string): Promise<boolean> {
    return this.optIns.some(
      (o) => o.companyId === requireCo(companyId) && o.channel === channel && o.address === address && o.revokedAt === null,
    );
  }

  async upsertUnsubscribe(entry: UnsubscribeEntry): Promise<void> {
    requireCo(entry.companyId);
    const i = this.unsubs.findIndex((u) => u.companyId === entry.companyId && u.channel === entry.channel && u.address === entry.address);
    if (i >= 0) this.unsubs[i] = clone(entry);
    else this.unsubs.push(clone(entry));
  }

  async findUnsubscribe(companyId: string, channel: CampaignChannel, address: string): Promise<UnsubscribeEntry | null> {
    const found = this.unsubs.find((u) => u.companyId === requireCo(companyId) && u.channel === channel && u.address === address);
    return found ? clone(found) : null;
  }

  async listUnsubscribes(companyId: string, channel: CampaignChannel): Promise<UnsubscribeEntry[]> {
    return this.unsubs.filter((u) => u.companyId === requireCo(companyId) && u.channel === channel).map(clone);
  }

  async insertJobs(jobs: SendJob[]): Promise<void> {
    for (const job of jobs) this.jobs.push(clone({ ...job, companyId: requireCo(job.companyId) }));
  }

  async findJob(companyId: string, id: string): Promise<SendJob | null> {
    const found = this.jobs.find((j) => j.companyId === requireCo(companyId) && j.id === id);
    return found ? clone(found) : null;
  }

  async listJobs(companyId: string, filter: { campaignId?: string; stepId?: string; approvalId?: string }): Promise<SendJob[]> {
    return this.jobs
      .filter((j) => j.companyId === requireCo(companyId))
      .filter((j) => (filter.campaignId ? j.campaignId === filter.campaignId : true))
      .filter((j) => (filter.stepId ? j.stepId === filter.stepId : true))
      .filter((j) => (filter.approvalId ? j.approvalId === filter.approvalId : true))
      .map(clone);
  }

  async transitionJob(
    companyId: string,
    id: string,
    from: SendJobStatus,
    patch: Partial<{ status: SendJobStatus; skipReason: SkipReason | null; externalId: string | null; updatedAt: Date }>,
  ): Promise<SendJob | null> {
    const row = this.jobs.find((j) => j.companyId === requireCo(companyId) && j.id === id);
    if (!row || row.status !== from) return null; // compare-and-set: only the expected status moves
    Object.assign(row, patch);
    return clone(row);
  }
}

/** Records every call and returns a fake provider id. Never sends anything. */
export class RecordingSendTransport implements SendTransport {
  readonly calls: Array<{ companyId: string; jobId: string; address: string; body: string }> = [];
  /** Set to true to make the next send throw, to test the failed path. */
  failNext = false;
  private seq = 0;

  async send(companyId: string, job: SendJob, content: { subject: string | null; body: string }) {
    this.calls.push({ companyId, jobId: job.id, address: job.address, body: content.body });
    if (this.failNext) {
      this.failNext = false;
      throw new Error('provider unavailable');
    }
    this.seq += 1;
    return { externalId: `fake_${this.seq}` };
  }
}

/** Fake approvals port. New requests start in `nextState`, and decide() moves a pending one. */
export class InMemoryApprovalPort implements ApprovalPort {
  readonly requests: ApprovalGateRequest[] = [];
  nextState: ApprovalState = 'pending';
  private readonly rows = new Map<string, ApprovalRecord & { companyId: string; executed: boolean }>();
  private seq = 0;

  async gateAction(request: ApprovalGateRequest): Promise<ApprovalGateResult> {
    this.requests.push(request);
    this.seq += 1;
    const id = `appr_${this.seq}`;
    const status = this.nextState;
    this.rows.set(id, { id, companyId: request.companyId, action: request.action, params: request.params, status, executed: false });
    return {
      status,
      approval: { id },
      decision: status === 'approved' ? 'auto_approve' : status === 'rejected' ? 'auto_deny' : 'route_to_human',
      policyId: null,
    };
  }

  async getApproval(companyId: string, id: string): Promise<ApprovalRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.companyId !== companyId) return null;
    return { id: row.id, action: row.action, params: row.params, status: row.status };
  }

  async markExecuted(companyId: string, id: string): Promise<ApprovalRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.companyId !== companyId || row.status !== 'approved' || row.executed) return null;
    row.executed = true;
    return { id: row.id, action: row.action, params: row.params, status: row.status };
  }

  decide(id: string, status: Extract<ApprovalState, 'approved' | 'rejected' | 'expired'>): void {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no approval ${id}`);
    row.status = status;
  }

  isExecuted(id: string): boolean {
    return this.rows.get(id)?.executed ?? false;
  }
}
