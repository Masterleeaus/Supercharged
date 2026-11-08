// Campaign tracking links with source attribution. Pure functions: no I/O, no clock, no randomness.
// The attribution token (tid) is a deterministic SHA-256 digest truncated to 16 hex characters,
// so the same inputs always produce the same token. It is not a secret and is not a signature.
import { createHash } from 'node:crypto';

export type TrackingLinkInput = {
  baseUrl: string;
  companyId: string;
  campaignId: string;
  channel: string;
  source?: string;
};

export type TrackingLinkFailureReason =
  | 'missing_field'
  | 'invalid_company'
  | 'unsafe_url'
  | 'invalid_campaign'
  | 'invalid_channel'
  | 'invalid_source';

export type TrackingLinkResult =
  | { ok: true; url: string }
  | { ok: false; reason: TrackingLinkFailureReason };

export type ParsedTrackingLink =
  | { ok: true; source: string; medium: string; campaign: string; tid: string }
  | { ok: false; reason: 'not_tracking_link' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TID_RE = /^[0-9a-f]{16}$/;
const CHANNEL_RE = /^[a-z][a-z0-9_-]{0,31}$/;
// C0 and C1 control characters, DEL. Campaign ids and sources end up in query strings and analytics rows.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_CAMPAIGN_ID_LENGTH = 200; // Same limit as the marketing service's campaign references.
const MAX_SOURCE_LENGTH = 100;
const TRACKED_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'tid'] as const;

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

export function isValidCampaignId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= MAX_CAMPAIGN_ID_LENGTH &&
    !CONTROL_RE.test(value)
  );
}

export function isValidChannel(value: unknown): value is string {
  return typeof value === 'string' && CHANNEL_RE.test(value);
}

export function isValidSource(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= MAX_SOURCE_LENGTH &&
    !CONTROL_RE.test(value)
  );
}

function safeDecode(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

// Deterministic attribution token. The fields are JSON-encoded so that values containing
// separators cannot collide with a different combination of fields.
export function computeTrackingToken(
  companyId: string,
  campaignId: string,
  channel: string,
  source: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify([companyId, campaignId, channel, source]), 'utf8')
    .digest('hex')
    .slice(0, 16);
}

export function buildTrackingLink(input: TrackingLinkInput): TrackingLinkResult {
  if (!input || typeof input !== 'object') return { ok: false, reason: 'missing_field' };
  const { baseUrl, companyId, campaignId, channel } = input;

  if (isBlank(baseUrl) || isBlank(companyId) || isBlank(campaignId) || isBlank(channel)) {
    return { ok: false, reason: 'missing_field' };
  }
  if (!UUID_RE.test(companyId)) return { ok: false, reason: 'invalid_company' };
  if (!isValidCampaignId(campaignId)) return { ok: false, reason: 'invalid_campaign' };
  if (!isValidChannel(channel)) return { ok: false, reason: 'invalid_channel' };

  // A missing or blank source falls back to the channel. A source that is present but not a string is refused.
  if (input.source !== undefined && input.source !== null && typeof input.source !== 'string') {
    return { ok: false, reason: 'invalid_source' };
  }

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, reason: 'unsafe_url' };
  }
  if (url.protocol !== 'https:' || url.hostname === '') return { ok: false, reason: 'unsafe_url' };
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'unsafe_url' };

  const source = isBlank(input.source) ? channel : (input.source as string);
  if (!isValidSource(source)) return { ok: false, reason: 'invalid_source' };
  // The channel is the default source, so it must pass the same check.
  const tid = computeTrackingToken(companyId, campaignId, channel, source);

  // Keep every existing query pair as written, except utm_* and tid, which are replaced below.
  const kept = url.search
    .replace(/^\?/, '')
    .split('&')
    .filter((pair) => pair !== '')
    .filter((pair) => {
      const key = safeDecode(pair.split('=')[0]).toLowerCase();
      return !(key.startsWith('utm_') || key === 'tid');
    });

  const tracking = [
    ['utm_source', source],
    ['utm_medium', channel],
    ['utm_campaign', campaignId],
    ['tid', tid],
  ].map(([key, value]) => `${key}=${encodeURIComponent(value)}`);

  // Assigning search keeps the fragment and leaves existing percent-encoded sequences intact.
  url.search = [...kept, ...tracking].join('&');
  return { ok: true, url: url.toString() };
}

export function parseTrackingLink(link: string): ParsedTrackingLink {
  const refuse = { ok: false as const, reason: 'not_tracking_link' as const };
  if (typeof link !== 'string') return refuse;

  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return refuse;
  }

  // A link with a repeated tracking key is refused, so a duplicate cannot shadow the real value.
  for (const key of TRACKED_KEYS) {
    if (url.searchParams.getAll(key).length > 1) return refuse;
  }

  const tid = url.searchParams.get('tid');
  const medium = url.searchParams.get('utm_medium');
  const campaign = url.searchParams.get('utm_campaign');
  if (tid === null || !TID_RE.test(tid)) return refuse;
  if (!isValidChannel(medium) || !isValidCampaignId(campaign)) return refuse;

  const sourceParam = url.searchParams.get('utm_source');
  const source = sourceParam ?? medium;
  if (!isValidSource(source)) return refuse;
  return { ok: true, source, medium, campaign, tid };
}
