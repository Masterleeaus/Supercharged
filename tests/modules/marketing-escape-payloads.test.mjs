// Escaping proof for every user-authored field in the landing page renderer. node:test, no I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLandingPage } from '../../server/modules/marketing/page-render.ts';

// Silence any output from server code so the test runner IPC stays clean.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const COMPANY = '11111111-1111-4111-8111-111111111111';
const SAFE_URL = 'https://client.example/book';

const PAYLOADS = [
  '<script>alert(1)</script>',
  '"><img src=x onerror=alert(1)>',
  "' autofocus onfocus='alert(1)",
  '</title><script>alert(1)</script>',
  '</a><svg onload=alert(1)>',
  '&lt;script&gt; &amp; "quoted" \'single\'',
];

function base(overrides = {}) {
  return {
    title: 'Spring clean',
    headline: 'Book a spring clean',
    body: 'Two-hour visit.',
    ctaText: 'Book now',
    ctaUrl: SAFE_URL,
    companyId: COMPANY,
    ...overrides,
  };
}

function renderOk(overrides) {
  const result = renderLandingPage(base(overrides));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.html;
}

function assertNoActiveMarkup(html) {
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.doesNotMatch(html, /<svg/i);
  assert.doesNotMatch(html, /<iframe/i);
  assert.doesNotMatch(html, /<object/i);
  assert.doesNotMatch(html, /<embed/i);
  // No event handler attribute on any real tag. Escaped text such as "onfocus=" is inert text and is allowed.
  assert.doesNotMatch(html, /<[a-z][^>]*\son[a-z]+\s*=/i);
}

for (const payload of PAYLOADS) {
  test(`title payload ${JSON.stringify(payload)} stays inert`, () => {
    assertNoActiveMarkup(renderOk({ title: payload }));
  });

  test(`headline payload ${JSON.stringify(payload)} stays inert`, () => {
    assertNoActiveMarkup(renderOk({ headline: payload }));
  });

  test(`body payload ${JSON.stringify(payload)} stays inert`, () => {
    assertNoActiveMarkup(renderOk({ body: `Intro.\n\n${payload}\n\nEnd.` }));
  });

  test(`ctaText payload ${JSON.stringify(payload)} stays inert`, () => {
    assertNoActiveMarkup(renderOk({ ctaText: payload }));
  });
}

test('a script payload in the title is escaped inside the title element', () => {
  const html = renderOk({ title: '</title><script>alert(1)</script>' });
  assert.match(html, /<title>&lt;\/title&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/title>/);
});

test('an attribute breakout in headline does not create an attribute or element', () => {
  const html = renderOk({ headline: '"><img src=x onerror=alert(1)>' });
  assert.match(html, /<h1>&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;<\/h1>/);
});

test('a single-quote breakout in ctaText keeps the link text as one text node', () => {
  const html = renderOk({ ctaText: "' autofocus onfocus='alert(1)" });
  const link = html.match(/<a class="cta" href="[^"]*">([^<]*)<\/a>/);
  assert.ok(link, 'the CTA link must be a single anchor with plain text');
  assert.equal(link[1], '&#39; autofocus onfocus=&#39;alert(1)');
});

test('a quote breakout in the CTA URL cannot close the href attribute', () => {
  // No whitespace, so the URL passes the safety check and reaches the attribute escaper.
  const html = renderOk({ ctaUrl: `${SAFE_URL}"onmouseover="alert(1)` });
  const link = html.match(/<a class="cta" href="([^"]*)">/);
  assert.ok(link, 'href must be one quoted attribute');
  assert.ok(link[1].includes('&quot;'), 'the quote in the URL must be escaped');
  assert.doesNotMatch(html, /<[a-z][^>]*\sonmouseover/i);
});

test('a CTA URL containing whitespace is refused, so no breakout can be attempted through spacing', () => {
  const result = renderLandingPage(base({ ctaUrl: `${SAFE_URL}" onmouseover="alert(1)` }));
  assert.deepEqual(result, { ok: false, reason: 'unsafe_url' });
});

test('an ampersand in the body is escaped, not left as a raw entity', () => {
  const html = renderOk({ body: '&lt;script&gt;' });
  assert.ok(html.includes('&amp;lt;script&amp;gt;'));
});

test('exactly one anchor and one h1 are emitted for a hostile page', () => {
  const html = renderOk({
    headline: '</h1><a href="https://evil.example">x</a>',
    body: '</p><script>alert(1)</script>',
    ctaText: '</a><a href="https://evil.example">y</a>',
    ctaUrl: `${SAFE_URL}?q="><a>`,
  });
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.equal((html.match(/<h1>/g) ?? []).length, 1);
});

test('a payload with a javascript: CTA is refused before any markup is built', () => {
  const result = renderLandingPage(base({ ctaUrl: 'javascript:alert(1)<script>' }));
  assert.deepEqual(result, { ok: false, reason: 'unsafe_url' });
});
