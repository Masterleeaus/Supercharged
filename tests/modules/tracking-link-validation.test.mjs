// Validation of tracking link fields and of parsed links. node:test, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackingLink, parseTrackingLink } from '../../server/modules/marketing/tracking-links.ts';

// Silence any output from server code so the test runner IPC stays clean.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const CO = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://example.com/landing';

function build(overrides = {}) {
  return buildTrackingLink({ baseUrl: BASE, companyId: CO, campaignId: 'camp-1', channel: 'email', ...overrides });
}

test('a built link carries the campaign id as utm_campaign and the source as utm_source', () => {
  const r = build({ campaignId: 'camp-1', source: 'newsletter' });
  assert.equal(r.ok, true);
  const u = new URL(r.url);
  assert.equal(u.searchParams.get('utm_campaign'), 'camp-1');
  assert.equal(u.searchParams.get('utm_source'), 'newsletter');
  assert.equal(u.searchParams.get('utm_medium'), 'email');
});

test('a campaign id with a control character is refused as invalid_campaign', () => {
  assert.deepEqual(build({ campaignId: 'camp\u00011' }), { ok: false, reason: 'invalid_campaign' });
  assert.deepEqual(build({ campaignId: 'camp\n1' }), { ok: false, reason: 'invalid_campaign' });
});

test('a campaign id longer than 200 characters is refused as invalid_campaign', () => {
  assert.deepEqual(build({ campaignId: 'x'.repeat(201) }), { ok: false, reason: 'invalid_campaign' });
  assert.equal(build({ campaignId: 'x'.repeat(200) }).ok, true);
});

test('a campaign id that is only spaces is refused as missing_field', () => {
  assert.deepEqual(build({ campaignId: '   ' }), { ok: false, reason: 'missing_field' });
});

test('a channel with uppercase, spaces or symbols is refused as invalid_channel', () => {
  for (const channel of ['Email', 'sms gateway', 'email&x=1', '1sms', '']) {
    const r = build({ channel });
    assert.equal(r.ok, false, channel);
    assert.ok(['invalid_channel', 'missing_field'].includes(r.reason), `${channel}: ${r.reason}`);
  }
});

test('a source with a control character is refused as invalid_source', () => {
  assert.deepEqual(build({ source: 'news\u0000letter' }), { ok: false, reason: 'invalid_source' });
});

test('a source longer than 100 characters is refused as invalid_source', () => {
  assert.deepEqual(build({ source: 's'.repeat(101) }), { ok: false, reason: 'invalid_source' });
});

test('a non-string source is refused as invalid_source rather than silently replaced', () => {
  assert.deepEqual(build({ source: 42 }), { ok: false, reason: 'invalid_source' });
  assert.deepEqual(build({ source: ['a'] }), { ok: false, reason: 'invalid_source' });
});

test('a blank or null source falls back to the channel', () => {
  assert.equal(new URL(build({ source: '  ' }).url).searchParams.get('utm_source'), 'email');
  assert.equal(new URL(build({ source: null }).url).searchParams.get('utm_source'), 'email');
});

test('parse refuses a link with a duplicated utm_campaign', () => {
  const built = build({ campaignId: 'camp-1' });
  const forged = `${built.url}&utm_campaign=other`;
  assert.deepEqual(parseTrackingLink(forged), { ok: false, reason: 'not_tracking_link' });
});

test('parse refuses a link with a duplicated utm_source', () => {
  const built = build({ source: 'newsletter' });
  assert.deepEqual(parseTrackingLink(`${built.url}&utm_source=evil`), { ok: false, reason: 'not_tracking_link' });
});

test('parse refuses a link whose tid is not 16 hex characters', () => {
  assert.deepEqual(parseTrackingLink(`${BASE}?utm_medium=email&utm_campaign=c1&tid=xyz`), {
    ok: false,
    reason: 'not_tracking_link',
  });
});

test('parse refuses a link whose campaign has a control character', () => {
  const built = build({ campaignId: 'camp-1' });
  const bad = built.url.replace('utm_campaign=camp-1', 'utm_campaign=camp%0A1');
  assert.deepEqual(parseTrackingLink(bad), { ok: false, reason: 'not_tracking_link' });
});
