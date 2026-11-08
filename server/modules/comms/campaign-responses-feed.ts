// Turns campaign events into a response feed the owner can act on (SyncedAt dashboard, "campaign responses" tab).
// Pure function only: no database, no network, no clock reads. The caller supplies the events.
// Item text never includes a contact's address: only the channel and the campaign id are shown.

import type { CampaignEvent } from './campaign-analytics.ts';

export const RESPONSE_FEED_KINDS = ['reply', 'opt_out', 'converted', 'call_completed'] as const;
export type ResponseFeedKind = (typeof RESPONSE_FEED_KINDS)[number];

export interface CampaignResponseItem {
  id: string;
  kind: ResponseFeedKind;
  title: string;
  detail: string;
  channel: string;
  campaignId: string;
  createdAt: string; // ISO 8601, or 'unknown' when the event time is missing or unreadable
  /** Always present on a reply. Running it is a customer send, so it needs a verified owner approval. */
  suggestedAction?: { label: string; kind: 'reply'; campaignId: string; requiresApproval: true };
}

/** Counts of each outcome kind. Used for both channel-level and campaign-level outcomes. */
export interface OutcomeCounts {
  replies: number;
  optOuts: number;
  conversions: number;
  callsCompleted: number;
}

/** Channel-level outcomes: one row per channel, summed across every campaign on that channel. */
export interface ChannelOutcome {
  channel: string;
  counts: OutcomeCounts;
}

/** Campaign-level outcomes: one row per campaign, summed across every channel it used. */
export interface CampaignOutcome {
  campaignId: string;
  counts: OutcomeCounts;
}

export type CampaignResponsesFailure = {
  ok: false;
  error: 'invalid_company';
  message: string;
};

export type CampaignResponsesSuccess = {
  ok: true;
  companyId: string;
  /** Event feed, newest first, limited by `limit`. Shape unchanged. */
  items: CampaignResponseItem[];
  /** Channel-level outcomes. Not limited: counts cover every matching event. Sorted by channel. */
  channelOutcomes: ChannelOutcome[];
  /** Campaign-level outcomes. Not limited: counts cover every matching event. Sorted by campaignId. */
  campaignOutcomes: CampaignOutcome[];
};

export type CampaignResponsesResult = CampaignResponsesSuccess | CampaignResponsesFailure;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_LIMIT = 50;

// Maps the campaign event kinds that produce feed items to their feed kind. Every other kind is ignored.
const KIND_MAP: Readonly<Record<string, ResponseFeedKind>> = {
  replied: 'reply',
  opted_out: 'opt_out',
  converted: 'converted',
  call_completed: 'call_completed',
};

function isValidCompanyId(companyId: unknown): companyId is string {
  return typeof companyId === 'string' && UUID_RE.test(companyId);
}

// Returns epoch milliseconds, or null when the time is missing or unreadable.
function toEpochMs(at: unknown): number | null {
  if (at instanceof Date) {
    const ms = at.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof at === 'number') {
    return Number.isFinite(at) ? at : null;
  }
  if (typeof at === 'string' && at.trim() !== '') {
    const ms = Date.parse(at);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

function normaliseLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(0, Math.floor(limit));
}

function buildText(
  kind: ResponseFeedKind,
  channel: string,
  campaignId: string,
): { title: string; detail: string } {
  switch (kind) {
    case 'reply':
      return {
        title: 'New reply',
        detail: `A contact replied on ${channel} in campaign ${campaignId}.`,
      };
    case 'opt_out':
      return {
        title: 'Contact opted out',
        detail: `The contact opted out on ${channel} and was removed from campaign ${campaignId}.`,
      };
    case 'converted':
      return {
        title: 'Conversion',
        detail: `A contact converted on ${channel} in campaign ${campaignId}.`,
      };
    case 'call_completed':
      return {
        title: 'Call completed',
        detail: `A call completed on ${channel} in campaign ${campaignId}.`,
      };
  }
}

/**
 * Build the owner-facing response feed for one company, newest first.
 *
 * - Only replied, opted_out, converted and call_completed events produce items; other kinds are skipped.
 * - Only events whose companyId matches are included.
 * - A reply carries one suggested action. No other kind does.
 * - Items with an unknown time sort after dated items and show createdAt 'unknown'.
 * - At most `limit` items are returned (default 50).
 */
export function buildCampaignResponses(input: {
  companyId: string;
  events: readonly CampaignEvent[];
  limit?: number;
}): CampaignResponsesResult {
  const { companyId, events, limit } = input ?? ({} as { companyId: string; events: CampaignEvent[] });

  if (!isValidCompanyId(companyId)) {
    return { ok: false, error: 'invalid_company', message: 'companyId must be a UUID' };
  }

  const candidates: Array<{ item: CampaignResponseItem; ms: number | null; order: number }> = [];
  const byChannel = new Map<string, OutcomeCounts>();
  const byCampaign = new Map<string, OutcomeCounts>();

  (events ?? []).forEach((event, order) => {
    if (!event || event.companyId !== companyId) return;
    const kind = KIND_MAP[event.kind as string];
    if (!kind) return;

    const channel = typeof event.channel === 'string' && event.channel !== '' ? event.channel : 'unknown';
    const campaignId = String(event.campaignId);
    const ms = toEpochMs(event.at);
    const { title, detail } = buildText(kind, channel, campaignId);

    const item: CampaignResponseItem = {
      id: `${kind}-${order}`,
      kind,
      title,
      detail,
      channel,
      campaignId,
      createdAt: ms === null ? 'unknown' : new Date(ms).toISOString(),
    };
    if (kind === 'reply') {
      item.suggestedAction = { label: 'Send suggested reply', kind: 'reply', campaignId, requiresApproval: true };
    }

    countInto(byChannel, channel, kind);
    countInto(byCampaign, campaignId, kind);
    candidates.push({ item, ms, order });
  });

  candidates.sort((a, b) => {
    if (a.ms === null && b.ms === null) return a.order - b.order;
    if (a.ms === null) return 1;
    if (b.ms === null) return -1;
    return b.ms - a.ms || a.order - b.order;
  });

  const items = candidates.slice(0, normaliseLimit(limit)).map((c) => c.item);

  const channelOutcomes: ChannelOutcome[] = [...byChannel.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([channel, counts]) => ({ channel, counts }));
  const campaignOutcomes: CampaignOutcome[] = [...byCampaign.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([campaignId, counts]) => ({ campaignId, counts }));

  return { ok: true, companyId, items, channelOutcomes, campaignOutcomes };
}

function emptyCounts(): OutcomeCounts {
  return { replies: 0, optOuts: 0, conversions: 0, callsCompleted: 0 };
}

function countInto(target: Map<string, OutcomeCounts>, key: string, kind: ResponseFeedKind): void {
  let counts = target.get(key);
  if (!counts) {
    counts = emptyCounts();
    target.set(key, counts);
  }
  if (kind === 'reply') counts.replies += 1;
  else if (kind === 'opt_out') counts.optOuts += 1;
  else if (kind === 'converted') counts.conversions += 1;
  else counts.callsCompleted += 1;
}
