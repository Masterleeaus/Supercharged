import test from 'node:test';
import assert from 'node:assert/strict';
import {
  summarizeChannelOutcomes,
  summarizeCampaignOutcomes,
  OUTCOME_STATUSES,
} from '../../server/modules/comms/analytics-outcomes.ts';

// Pure logic only. No network, no database, no clock. Test output stays silent.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const CO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

// Fixed data set.
// sms   recognised: sent 2, delivered 2, failed 1 (total 5), plus 1 unrecognised
// email recognised: delivered 1, suppressed 1, opted_out 1 (total 3)
// camp-a: sms sent, sms delivered x2, sms failed, email opted_out (total 5)
// camp-b: email suppressed (total 1), sms unrecognised
// unattributed (no campaign): email delivered, sms sent
const FIXED = [
  { channel: 'sms', campaignId: 'camp-a', status: 'sent' },
  { channel: 'sms', campaignId: 'camp-a', status: 'delivered' },
  { channel: 'sms', campaignId: 'camp-a', status: 'delivered' },
  { channel: 'sms', campaignId: 'camp-a', status: 'failed' },
  { channel: 'email', campaignId: 'camp-a', status: 'opted_out' },
  { channel: 'email', campaignId: 'camp-b', status: 'suppressed' },
  { channel: 'email', campaignId: null, status: 'delivered' },
  { channel: 'sms', campaignId: null, status: 'sent' },
  { channel: 'sms', campaignId: 'camp-b', status: 'bogus' },
];

const input = (records, companyId = CO) => ({ companyId, records });

// Refusals

test('missing or blank company id is refused by both summaries', () => {
  for (const companyId of [undefined, null, '', '   ', 42]) {
    assert.deepEqual(summarizeChannelOutcomes({ companyId, records: FIXED }), {
      ok: false,
      reason: 'invalid_company',
    });
    assert.deepEqual(summarizeCampaignOutcomes({ companyId, records: FIXED }), {
      ok: false,
      reason: 'invalid_company',
    });
  }
});

test('missing input object is refused as invalid_company', () => {
  assert.deepEqual(summarizeChannelOutcomes(undefined), { ok: false, reason: 'invalid_company' });
  assert.deepEqual(summarizeCampaignOutcomes(undefined), { ok: false, reason: 'invalid_company' });
});

test('records that are not an array are refused as invalid_records', () => {
  assert.deepEqual(summarizeChannelOutcomes(input(undefined)), { ok: false, reason: 'invalid_records' });
  assert.deepEqual(summarizeCampaignOutcomes(input('sent')), { ok: false, reason: 'invalid_records' });
});

test('the status list is the five agreed outcomes', () => {
  assert.deepEqual([...OUTCOME_STATUSES], ['sent', 'delivered', 'failed', 'suppressed', 'opted_out']);
});

// Channel summary

test('channel summary has one entry per channel, sorted, with separate counts', () => {
  const r = summarizeChannelOutcomes(input(FIXED));
  assert.equal(r.ok, true);
  assert.equal(r.companyId, CO);
  assert.equal(r.rejected, 0);
  assert.deepEqual(r.channels.map((c) => c.channel), ['email', 'sms']);

  const sms = r.channels.find((c) => c.channel === 'sms');
  assert.equal(sms.total, 5);
  assert.deepEqual(sms.counts, { sent: 2, delivered: 2, failed: 1, suppressed: 0, opted_out: 0 });
  assert.equal(sms.unrecognised, 1);

  const email = r.channels.find((c) => c.channel === 'email');
  assert.equal(email.total, 3);
  assert.deepEqual(email.counts, { sent: 0, delivered: 1, failed: 0, suppressed: 1, opted_out: 1 });
  assert.equal(email.unrecognised, 0);
});

test('channel summary includes both campaign-tagged and channel-only records', () => {
  const r = summarizeChannelOutcomes(input(FIXED));
  const sms = r.channels.find((c) => c.channel === 'sms');
  // sent: one tagged to camp-a and one channel-only. Both are counted in the channel.
  assert.equal(sms.counts.sent, 2);
  // delivered: the email channel-only record is counted in email, not in sms.
  assert.equal(r.channels.find((c) => c.channel === 'email').counts.delivered, 1);
});

test('channel summary does not carry a campaigns field', () => {
  const r = summarizeChannelOutcomes(input(FIXED));
  assert.equal('campaigns' in r, false);
  assert.equal('unattributed' in r, false);
});

test('channel rates are shares of recognised outcomes in the channel', () => {
  const r = summarizeChannelOutcomes(input(FIXED));
  const sms = r.channels.find((c) => c.channel === 'sms');
  assert.equal(sms.rates.deliveredRate, 2 / 5);
  assert.equal(sms.rates.failedRate, 1 / 5);
  assert.equal(sms.rates.suppressedRate, 0);
  assert.equal(sms.rates.optedOutRate, 0);

  const email = r.channels.find((c) => c.channel === 'email');
  assert.equal(email.rates.deliveredRate, 1 / 3);
  assert.equal(email.rates.suppressedRate, 1 / 3);
  assert.equal(email.rates.optedOutRate, 1 / 3);
  assert.equal(email.rates.failedRate, 0);
});

test('a channel with only unrecognised outcomes returns null rates, not NaN or Infinity', () => {
  const r = summarizeChannelOutcomes(input([{ channel: 'push', campaignId: null, status: 'queued' }]));
  assert.equal(r.ok, true);
  const push = r.channels[0];
  assert.equal(push.channel, 'push');
  assert.equal(push.total, 0);
  assert.equal(push.unrecognised, 1);
  assert.deepEqual(push.rates, {
    deliveredRate: null,
    failedRate: null,
    suppressedRate: null,
    optedOutRate: null,
  });
});

test('empty records give an ok result with no channels', () => {
  const r = summarizeChannelOutcomes(input([]));
  assert.deepEqual(r, { ok: true, companyId: CO, channels: [], rejected: 0 });
});

// Campaign summary

test('campaign summary has one entry per campaign, sorted, with separate counts', () => {
  const r = summarizeCampaignOutcomes(input(FIXED));
  assert.equal(r.ok, true);
  assert.deepEqual(r.campaigns.map((c) => c.campaignId), ['camp-a', 'camp-b']);

  const a = r.campaigns[0];
  assert.equal(a.total, 5);
  assert.deepEqual(a.counts, { sent: 1, delivered: 2, failed: 1, suppressed: 0, opted_out: 1 });
  assert.equal(a.unrecognised, 0);

  const b = r.campaigns[1];
  assert.equal(b.total, 1);
  assert.deepEqual(b.counts, { sent: 0, delivered: 0, failed: 0, suppressed: 1, opted_out: 0 });
  assert.equal(b.unrecognised, 1);
});

test('campaign rates are shares within the campaign', () => {
  const r = summarizeCampaignOutcomes(input(FIXED));
  const a = r.campaigns[0];
  assert.equal(a.rates.deliveredRate, 2 / 5);
  assert.equal(a.rates.failedRate, 1 / 5);
  assert.equal(a.rates.optedOutRate, 1 / 5);
  assert.equal(a.rates.suppressedRate, 0);

  const b = r.campaigns[1];
  assert.equal(b.rates.suppressedRate, 1);
  assert.equal(b.rates.deliveredRate, 0);
});

test('channel-only records are counted as unattributed and kept out of campaigns', () => {
  const r = summarizeCampaignOutcomes(input(FIXED));
  assert.equal(r.unattributed, 2);
  const totalInCampaigns = r.campaigns.reduce((n, c) => n + c.total + c.unrecognised, 0);
  assert.equal(totalInCampaigns, 7);
});

test('campaign summary does not carry a channels field', () => {
  const r = summarizeCampaignOutcomes(input(FIXED));
  assert.equal('channels' in r, false);
});

test('no campaign-tagged records gives an empty campaign list', () => {
  const r = summarizeCampaignOutcomes(
    input([
      { channel: 'sms', campaignId: null, status: 'sent' },
      { channel: 'email', campaignId: null, status: 'delivered' },
    ]),
  );
  assert.deepEqual(r, { ok: true, companyId: CO, campaigns: [], unattributed: 2, rejected: 0 });
});

// Tenancy guard and malformed records

test('a record for another company is rejected and not counted', () => {
  const r = summarizeChannelOutcomes(
    input([
      { companyId: OTHER, channel: 'sms', campaignId: 'camp-a', status: 'sent' },
      { companyId: CO, channel: 'sms', campaignId: 'camp-a', status: 'sent' },
    ]),
  );
  assert.equal(r.rejected, 1);
  assert.equal(r.channels[0].counts.sent, 1);
});

test('malformed records are rejected and counted', () => {
  const r = summarizeCampaignOutcomes(
    input([
      null,
      'sms',
      { channel: '', campaignId: null, status: 'sent' },
      { channel: 'sms', campaignId: undefined, status: 'sent' },
      { channel: 'sms', campaignId: 'camp-a', status: 3 },
      { channel: 'sms', campaignId: 'camp-a', status: 'sent' },
    ]),
  );
  assert.equal(r.rejected, 5);
  assert.equal(r.campaigns[0].counts.sent, 1);
});

test('channel and status are matched case-insensitively and trimmed', () => {
  const r = summarizeCampaignOutcomes(
    input([{ channel: ' SMS ', campaignId: ' camp-a ', status: ' Delivered ' }]),
  );
  assert.equal(r.campaigns[0].campaignId, 'camp-a');
  assert.equal(r.campaigns[0].counts.delivered, 1);
});

test('an unknown status is counted as unrecognised, never guessed into a bucket', () => {
  const r = summarizeChannelOutcomes(input([{ channel: 'sms', campaignId: null, status: 'pending' }]));
  const sms = r.channels[0];
  assert.equal(sms.unrecognised, 1);
  assert.equal(sms.total, 0);
  assert.equal(sms.rates.deliveredRate, null);
});

test('the input records are not mutated', () => {
  const records = FIXED.map((r) => ({ ...r }));
  const snapshot = JSON.stringify(records);
  summarizeChannelOutcomes(input(records));
  summarizeCampaignOutcomes(input(records));
  assert.equal(JSON.stringify(records), snapshot);
});
