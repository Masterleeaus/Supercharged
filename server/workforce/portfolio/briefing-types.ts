/**
 * Input and output types for the Director's Daily Briefing (portfolio/briefing.ts).
 * Plain data only. The briefing generator receives these records from its caller and never reads a database.
 */

export const HEALTH_STATUSES = ['healthy', 'degraded', 'unavailable', 'unknown'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export const BRIEFING_SECTION_KEYS = [
  'portfolio_health',
  'critical_exceptions',
  'approvals',
  'customer_support',
  'customer_success',
  'improvement_opportunities',
  'workforce_performance',
  'commercial_health',
] as const;
export type BriefingSectionKey = (typeof BRIEFING_SECTION_KEYS)[number];

/** populated: records were supplied. empty: the input array was supplied with no rows. not_available: no input array was supplied. */
export type BriefingSectionState = 'populated' | 'empty' | 'not_available';

export interface HealthRecord {
  id: string;
  /** Any value other than the four HEALTH_STATUSES is treated as 'unknown'. */
  status: string;
  reason?: string | null;
  checkedAt?: string | Date | null;
}

export interface CaseRecord {
  id: string;
  title: string;
  /** Free text from the case service. */
  severity: string;
  /** Free text. 'resolved' and 'closed' are treated as finished; anything else is active. */
  state: string;
  /** e.g. 'outage', 'security', 'data_integrity'. */
  category?: string | null;
}

export interface DecisionRecord {
  id: string;
  /** 'awaiting_approval' is the only status listed under Approvals. */
  status: string;
  priority: string;
  issue: string;
  approvalAuthority?: string | null;
}

export interface ExecutionReceipt {
  id: string;
  runId: string;
  /** 'succeeded' counts as completed only when verified is true. */
  outcome: string;
  verified: boolean;
  reason?: string | null;
}

export interface WorkforceRunRecord {
  id: string;
  /** 'completed', 'failed', 'retried', 'escalated' are counted. Other values are not shown under counts. */
  status: string;
  reason?: string | null;
}

export interface SupportRequest {
  id: string;
  title: string;
  /** 'resolved' and 'closed' are finished. Anything else is unresolved. */
  status: string;
  /** Due time. Null means no due time was set. */
  dueAt?: string | Date | null;
}

export interface SetupRecord {
  id: string;
  /** true = complete, false = incomplete, null = not known. */
  setupComplete: boolean | null;
  serviceConcern?: string | null;
}

export interface ImprovementRecord {
  id: string;
  title: string;
  /** e.g. 'pricing', 'rebooking', 'marketing', 'scheduling'. */
  category: string;
}

export interface CommercialFigure {
  id: string;
  label: string;
  /** Null means the figure is not available. */
  value: number | string | null;
  /** A risk note. Null or empty means no risk was reported. */
  risk?: string | null;
}

export interface BriefingInput {
  /** Injected clock. Used for overdue checks and the generatedAt stamp. */
  now: Date;
  health?: HealthRecord[];
  cases?: CaseRecord[];
  decisions?: DecisionRecord[];
  receipts?: ExecutionReceipt[];
  workforceRuns?: WorkforceRunRecord[];
  supportRequests?: SupportRequest[];
  setups?: SetupRecord[];
  improvements?: ImprovementRecord[];
  commercialFigures?: CommercialFigure[];
}

export interface BriefingItem {
  /** Id of the source record, for drill-down. */
  recordId: string;
  text: string;
  /** Set when the item needs attention: e.g. 'failed', 'overdue', 'unknown', 'risk', 'not_verified'. */
  flag?: string;
  /** Failure reason, due time or similar supporting detail. */
  detail?: string;
}

export interface BriefingSection {
  key: BriefingSectionKey;
  title: string;
  state: BriefingSectionState;
  /** Plain statement of what the section says, including explicit notes for empty or missing data. */
  summary: string;
  counts: Record<string, number>;
  items: BriefingItem[];
}

export interface DirectorBriefing {
  generatedAt: string;
  /** True when no input array held any record. The notice then says nothing is verified. */
  isEmpty: boolean;
  notice: string | null;
  sections: BriefingSection[];
}
