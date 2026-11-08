// Maps a raw phone call result from a voice provider to a campaign analytics event.
// Pure function only: no database, no network, no clock reads. The caller supplies the values.

import type { CampaignEvent } from './campaign-analytics.ts';

// Calls shorter than this are not counted as completed, even when the provider connected them.
export const MIN_COUNTED_CALL_SECONDS = 5;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Statuses that mean a person (or a human-like voice) answered.
const CONNECTED_ALWAYS = new Set(['completed', 'answered']);
// Statuses that connected to a recording or a machine. Counted only when long enough.
const CONNECTED_MAYBE = new Set(['voicemail', 'machine']);
// Statuses where the call never connected. These produce no event.
const NOT_CONNECTED = new Set([
  'busy',
  'no-answer',
  'no_answer',
  'failed',
  'canceled',
  'cancelled',
]);

export type CallOutcomeInput = {
  companyId: string;
  campaignId: string;
  channel: 'phone';
  providerStatus: string;
  durationSeconds: number;
  at: Date | number | string;
  costCents?: number;
};

export type CallOutcomeResult =
  | { ok: true; event: CampaignEvent & { channel: 'phone'; kind: 'call_completed' } }
  | {
      ok: false;
      reason:
        | 'invalid_company'
        | 'missing_field'
        | 'invalid_channel'
        | 'invalid_cost'
        | 'invalid_duration'
        | 'unknown_status'
        | 'not_connected'
        | 'too_short';
    };

function isValidCostCents(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Map one provider call result to a campaign event.
 *
 * - completed / answered with duration >= 5s: call_completed.
 * - voicemail / machine with duration >= 5s: call_completed. Shorter: too_short.
 * - busy, no-answer, failed, canceled: not_connected (no event).
 * - Any other status: unknown_status. The status is never guessed.
 */
export function mapCallOutcome(input: CallOutcomeInput): CallOutcomeResult {
  const { companyId, campaignId, channel, providerStatus, durationSeconds, at, costCents } =
    input ?? ({} as CallOutcomeInput);

  if (typeof companyId !== 'string' || !UUID_RE.test(companyId)) {
    return { ok: false, reason: 'invalid_company' };
  }
  if (typeof campaignId !== 'string' || campaignId.trim() === '') {
    return { ok: false, reason: 'missing_field' };
  }
  if (channel !== 'phone') {
    return { ok: false, reason: 'invalid_channel' };
  }
  if (at === undefined || at === null) {
    return { ok: false, reason: 'missing_field' };
  }
  if (costCents !== undefined && !isValidCostCents(costCents)) {
    return { ok: false, reason: 'invalid_cost' };
  }
  if (
    durationSeconds !== undefined &&
    (typeof durationSeconds !== 'number' || !Number.isFinite(durationSeconds) || durationSeconds < 0)
  ) {
    return { ok: false, reason: 'invalid_duration' };
  }

  const status = typeof providerStatus === 'string' ? providerStatus.trim().toLowerCase() : '';

  if (NOT_CONNECTED.has(status)) {
    return { ok: false, reason: 'not_connected' };
  }

  const connected = CONNECTED_ALWAYS.has(status) || CONNECTED_MAYBE.has(status);
  if (!connected) {
    return { ok: false, reason: 'unknown_status' };
  }

  const duration = typeof durationSeconds === 'number' ? durationSeconds : 0;
  if (duration < MIN_COUNTED_CALL_SECONDS) {
    return { ok: false, reason: 'too_short' };
  }

  const event: CampaignEvent & { channel: 'phone'; kind: 'call_completed' } = {
    companyId,
    campaignId,
    channel: 'phone',
    kind: 'call_completed',
    at,
  };
  if (costCents !== undefined) event.costCents = costCents;

  return { ok: true, event };
}
