/**
 * Safe rendering checks for the public marketing landing page (server/modules/marketing/page-render.ts).
 *
 * Pure function, no I/O. Fake content only. For each hostile input the checks are:
 *   - script tags, attribute breakouts and event-handler text in title, headline, body and CTA text are escaped
 *     and do not appear as markup in the output
 *   - CTA URLs that are not absolute https are refused with unsafe_url (javascript:, data:, relative, protocol-relative,
 *     http:, whitespace or control characters, backslashes)
 *   - the output has no script element and no inline event-handler attribute
 *
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/security/public-marketing-routes.test.mjs
 */
for (const method of ['log', 'info', 'warn', 'error']) console[method] = () => {};

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderLandingPage } from '../../server/modules/marketing/page-render.ts';

const COMPANY_ID = '11111111-2222-4333-8444-555555555555';
const SAFE_URL = 'https://example.com/book';

function baseInput(overrides = {}) {
  return {
    title: 'Spring Clean',
    headline: 'Book a clean',
    body: 'Plain text.',
    ctaText: 'Book now',
    ctaUrl: SAFE_URL,
    companyId: COMPANY_ID,
    ...overrides,
  };
}

const HOSTILE_TEXT = [
  '<script>alert(1)</script>',
  '<SCRIPT SRC=//e.x/a.js></SCRIPT>',
  '"><script>alert(1)</script>',
  "' onmouseover='alert(1)' x='",
  '" onfocus="alert(1)" autofocus="',
  '<img src=x onerror=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '</title><script>alert(1)</script><title>',
  '</p></main><script>alert(1)</script>',
  '&lt;script&gt; &amp; &quot;',
];

// Assert the rendered HTML carries no script element, no inline event handler, and no raw breakout from the input.
function assertNoActiveMarkup(html) {
  assert.doesNotMatch(html, /<script/i, 'output contains a script element');
  assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i, 'output contains an inline event handler attribute');
  assert.doesNotMatch(html, /<img\b/i, 'output contains an injected img element');
  assert.doesNotMatch(html, /<a\s+href="javascript:/i, 'output contains a javascript: link');
}

test('hostile text in every user-authored field is escaped and produces no active markup', () => {
  for (const payload of HOSTILE_TEXT) {
    const result = renderLandingPage(
      baseInput({ title: payload, headline: payload, body: payload, ctaText: payload }),
    );
    assert.equal(result.ok, true, `render should succeed for payload: ${payload}`);
    assertNoActiveMarkup(result.html);
    // The raw payload must never appear in the output; it may only appear escaped.
    assert.ok(!result.html.includes(payload), `raw payload found in output: ${payload}`);
  }
});

test('title breakout stays inside the title element', () => {
  const result = renderLandingPage(baseInput({ title: '</title><script>alert(1)</script><title>' }));
  assert.equal(result.ok, true);
  assert.ok(result.html.includes('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;title&gt;</title>'));
});

test('attribute breakout in CTA text cannot add an attribute to the link', () => {
  const result = renderLandingPage(baseInput({ ctaText: '" onclick="alert(1)" x="' }));
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.html, /onclick="alert/i);
  assert.ok(result.html.includes('&quot; onclick=&quot;alert(1)&quot; x=&quot;'));
});

test('single-quote breakout in text is escaped', () => {
  const result = renderLandingPage(baseInput({ headline: "' onmouseover='alert(1)" }));
  assert.equal(result.ok, true);
  assert.ok(result.html.includes('&#39; onmouseover=&#39;alert(1)'));
});

test('body text cannot close the paragraph and inject markup', () => {
  const result = renderLandingPage(baseInput({ body: 'Hi\n\n</p><script>alert(1)</script>' }));
  assert.equal(result.ok, true);
  assertNoActiveMarkup(result.html);
});

test('CTA links that are not absolute https are refused', () => {
  const unsafe = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'http://example.com/book',
    'HTTP://example.com/book',
    '//evil.example/x',
    '/book',
    'book',
    '../book',
    '?x=1',
    '#top',
    'https:',
    'https://',
    'https:\\\\example.com',
    '\\\\evil.example\\x',
    'https://example.com/\u0000',
    'https://example.com/\u007f',
    'https://example.com/ book',
    'https://example.com/ x',
    '',
  ];
  for (const url of unsafe) {
    const result = renderLandingPage(baseInput({ ctaUrl: url }));
    assert.deepEqual(result, { ok: false, reason: 'unsafe_url' }, `should refuse CTA url: ${JSON.stringify(url)}`);
  }
});

test('an https CTA with quotes and markup characters is accepted and its href stays quoted', () => {
  const url = 'https://example.com/a?x="><script>alert(1)</script>&y=\'1\'';
  const result = renderLandingPage(baseInput({ ctaUrl: url }));
  assert.equal(result.ok, true);
  assertNoActiveMarkup(result.html);
  const href = result.html.match(/<a class="cta" href="([^"]*)"/);
  assert.ok(href, 'CTA anchor should have a single quoted href');
  assert.ok(!href[1].includes('"'), 'href value must not contain a raw double quote');
  assert.ok(!href[1].includes('<'), 'href value must not contain a raw less-than');
});

test('output has no script element and no inline event handler for a fully hostile page', () => {
  const result = renderLandingPage(
    baseInput({
      title: '<script>x</script>',
      headline: '<img src=x onerror=alert(1)>',
      body: '<svg onload=alert(1)>',
      ctaText: '<a onclick=alert(1)>go</a>',
      ctaUrl: 'https://example.com/?q=<script>',
    }),
  );
  assert.equal(result.ok, true);
  assertNoActiveMarkup(result.html);
  assert.doesNotMatch(result.html, /<svg/i);
  assert.doesNotMatch(result.html, /<\s*a\s+onclick/i);
});

test('https:/host (single slash) parses as absolute https and is accepted, not treated as relative', () => {
  const result = renderLandingPage(baseInput({ ctaUrl: 'https:/example.com' }));
  assert.equal(result.ok, true);
  assertNoActiveMarkup(result.html);
});
