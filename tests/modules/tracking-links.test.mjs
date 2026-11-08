// Tracking link tests (node:test). Pure functions, no network, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackingLink, parseTrackingLink } from '../../server/modules/marketing/tracking-links.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://example.com/landing';

test('parameters are present and URL-encoded', () => {
  const r = buildTrackingLink({
    baseUrl: BASE,
    companyId: CO_A,
    campaignId: 'spring sale & more',
    channel: 'email',
    source: 'news/letter',
  });
  assert.equal(r.ok, true);
  const u = new URL(r.url);
  assert.equal(u.searchParams.get('utm_source'), 'news/letter');
  assert.equal(u.searchParams.get('utm_medium'), 'email');
  assert.equal(u.searchParams.get('utm_campaign'), 'spring sale & more');
  assert.match(u.searchParams.get('tid'), /^[0-9a-f]{16}$/);
  assert.ok(r.url.includes('utm_source=news%2Fletter'));
  assert.ok(r.url.includes('utm_campaign=spring%20sale%20%26%20more'));
});

test('source defaults to the channel when omitted', () => {
  const r = buildTrackingLink({ baseUrl: BASE, companyId: CO_A, campaignId: 'c1', channel: 'sms' });
  assert.equal(r.ok, true);
  assert.equal(new URL(r.url).searchParams.get('utm_source'), 'sms');
});

test('existing query and fragment are preserved', () => {
  const r = buildTrackingLink({
    baseUrl: 'https://example.com/p?ref=abc&lang=en#top',
    companyId: CO_A,
    campaignId: 'c1',
    channel: 'email',
  });
  assert.equal(r.ok, true);
  const u = new URL(r.url);
  assert.equal(u.searchParams.get('ref'), 'abc');
  assert.equal(u.searchParams.get('lang'), 'en');
  assert.equal(u.hash, '#top');
});

test('an existing utm_source is replaced, not duplicated', () => {
  const r = buildTrackingLink({
    baseUrl: 'https://example.com/?utm_source=old&utm_medium=x&q=1',
    companyId: CO_A,
    campaignId: 'c1',
    channel: 'email',
    source: 'new-source',
  });
  assert.equal(r.ok, true);
  const u = new URL(r.url);
  assert.deepEqual(u.searchParams.getAll('utm_source'), ['new-source']);
  assert.deepEqual(u.searchParams.getAll('utm_medium'), ['email']);
  assert.equal(u.searchParams.get('q'), '1');
});

test('same inputs give the same tid', () => {
  const input = { baseUrl: BASE, companyId: CO_A, campaignId: 'c1', channel: 'email', source: 's' };
  const a = buildTrackingLink(input);
  const b = buildTrackingLink({ ...input });
  assert.equal(a.ok, true);
  assert.equal(new URL(a.url).searchParams.get('tid'), new URL(b.url).searchParams.get('tid'));
});

test('different company gives a different tid', () => {
  const a = buildTrackingLink({ baseUrl: BASE, companyId: CO_A, campaignId: 'c1', channel: 'email' });
  const b = buildTrackingLink({ baseUrl: BASE, companyId: CO_B, campaignId: 'c1', channel: 'email' });
  assert.notEqual(new URL(a.url).searchParams.get('tid'), new URL(b.url).searchParams.get('tid'));
});

test('javascript:, http and malformed URLs are refused as unsafe_url', () => {
  for (const baseUrl of ['javascript:alert(1)', 'http://example.com/', 'ftp://example.com/', 'https://', 'not a url']) {
    assert.deepEqual(
      buildTrackingLink({ baseUrl, companyId: CO_A, campaignId: 'c1', channel: 'email' }),
      { ok: false, reason: 'unsafe_url' },
      baseUrl,
    );
  }
});

test('URLs with credentials are refused as unsafe_url', () => {
  for (const baseUrl of ['https://user:pass@example.com/', 'https://user@example.com/']) {
    assert.deepEqual(
      buildTrackingLink({ baseUrl, companyId: CO_A, campaignId: 'c1', channel: 'email' }),
      { ok: false, reason: 'unsafe_url' },
      baseUrl,
    );
  }
});

test('missing campaign, channel or company is refused as missing_field', () => {
  assert.deepEqual(
    buildTrackingLink({ baseUrl: BASE, companyId: CO_A, campaignId: '', channel: 'email' }),
    { ok: false, reason: 'missing_field' },
  );
  assert.deepEqual(
    buildTrackingLink({ baseUrl: BASE, companyId: CO_A, campaignId: 'c1' }),
    { ok: false, reason: 'missing_field' },
  );
  assert.deepEqual(
    buildTrackingLink({ baseUrl: BASE, companyId: undefined, campaignId: 'c1', channel: 'email' }),
    { ok: false, reason: 'missing_field' },
  );
});

test('a company id that is not a UUID is refused as invalid_company', () => {
  assert.deepEqual(
    buildTrackingLink({ baseUrl: BASE, companyId: 'acme', campaignId: 'c1', channel: 'email' }),
    { ok: false, reason: 'invalid_company' },
  );
});

test('parse reads back the attribution fields of a built link', () => {
  const built = buildTrackingLink({
    baseUrl: BASE,
    companyId: CO_A,
    campaignId: 'camp 42',
    channel: 'email',
    source: 'newsletter',
  });
  assert.equal(built.ok, true);
  const parsed = parseTrackingLink(built.url);
  assert.deepEqual(parsed, {
    ok: true,
    source: 'newsletter',
    medium: 'email',
    campaign: 'camp 42',
    tid: new URL(built.url).searchParams.get('tid'),
  });
});

test('a plain URL is not a tracking link', () => {
  assert.deepEqual(parseTrackingLink('https://example.com/landing?ref=abc'), {
    ok: false,
    reason: 'not_tracking_link',
  });
  assert.deepEqual(parseTrackingLink('not a url'), { ok: false, reason: 'not_tracking_link' });
});
