import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLandingPage } from '../../server/modules/marketing/page-render.ts';

const COMPANY = '11111111-1111-4111-8111-111111111111';

function input(overrides = {}) {
  return {
    title: 'Spring clean',
    headline: 'Book a spring clean',
    body: 'Two-hour visit.',
    ctaText: 'Book now',
    ctaUrl: 'https://client.example/book',
    companyId: COMPANY,
    ...overrides,
  };
}

test('a script tag in the headline is escaped, not emitted', () => {
  const result = renderLandingPage(input({ headline: '<script>alert(1)</script>Hi' }));
  assert.equal(result.ok, true);
  assert.ok(result.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;Hi'));
  assert.doesNotMatch(result.html, /<script/i);
});

test('a javascript: CTA is refused', () => {
  assert.deepEqual(renderLandingPage(input({ ctaUrl: 'javascript:alert(1)' })), {
    ok: false,
    reason: 'unsafe_url',
  });
});

test('an http: CTA is refused', () => {
  assert.deepEqual(renderLandingPage(input({ ctaUrl: 'http://client.example/book' })), {
    ok: false,
    reason: 'unsafe_url',
  });
});

test('an https: CTA is accepted', () => {
  assert.equal(renderLandingPage(input({ ctaUrl: 'https://client.example/book' })).ok, true);
});
