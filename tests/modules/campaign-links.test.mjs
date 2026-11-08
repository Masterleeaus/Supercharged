// Campaign link rewriting: every https link in a campaign message gets campaign and source
// tracking at send time. Node test runner, pure functions only: no network, no database.
const silence = () => {};
console.log = silence;
console.info = silence;
console.warn = silence;
console.debug = silence;

import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteCampaignLinks } from '../../server/modules/campaigns/campaign-links.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = 'camp-spring-2026';
const CTX = { companyId: CO, campaignId: CAMPAIGN, channel: 'email' };

function queryOf(url) {
  return new URL(url).searchParams;
}

test('one https link is rewritten and carries utm_campaign equal to the campaign id', () => {
  const result = rewriteCampaignLinks({
    text: 'Book here: https://example.com/quote',
    baseContext: CTX,
  });
  assert.equal(result.ok, true);
  assert.ok(result.text.startsWith('Book here: https://example.com/quote?'));
  const link = result.text.slice('Book here: '.length);
  assert.equal(queryOf(link).get('utm_campaign'), CAMPAIGN);
  assert.equal(queryOf(link).get('utm_medium'), 'email');
  assert.equal(queryOf(link).get('utm_source'), 'email');
  assert.match(queryOf(link).get('tid'), /^[0-9a-f]{16}$/);
});

test('an explicit source is used as utm_source', () => {
  const result = rewriteCampaignLinks({
    text: 'https://example.com/',
    baseContext: { ...CTX, source: 'newsletter' },
  });
  assert.equal(result.ok, true);
  assert.equal(queryOf(result.text).get('utm_source'), 'newsletter');
});

test('trailing sentence punctuation stays outside the rewritten link', () => {
  const result = rewriteCampaignLinks({
    text: 'See https://example.com/a.',
    baseContext: CTX,
  });
  assert.equal(result.ok, true);
  assert.ok(result.text.endsWith('.'));
  assert.equal(queryOf(result.text.slice('See '.length, -1)).get('utm_campaign'), CAMPAIGN);
});

test('an http link is refused with a generic reason and no URL in the result', () => {
  const result = rewriteCampaignLinks({
    text: 'Plain link http://example.com/secret-path here',
    baseContext: CTX,
  });
  assert.deepEqual(result, { ok: false, reason: 'unsafe_link' });
  assert.equal(JSON.stringify(result).includes('example.com'), false);
});

test('a message with one https link and one http link is refused as a whole', () => {
  const result = rewriteCampaignLinks({
    text: 'Good https://example.com/ and bad http://example.org/',
    baseContext: CTX,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsafe_link');
});

test('a text with no links is unchanged', () => {
  const text = 'Hello there. Nothing to link today.';
  assert.deepEqual(rewriteCampaignLinks({ text, baseContext: CTX }), { ok: true, text });
});

test('a missing companyId is refused', () => {
  const result = rewriteCampaignLinks({
    text: 'https://example.com/',
    baseContext: { campaignId: CAMPAIGN, channel: 'email' },
  });
  assert.deepEqual(result, { ok: false, reason: 'invalid_input' });
});

test('a missing companyId is refused even when the text has no links', () => {
  const result = rewriteCampaignLinks({
    text: 'No links',
    baseContext: { campaignId: CAMPAIGN, channel: 'email' },
  });
  assert.deepEqual(result, { ok: false, reason: 'invalid_input' });
});
