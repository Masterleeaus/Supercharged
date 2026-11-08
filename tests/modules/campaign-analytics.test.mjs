import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCampaign } from '../../server/modules/comms/campaign-analytics.ts';

// Pure logic only. No network, no database.

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const CAMP = 'camp-spring';
const OTHER_CAMP = 'camp-autumn';
const AT = '2026-11-01T10:00:00Z';

const ev = (overrides) => ({
  companyId: CO_A,
  campaignId: CAMP,
  channel: 'email',
  kind: 'sent',
  at: AT,
  ...overrides,
});

test('counts are per company and campaign', () => {
  const events = [
    ev({ kind: 'sent' }),
    ev({ kind: 'sent' }),
    ev({ kind: 'delivered' }),
    ev({ kind: 'bounced' }),
    ev({ kind: 'sent', campaignId: OTHER_CAMP }),
    ev({ kind: 'sent', companyId: CO_B }),
  ];
  const r = summarizeCampaign({ companyId: CO_A, campaignId: CAMP, events });
  assert.equal(r.ok, true);
  assert.equal(r.channels.email.counts.sent, 2);
  assert.equal(r.channels.email.counts.delivered, 1);
  assert.equal(r.channels.email.counts.bounced, 1);
  assert.equal(r.channels.email.counts.converted, 0);
});

test('each kind is counted separately and unknown kinds are ignored', () => {
  const events = [
    ev({ kind: 'opened' }),
    ev({ kind: 'clicked' }),
    ev({ kind: 'replied' }),
    ev({ kind: 'opted_out' }),
    ev({ kind: 'call_completed' }),
    ev({ kind: 'converted' }),
    ev({ kind: 'mystery' }),
  ];
  const r = summarizeCampaign({ companyId: CO_A, campaignId: CAMP, events });
  const c = r.channels.email.counts;
  assert.equal(c.opened, 1);
  assert.equal(c.clicked, 1);
  assert.equal(c.replied, 1);
  assert.equal(c.opted_out, 1);
  assert.equal(c.call_completed, 1);
  assert.equal(c.converted, 1);
  assert.equal(c.mystery, undefined);
});

test('rates are computed and null when the denominator is zero', () => {
  const empty = summarizeCampaign({
    companyId: CO_A,
    campaignId: CAMP,
    events: [ev({ kind: 'replied' })],
  });
  // No sent and no delivered: every rate has a zero denominator.
  assert.equal(empty.channels.email.rates.deliveredRate, null);
  assert.equal(empty.channels.email.rates.replyRate, null);
  assert.equal(empty.channels.email.rates.optOutRate, null);

  const full = summarizeCampaign({
    companyId: CO_A,
    campaignId: CAMP,
    events: [
      ev({ kind: 'sent' }),
      ev({ kind: 'sent' }),
      ev({ kind: 'sent' }),
      ev({ kind: 'sent' }),
      ev({ kind: 'delivered' }),
      ev({ kind: 'delivered' }),
      ev({ kind: 'replied' }),
      ev({ kind: 'opted_out' }),
    ],
  });
  assert.equal(full.channels.email.rates.deliveredRate, 0.5);
  assert.equal(full.channels.email.rates.replyRate, 0.5);
  assert.equal(full.channels.email.rates.optOutRate, 0.5);
});

test('sent without delivered gives a zero delivered rate, not null', () => {
  const r = summarizeCampaign({
    companyId: CO_A,
    campaignId: CAMP,
    events: [ev({ kind: 'sent' }), ev({ kind: 'sent' })],
  });
  assert.equal(r.channels.email.rates.deliveredRate, 0);
  assert.equal(r.channels.email.rates.replyRate, null);
});

test('opens and clicks are not_tracked for sms', () => {
  const r = summarizeCampaign({
    companyId: CO_A,
    campaignId: CAMP,
    events: [
      ev({ channel: 'sms', kind: 'sent' }),
      ev({ channel: 'sms', kind: 'opened' }),
      ev({ channel: 'sms', kind: 'clicked' }),
    ],
  });
  assert.equal(r.channels.sms.counts.opened, 'not_tracked');
  assert.equal(r.channels.sms.counts.clicked, 'not_tracked');
  assert.equal(r.channels.sms.counts.sent, 1);
});

test('opens and clicks are not_tracked for every untracked channel but numbers for email', () => {
  const channels = ['whatsapp', 'telegram', 'messenger', 'instagram', 'phone'];
  const events = [
    ...channels.map((channel) => ev({ channel, kind: 'opened' })),
    ev({ channel: 'email', kind: 'opened' }),
    ev({ channel: 'email', kind: 'clicked' }),
  ];
  const r = summarizeCampaign({ companyId: CO_A, campaignId: CAMP, events });
  for (const channel of channels) {
    assert.equal(r.channels[channel].counts.opened, 'not_tracked', channel);
    assert.equal(r.channels[channel].counts.clicked, 'not_tracked', channel);
  }
  assert.equal(r.channels.email.counts.opened, 1);
  assert.equal(r.channels.email.counts.clicked, 1);
});

test('cost per conversion is null with no conversions', () => {
  const r = summarizeCampaign({
    companyId: CO_A,
    campaignId: CAMP,
    events: [ev({ kind: 'sent', costCents: 12 }), ev({ kind: 'sent', costCents: 8 })],
  });
  assert.equal(r.channels.email.costCents, 20);
  assert.equal(r.channels.email.costPerConversionCents, null);
});

test('cost per conversion divides summed cost by conversions', () => {
  const r = summarizeCampaign({
    companyId: CO_A,
    campaignId: CAMP,
    events: [
      ev({ kind: 'sent', costCents: 100 }),
      ev({ kind: 'sent', costCents: 50 }),
      ev({ kind: 'sent' }), // no cost recorded
      ev({ kind: 'converted' }),
      ev({ kind: 'converted' }),
    ],
  });
  assert.equal(r.channels.email.costCents, 150);
  assert.equal(r.channels.email.costPerConversionCents, 75);
});

test('another company\'s events are excluded from counts and cost', () => {
  const events = [
    ev({ kind: 'converted', costCents: 500 }),
    ev({ companyId: CO_B, kind: 'converted', costCents: 9999 }),
    ev({ companyId: CO_B, kind: 'sent', costCents: 9999 }),
  ];
  const r = summarizeCampaign({ companyId: CO_A, campaignId: CAMP, events });
  assert.equal(r.channels.email.counts.converted, 1);
  assert.equal(r.channels.email.counts.sent, 0);
  assert.equal(r.channels.email.costCents, 500);
  assert.equal(r.channels.email.costPerConversionCents, 500);
});

test('a channel with no matching events is absent', () => {
  const r = summarizeCampaign({
    companyId: CO_A,
    campaignId: CAMP,
    events: [ev({ companyId: CO_B }), ev({ campaignId: OTHER_CAMP, channel: 'sms' })],
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.channels, {});
});

test('invalid company is refused', () => {
  for (const bad of ['', 'not-a-uuid', '11111111-1111-4111-8111-11111111111', undefined, 42]) {
    const r = summarizeCampaign({ companyId: bad, campaignId: CAMP, events: [ev({})] });
    assert.equal(r.ok, false, String(bad));
    assert.equal(r.error, 'invalid_company', String(bad));
  }
});
