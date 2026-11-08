// Per-channel campaign outcome summary: counts, rates, cost and cost per conversion.
// Pure functions only: no database, no network, no clock reads. The caller supplies the events.

export const CAMPAIGN_EVENT_KINDS = [
  'sent',
  'delivered',
  'bounced',
  'opened',
  'clicked',
  'replied',
  'opted_out',
  'call_completed',
  'converted',
] as const;

export type CampaignEventKind = (typeof CAMPAIGN_EVENT_KINDS)[number];

// Channels where open and click tracking is unreliable, so those counts are not reported.
export const UNTRACKED_OPEN_CHANNELS = [
  'sms',
  'whatsapp',
  'telegram',
  'messenger',
  'instagram',
  'phone',
] as const;

export interface CampaignEvent {
  companyId: string;
  campaignId: string;
  channel: string;
  kind: CampaignEventKind;
  at: Date | number | string;
  costCents?: number;
}

export type CampaignSummaryFailure = {
  ok: false;
  error: 'invalid_company';
  message: string;
};

export type ChannelCounts = Record<CampaignEventKind, number | 'not_tracked'>;

export interface ChannelSummary {
  counts: ChannelCounts;
  // Rates are fractions in [0, 1]; null when the denominator is zero.
  rates: {
    deliveredRate: number | null; // delivered / sent
    replyRate: number | null; // replied / delivered
    optOutRate: number | null; // opted_out / delivered
  };
  costCents: number;
  costPerConversionCents: number | null;
}

export type CampaignSummarySuccess = {
  ok: true;
  companyId: string;
  campaignId: string;
  channels: Record<string, ChannelSummary>;
};

export type CampaignSummaryResult = CampaignSummarySuccess | CampaignSummaryFailure;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KIND_SET: ReadonlySet<string> = new Set(CAMPAIGN_EVENT_KINDS);
const UNTRACKED_SET: ReadonlySet<string> = new Set(UNTRACKED_OPEN_CHANNELS);

function isValidCompanyId(companyId: unknown): companyId is string {
  return typeof companyId === 'string' && UUID_RE.test(companyId);
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function emptyCounts(channel: string): ChannelCounts {
  const counts = {} as ChannelCounts;
  for (const kind of CAMPAIGN_EVENT_KINDS) counts[kind] = 0;
  if (UNTRACKED_SET.has(channel)) {
    counts.opened = 'not_tracked';
    counts.clicked = 'not_tracked';
  }
  return counts;
}

/**
 * Summarise one campaign's outcomes per channel. Only events whose companyId and campaignId
 * match the arguments are counted; everything else in `events` is ignored.
 */
export function summarizeCampaign(input: {
  companyId: string;
  campaignId: string;
  events: readonly CampaignEvent[];
}): CampaignSummaryResult {
  const { companyId, campaignId, events } = input;

  if (!isValidCompanyId(companyId)) {
    return { ok: false, error: 'invalid_company', message: 'companyId must be a UUID' };
  }

  const channels: Record<string, ChannelSummary> = {};
  const counted: Record<string, { counts: ChannelCounts; costCents: number }> = {};

  for (const event of events ?? []) {
    if (!event || event.companyId !== companyId || event.campaignId !== campaignId) continue;
    if (!KIND_SET.has(event.kind)) continue;

    const channel = event.channel;
    if (!counted[channel]) counted[channel] = { counts: emptyCounts(channel), costCents: 0 };
    const bucket = counted[channel];

    // Opens and clicks on untracked channels stay 'not_tracked' rather than being counted.
    if (UNTRACKED_SET.has(channel) && (event.kind === 'opened' || event.kind === 'clicked')) {
      continue;
    }
    (bucket.counts[event.kind] as number) += 1;

    if (typeof event.costCents === 'number' && Number.isFinite(event.costCents)) {
      bucket.costCents += event.costCents;
    }
  }

  for (const [channel, { counts, costCents }] of Object.entries(counted)) {
    const sent = counts.sent as number;
    const delivered = counts.delivered as number;
    const replied = counts.replied as number;
    const optedOut = counts.opted_out as number;
    const converted = counts.converted as number;

    channels[channel] = {
      counts,
      rates: {
        deliveredRate: ratio(delivered, sent),
        replyRate: ratio(replied, delivered),
        optOutRate: ratio(optedOut, delivered),
      },
      costCents,
      // Null unless there are conversions. Rounded to whole cents.
      costPerConversionCents: converted > 0 ? Math.round(costCents / converted) : null,
    };
  }

  return { ok: true, companyId, campaignId, channels };
}
