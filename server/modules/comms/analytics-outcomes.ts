// Channel-level and campaign-level outcome summaries for human teams and agents.
// Pure functions only: no database, no network, no clock reads. The caller supplies the records.
//
// Counts are kept separate from rates. A rate is a share of the recognised outcomes in its group
// and returns null when that group has no recognised outcomes (no divide by zero).

export const OUTCOME_STATUSES = ['sent', 'delivered', 'failed', 'suppressed', 'opted_out'] as const;
export type OutcomeStatus = (typeof OUTCOME_STATUSES)[number];

export type OutcomeRecord = {
  channel: string;
  campaignId: string | null;
  status: string;
  // Optional tenancy guard. When present it must match the company being summarised.
  companyId?: string;
};

export type OutcomeCounts = Record<OutcomeStatus, number>;

export type OutcomeRates = {
  deliveredRate: number | null;
  failedRate: number | null;
  suppressedRate: number | null;
  optedOutRate: number | null;
};

export type OutcomeGroupSummary = {
  // Recognised outcomes in this group. Unrecognised statuses are not included.
  total: number;
  counts: OutcomeCounts;
  // Records whose status is a string but not one of OUTCOME_STATUSES. Never guessed into a bucket.
  unrecognised: number;
  rates: OutcomeRates;
};

export type ChannelOutcomeSummary = OutcomeGroupSummary & { channel: string };
export type CampaignOutcomeSummary = OutcomeGroupSummary & { campaignId: string };

export type OutcomeSummaryRefusal = {
  ok: false;
  reason: 'invalid_company' | 'invalid_records';
};

export type ChannelOutcomeSummaryResult =
  | { ok: true; companyId: string; channels: ChannelOutcomeSummary[]; rejected: number }
  | OutcomeSummaryRefusal;

export type CampaignOutcomeSummaryResult =
  | {
      ok: true;
      companyId: string;
      campaigns: CampaignOutcomeSummary[];
      // Recognised or unrecognised records with no campaign. They appear only in the channel summary.
      unattributed: number;
      rejected: number;
    }
  | OutcomeSummaryRefusal;

export type OutcomeSummaryInput = {
  companyId: string;
  records: readonly unknown[];
};

type PreparedRow = {
  channel: string;
  campaignId: string | null;
  status: OutcomeStatus | null;
};

type Tally = {
  total: number;
  counts: OutcomeCounts;
  unrecognised: number;
};

function isOutcomeStatus(value: string): value is OutcomeStatus {
  return (OUTCOME_STATUSES as readonly string[]).includes(value);
}

function newTally(): Tally {
  return {
    total: 0,
    counts: { sent: 0, delivered: 0, failed: 0, suppressed: 0, opted_out: 0 },
    unrecognised: 0,
  };
}

function addToTally(tally: Tally, status: OutcomeStatus | null): void {
  if (status === null) {
    tally.unrecognised += 1;
    return;
  }
  tally.total += 1;
  tally.counts[status] += 1;
}

function share(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return part / whole;
}

function finishTally(tally: Tally): OutcomeGroupSummary {
  return {
    total: tally.total,
    counts: { ...tally.counts },
    unrecognised: tally.unrecognised,
    rates: {
      deliveredRate: share(tally.counts.delivered, tally.total),
      failedRate: share(tally.counts.failed, tally.total),
      suppressedRate: share(tally.counts.suppressed, tally.total),
      optedOutRate: share(tally.counts.opted_out, tally.total),
    },
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

// Returns a prepared row, or null when the record must be rejected.
function prepareRecord(record: unknown, companyId: string): PreparedRow | null {
  if (record === null || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;

  if (r.companyId !== undefined && r.companyId !== companyId) return null;

  if (!isNonEmptyString(r.channel)) return null;
  const channel = r.channel.trim().toLowerCase();

  // A campaign id must be a real string or an explicit null. An absent value is rejected,
  // so a campaign send is never silently moved into the channel-only bucket.
  let campaignId: string | null;
  if (r.campaignId === null) {
    campaignId = null;
  } else if (isNonEmptyString(r.campaignId)) {
    campaignId = r.campaignId.trim();
  } else {
    return null;
  }

  if (typeof r.status !== 'string') return null;
  const normalised = r.status.trim().toLowerCase();
  const status = isOutcomeStatus(normalised) ? normalised : null;

  return { channel, campaignId, status };
}

type PrepareResult =
  | { ok: true; rows: PreparedRow[]; rejected: number }
  | OutcomeSummaryRefusal;

function prepare(input: OutcomeSummaryInput | undefined): PrepareResult {
  const companyId = input?.companyId;
  if (!isNonEmptyString(companyId)) {
    return { ok: false, reason: 'invalid_company' };
  }
  const records = input?.records;
  if (!Array.isArray(records)) {
    return { ok: false, reason: 'invalid_records' };
  }

  const rows: PreparedRow[] = [];
  let rejected = 0;
  for (const record of records) {
    const row = prepareRecord(record, companyId);
    if (row === null) {
      rejected += 1;
    } else {
      rows.push(row);
    }
  }
  return { ok: true, rows, rejected };
}

/**
 * One summary per channel. Includes campaign-tagged and channel-only records.
 * Channels are sorted by name so the output is stable.
 */
export function summarizeChannelOutcomes(input: OutcomeSummaryInput): ChannelOutcomeSummaryResult {
  const prepared = prepare(input);
  if (!prepared.ok) return prepared;

  const byChannel = new Map<string, Tally>();
  for (const row of prepared.rows) {
    let tally = byChannel.get(row.channel);
    if (!tally) {
      tally = newTally();
      byChannel.set(row.channel, tally);
    }
    addToTally(tally, row.status);
  }

  const channels: ChannelOutcomeSummary[] = [...byChannel.keys()]
    .sort()
    .map((channel) => ({ channel, ...finishTally(byChannel.get(channel) as Tally) }));

  return {
    ok: true,
    companyId: input.companyId,
    channels,
    rejected: prepared.rejected,
  };
}

/**
 * One summary per campaign. Channel-only records (campaignId null) are counted in `unattributed`
 * and are not part of any campaign. Campaigns are sorted by id so the output is stable.
 */
export function summarizeCampaignOutcomes(input: OutcomeSummaryInput): CampaignOutcomeSummaryResult {
  const prepared = prepare(input);
  if (!prepared.ok) return prepared;

  const byCampaign = new Map<string, Tally>();
  let unattributed = 0;
  for (const row of prepared.rows) {
    if (row.campaignId === null) {
      unattributed += 1;
      continue;
    }
    let tally = byCampaign.get(row.campaignId);
    if (!tally) {
      tally = newTally();
      byCampaign.set(row.campaignId, tally);
    }
    addToTally(tally, row.status);
  }

  const campaigns: CampaignOutcomeSummary[] = [...byCampaign.keys()]
    .sort()
    .map((campaignId) => ({ campaignId, ...finishTally(byCampaign.get(campaignId) as Tally) }));

  return {
    ok: true,
    companyId: input.companyId,
    campaigns,
    unattributed,
    rejected: prepared.rejected,
  };
}
