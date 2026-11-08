import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCallOutcome } from '../../server/modules/comms/call-outcomes.ts';
import { summarizeCampaign } from '../../server/modules/comms/campaign-analytics.ts';

// Pure logic only. No network, no database.

const CO = '11111111-1111-4111-8111-111111111111';
const CAMP = 'camp-spring';
const AT = '2026-11-01T10:00:00Z';

const base = (overrides = {}) => ({
  companyId: CO,
  campaignId: CAMP,
  channel: 'phone',
  providerStatus: 'completed',
  durationSeconds: 42,
  at: AT,
  ...overrides,
});

const okKind = (input) => {
  const r = mapCallOutcome(input);
  assert.equal(r.ok, true, `expected ok, got ${JSON.stringify(r)}`);
  return r.event;
};

const refused = (input, reason) => {
  const r = mapCallOutcome(input);
  assert.deepEqual(r, { ok: false, reason });
};

// Status mappings

test('completed with a long call maps to call_completed', () => {
  const e = okKind(base({ providerStatus: 'completed' }));
  assert.equal(e.kind, 'call_completed');
  assert.equal(e.channel, 'phone');
  assert.equal(e.companyId, CO);
  assert.equal(e.campaignId, CAMP);
  assert.equal(e.at, AT);
});

test('answered with a long call maps to call_completed', () => {
  assert.equal(okKind(base({ providerStatus: 'answered' })).kind, 'call_completed');
});

test('voicemail with a long call maps to call_completed', () => {
  assert.equal(okKind(base({ providerStatus: 'voicemail', durationSeconds: 30 })).kind, 'call_completed');
});

test('machine with a long call maps to call_completed', () => {
  assert.equal(okKind(base({ providerStatus: 'machine', durationSeconds: 12 })).kind, 'call_completed');
});

test('voicemail or machine shorter than 5 seconds produces no event', () => {
  refused(base({ providerStatus: 'voicemail', durationSeconds: 3 }), 'too_short');
  refused(base({ providerStatus: 'machine', durationSeconds: 4 }), 'too_short');
});

test('busy, no-answer, no_answer, failed, canceled and cancelled are not_connected', () => {
  for (const providerStatus of ['busy', 'no-answer', 'no_answer', 'failed', 'canceled', 'cancelled']) {
    refused(base({ providerStatus }), 'not_connected');
  }
});

test('status matching is case-insensitive', () => {
  assert.equal(okKind(base({ providerStatus: 'COMPLETED' })).kind, 'call_completed');
  assert.equal(okKind(base({ providerStatus: 'Answered' })).kind, 'call_completed');
  assert.equal(okKind(base({ providerStatus: 'Voicemail' })).kind, 'call_completed');
  refused(base({ providerStatus: 'No-Answer' }), 'not_connected');
  refused(base({ providerStatus: 'CANCELLED' }), 'not_connected');
});

// Short calls

test('a completed call under 5 seconds is not counted', () => {
  refused(base({ providerStatus: 'completed', durationSeconds: 4 }), 'too_short');
  refused(base({ providerStatus: 'answered', durationSeconds: 0 }), 'too_short');
});

test('exactly 5 seconds is counted', () => {
  assert.equal(okKind(base({ providerStatus: 'completed', durationSeconds: 5 })).kind, 'call_completed');
});

// Unknown statuses

test('unknown provider status is refused, not guessed', () => {
  refused(base({ providerStatus: 'ringing' }), 'unknown_status');
  refused(base({ providerStatus: 'in-progress' }), 'unknown_status');
  refused(base({ providerStatus: '' }), 'unknown_status');
  refused(base({ providerStatus: undefined }), 'unknown_status');
  refused(base({ providerStatus: null }), 'unknown_status');
});

// Cost validation

test('costCents is included when a non-negative integer', () => {
  assert.equal(okKind(base({ costCents: 0 })).costCents, 0);
  assert.equal(okKind(base({ costCents: 27 })).costCents, 27);
});

test('costCents is omitted from the event when not given', () => {
  const e = okKind(base());
  assert.equal('costCents' in e, false);
});

test('negative, fractional, NaN or non-numeric costCents is refused', () => {
  refused(base({ costCents: -1 }), 'invalid_cost');
  refused(base({ costCents: 1.5 }), 'invalid_cost');
  refused(base({ costCents: Number.NaN }), 'invalid_cost');
  refused(base({ costCents: '12' }), 'invalid_cost');
});

// Company and campaign validation

test('non-UUID companyId is refused as invalid_company', () => {
  refused(base({ companyId: 'not-a-uuid' }), 'invalid_company');
  refused(base({ companyId: '' }), 'invalid_company');
  refused(base({ companyId: undefined }), 'invalid_company');
});

test('missing or blank campaignId is refused as missing_field', () => {
  refused(base({ campaignId: undefined }), 'missing_field');
  refused(base({ campaignId: '   ' }), 'missing_field');
});

test('missing at is refused as missing_field', () => {
  refused(base({ at: undefined }), 'missing_field');
});

test('channels other than phone are refused', () => {
  refused(base({ channel: 'sms' }), 'invalid_channel');
});

test('invalid durationSeconds is refused', () => {
  refused(base({ durationSeconds: -1 }), 'invalid_duration');
  refused(base({ durationSeconds: Number.NaN }), 'invalid_duration');
});

// Compatibility with summarizeCampaign

test('a mapped event is accepted by summarizeCampaign and counted', () => {
  const event = okKind(base({ providerStatus: 'answered', durationSeconds: 90, costCents: 35, at: new Date(AT) }));
  const summary = summarizeCampaign({ companyId: CO, campaignId: CAMP, events: [event] });
  assert.equal(summary.ok, true);
  const phone = summary.channels.phone;
  assert.equal(phone.counts.call_completed, 1);
  assert.equal(phone.costCents, 35);
  assert.equal(phone.counts.opened, 'not_tracked');
});

test('mapped events from different campaigns are not mixed in summarizeCampaign', () => {
  const mine = okKind(base());
  const other = okKind(base({ campaignId: 'camp-autumn' }));
  const summary = summarizeCampaign({ companyId: CO, campaignId: CAMP, events: [mine, other] });
  assert.equal(summary.channels.phone.counts.call_completed, 1);
});
