import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCampaignResponses } from '../../server/modules/comms/campaign-responses-feed.ts';

// Pure logic only. No network, no database.

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const CAMP = 'camp-spring';
const ADDRESS = 'jane.contact@example.com';
const PHONE_ADDRESS = '+61400111222';

const ev = (overrides) => ({
  companyId: CO_A,
  campaignId: CAMP,
  channel: 'email',
  kind: 'replied',
  at: '2026-11-01T10:00:00Z',
  ...overrides,
});

test('replied becomes a reply item with a suggested action', () => {
  const r = buildCampaignResponses({ companyId: CO_A, events: [ev({ kind: 'replied' })] });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  const [item] = r.items;
  assert.equal(item.kind, 'reply');
  assert.equal(item.channel, 'email');
  assert.equal(item.campaignId, CAMP);
  assert.equal(item.createdAt, '2026-11-01T10:00:00.000Z');
  assert.deepEqual(item.suggestedAction, {
    label: 'Send suggested reply',
    kind: 'reply',
    campaignId: CAMP,
    requiresApproval: true,
  });
});

test('opted_out says the contact was removed and has no suggested action', () => {
  const r = buildCampaignResponses({ companyId: CO_A, events: [ev({ kind: 'opted_out', channel: 'sms' })] });
  const [item] = r.items;
  assert.equal(item.kind, 'opt_out');
  assert.match(item.detail, /removed from campaign/);
  assert.equal('suggestedAction' in item, false);
});

test('converted becomes a converted item with no suggested action', () => {
  const r = buildCampaignResponses({ companyId: CO_A, events: [ev({ kind: 'converted', channel: 'whatsapp' })] });
  const [item] = r.items;
  assert.equal(item.kind, 'converted');
  assert.equal(item.channel, 'whatsapp');
  assert.equal('suggestedAction' in item, false);
});

test('call_completed becomes a call item with no suggested action', () => {
  const r = buildCampaignResponses({ companyId: CO_A, events: [ev({ kind: 'call_completed', channel: 'phone' })] });
  const [item] = r.items;
  assert.equal(item.kind, 'call_completed');
  assert.equal(item.channel, 'phone');
  assert.equal('suggestedAction' in item, false);
});

test('ignored kinds produce no items', () => {
  const events = ['sent', 'delivered', 'bounced', 'opened', 'clicked'].map((kind) => ev({ kind }));
  const r = buildCampaignResponses({ companyId: CO_A, events });
  assert.deepEqual(r, { ok: true, companyId: CO_A, items: [], channelOutcomes: [], campaignOutcomes: [] });
});

test('suggestedAction appears only on reply items', () => {
  const events = [
    ev({ kind: 'replied', at: '2026-11-01T10:00:00Z' }),
    ev({ kind: 'opted_out', at: '2026-11-01T11:00:00Z' }),
    ev({ kind: 'converted', at: '2026-11-01T12:00:00Z' }),
    ev({ kind: 'call_completed', at: '2026-11-01T13:00:00Z' }),
  ];
  const r = buildCampaignResponses({ companyId: CO_A, events });
  assert.equal(r.items.length, 4);
  for (const item of r.items) {
    if (item.kind === 'reply') assert.ok(item.suggestedAction);
    else assert.equal('suggestedAction' in item, false, item.kind);
  }
});

test('items are newest first and unknown times sort last as unknown', () => {
  const events = [
    ev({ kind: 'replied', at: '2026-11-01T08:00:00Z' }),
    ev({ kind: 'converted', at: 'not-a-date' }),
    ev({ kind: 'opted_out', at: '2026-11-01T12:00:00Z' }),
    ev({ kind: 'call_completed', at: undefined }),
  ];
  const r = buildCampaignResponses({ companyId: CO_A, events });
  assert.deepEqual(
    r.items.map((i) => i.kind),
    ['opt_out', 'reply', 'converted', 'call_completed'],
  );
  assert.equal(r.items[2].createdAt, 'unknown');
  assert.equal(r.items[3].createdAt, 'unknown');
});

test('other company events are excluded', () => {
  const events = [ev({ companyId: CO_B, kind: 'replied' }), ev({ companyId: CO_A, kind: 'replied' })];
  const r = buildCampaignResponses({ companyId: CO_A, events });
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].id.endsWith('-1'), true);
});

test('limit caps the number of items, newest kept', () => {
  const events = Array.from({ length: 10 }, (_, i) =>
    ev({ kind: 'replied', at: `2026-11-01T0${i}:00:00Z` }),
  );
  const r = buildCampaignResponses({ companyId: CO_A, events, limit: 3 });
  assert.equal(r.items.length, 3);
  assert.equal(r.items[0].createdAt, '2026-11-01T09:00:00.000Z');
  assert.equal(r.items[2].createdAt, '2026-11-01T07:00:00.000Z');
});

test('default limit is 50', () => {
  const events = Array.from({ length: 60 }, (_, i) => ev({ kind: 'converted', at: 1_700_000_000_000 + i * 1000 }));
  const r = buildCampaignResponses({ companyId: CO_A, events });
  assert.equal(r.items.length, 50);
});

test('invalid company is refused', () => {
  for (const companyId of ['not-a-uuid', '', undefined, 42]) {
    const r = buildCampaignResponses({ companyId, events: [ev({ kind: 'replied' })] });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_company');
  }
});

test('no contact address appears in any text of the JSON output', () => {
  const events = [
    { ...ev({ kind: 'replied' }), address: ADDRESS, contact: { email: ADDRESS, phone: PHONE_ADDRESS } },
    { ...ev({ kind: 'opted_out', channel: 'sms' }), address: PHONE_ADDRESS },
    { ...ev({ kind: 'converted', channel: 'email' }), address: ADDRESS },
    { ...ev({ kind: 'call_completed', channel: 'phone' }), address: PHONE_ADDRESS },
  ];
  const r = buildCampaignResponses({ companyId: CO_A, events });
  const json = JSON.stringify(r);
  assert.equal(json.includes(ADDRESS), false);
  assert.equal(json.includes(PHONE_ADDRESS), false);
  assert.equal(r.items.length, 4);
});

test('channel-level and campaign-level outcomes are separate fields with their own counts', () => {
  const events = [
    ev({ kind: 'replied', channel: 'email', campaignId: 'camp-a' }),
    ev({ kind: 'replied', channel: 'sms', campaignId: 'camp-a' }),
    ev({ kind: 'call_completed', channel: 'phone', campaignId: 'camp-a' }),
    ev({ kind: 'opted_out', channel: 'email', campaignId: 'camp-b' }),
    ev({ kind: 'converted', channel: 'email', campaignId: 'camp-b' }),
    ev({ kind: 'sent', channel: 'email', campaignId: 'camp-b' }),
    ev({ kind: 'replied', channel: 'email', companyId: CO_B }),
  ];
  const r = buildCampaignResponses({ companyId: CO_A, events, limit: 1 });
  assert.equal(r.ok, true);
  // The limit applies to the event feed only.
  assert.equal(r.items.length, 1);
  assert.deepEqual(r.channelOutcomes, [
    { channel: 'email', counts: { replies: 1, optOuts: 1, conversions: 1, callsCompleted: 0 } },
    { channel: 'phone', counts: { replies: 0, optOuts: 0, conversions: 0, callsCompleted: 1 } },
    { channel: 'sms', counts: { replies: 1, optOuts: 0, conversions: 0, callsCompleted: 0 } },
  ]);
  assert.deepEqual(r.campaignOutcomes, [
    { campaignId: 'camp-a', counts: { replies: 2, optOuts: 0, conversions: 0, callsCompleted: 1 } },
    { campaignId: 'camp-b', counts: { replies: 0, optOuts: 1, conversions: 1, callsCompleted: 0 } },
  ]);
});

test('outcome rows never mix the two scopes', () => {
  const r = buildCampaignResponses({ companyId: CO_A, events: [ev({ kind: 'replied' })] });
  for (const row of r.channelOutcomes) assert.equal('campaignId' in row, false);
  for (const row of r.campaignOutcomes) assert.equal('channel' in row, false);
});
