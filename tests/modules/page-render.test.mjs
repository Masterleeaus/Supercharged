import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderLandingPage,
  escapeHtml,
  isSafeCtaUrl,
  LANDING_PAGE_LIMITS,
} from '../../server/modules/marketing/page-render.ts';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const GOOD_URL = 'https://client.example/book?ref=spring&size=2';

function input(overrides = {}) {
  return {
    title: 'Spring clean',
    headline: 'Book a spring clean',
    body: 'Two-hour visit.\n\nBring nothing.',
    ctaText: 'Book now',
    ctaUrl: GOOD_URL,
    companyId: COMPANY,
    ...overrides,
  };
}

function render(overrides) {
  const result = renderLandingPage(input(overrides));
  assert.equal(result.ok, true, `expected ok, got ${JSON.stringify(result)}`);
  return result.html;
}

// Escaping

test('escapeHtml converts each special character', () => {
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('"'), '&quot;');
  assert.equal(escapeHtml("'"), '&#39;');
});

test('escapeHtml escapes ampersand first so entities are not double-decoded', () => {
  assert.equal(escapeHtml('<&>'), '&lt;&amp;&gt;');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('title is escaped in the title element', () => {
  const html = render({ title: `a&b<c>d"e'f` });
  assert.match(html, /<title>a&amp;b&lt;c&gt;d&quot;e&#39;f<\/title>/);
});

test('headline is escaped in the h1 element', () => {
  const html = render({ headline: `x&y<z>"q"'r'` });
  assert.match(html, /<h1>x&amp;y&lt;z&gt;&quot;q&quot;&#39;r&#39;<\/h1>/);
});

test('body is escaped in paragraphs', () => {
  const html = render({ body: `5 < 6 & "quoted" 'single' > 2` });
  assert.match(html, /<p>5 &lt; 6 &amp; &quot;quoted&quot; &#39;single&#39; &gt; 2<\/p>/);
});

test('ctaText is escaped in the link text', () => {
  const html = render({ ctaText: `<b>Go & "run"</b>` });
  assert.match(html, />&lt;b&gt;Go &amp; &quot;run&quot;&lt;\/b&gt;<\/a>/);
});

test('ctaUrl is escaped in the href attribute', () => {
  const html = render({ ctaUrl: 'https://client.example/?a=1&b=2' });
  assert.match(html, /href="https:\/\/client\.example\/\?a=1&amp;b=2"/);
});

// Script injection and attribute breakout

test('a script tag in the headline is inert text', () => {
  const html = render({ headline: '<script>alert(1)</script>Hi' });
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;Hi'));
  assert.doesNotMatch(html, /<script/i);
});

test('an attribute breakout in ctaText cannot add an attribute', () => {
  const html = render({ ctaText: '" onmouseover="alert(1)' });
  assert.doesNotMatch(html, /onmouseover="/);
  assert.ok(html.includes('&quot; onmouseover=&quot;alert(1)'));
});

test('an attribute breakout in ctaUrl cannot close the href', () => {
  // The query carries a quote and angle brackets. No whitespace, so the URL
  // passes the policy and the escaping is what keeps it inside the href.
  const html = render({ ctaUrl: 'https://client.example/?x="><script>alert(1)</script>' });
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /href="https:\/\/client\.example\/\?x="/);
  assert.match(html, /href="https:\/\/client\.example\/\?x=&quot;&gt;&lt;script&gt;/);
});

test('a fully hostile input with a relative CTA is refused, so no page is produced', () => {
  // Relative CTA URLs are refused, so no HTML is produced and no script element can appear.
  const result = renderLandingPage(
    input({
      title: '<script>1</script>',
      headline: '<SCRIPT>2</SCRIPT>',
      body: '<script src="x"></script>',
      ctaText: '<script>3</script>',
      ctaUrl: '/x?<script>',
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsafe_url');
  assert.equal(result.html, undefined);
});

test('a hostile headline is escaped and the page has no script element', () => {
  const html = render({
    title: '<script>1</script>',
    headline: '<SCRIPT>2</SCRIPT>',
    body: '<script src="x"></script>',
    ctaText: '<script>3</script>',
  });
  assert.match(html, /<h1>&lt;SCRIPT&gt;2&lt;\/SCRIPT&gt;<\/h1>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<\/script/i);
});

test('output has no script element for normal input', () => {
  assert.doesNotMatch(render(), /<script/i);
});

test('output is a complete document with charset and viewport', () => {
  const html = render();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta charset="utf-8">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<\/html>\s*$/);
});

test('output has no external resources', () => {
  const html = render();
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<img\b/i);
  assert.doesNotMatch(html, /\bsrc=/i);
  assert.doesNotMatch(html, /@import/i);
  assert.doesNotMatch(html, /url\(/i);
});

test('output has no inline event handler attributes', () => {
  assert.doesNotMatch(render(), /\son[a-z]+\s*=/i);
});

// CTA URL policy

test('https absolute URL is accepted', () => {
  assert.equal(isSafeCtaUrl('https://client.example'), true);
  assert.equal(isSafeCtaUrl(GOOD_URL), true);
});

test('javascript: URL is refused', () => {
  assert.deepEqual(renderLandingPage(input({ ctaUrl: 'javascript:alert(1)' })), {
    ok: false,
    reason: 'unsafe_url',
  });
});

test('javascript: URL with mixed case is refused', () => {
  assert.equal(renderLandingPage(input({ ctaUrl: 'JaVaScRiPt:alert(1)' })).reason, 'unsafe_url');
});

test('javascript: URL with an embedded tab is refused', () => {
  assert.equal(renderLandingPage(input({ ctaUrl: 'java\tscript:alert(1)' })).reason, 'unsafe_url');
});

test('data: URL is refused', () => {
  assert.equal(
    renderLandingPage(input({ ctaUrl: 'data:text/html,<script>alert(1)</script>' })).reason,
    'unsafe_url',
  );
});

test('vbscript: URL is refused', () => {
  assert.equal(renderLandingPage(input({ ctaUrl: 'vbscript:msgbox(1)' })).reason, 'unsafe_url');
});

test('http URL is refused', () => {
  assert.equal(renderLandingPage(input({ ctaUrl: 'http://client.example' })).reason, 'unsafe_url');
});

test('protocol-relative URL is refused', () => {
  assert.equal(renderLandingPage(input({ ctaUrl: '//evil.example/x' })).reason, 'unsafe_url');
});

test('backslash form of protocol-relative URL is refused', () => {
  assert.equal(renderLandingPage(input({ ctaUrl: '/\\evil.example' })).reason, 'unsafe_url');
});

test('relative path starting with a single slash is refused', () => {
  assert.equal(isSafeCtaUrl('/book'), false);
  assert.deepEqual(renderLandingPage(input({ ctaUrl: '/book?x=1' })), {
    ok: false,
    reason: 'unsafe_url',
  });
});

test('bare relative path without a leading slash is refused', () => {
  assert.equal(renderLandingPage(input({ ctaUrl: 'book' })).reason, 'unsafe_url');
});

test('empty ctaUrl is refused', () => {
  assert.equal(renderLandingPage(input({ ctaUrl: '' })).reason, 'unsafe_url');
});

test('URL with leading whitespace is refused', () => {
  assert.equal(renderLandingPage(input({ ctaUrl: ' https://client.example' })).reason, 'unsafe_url');
});

test('URL with a newline is refused', () => {
  assert.equal(renderLandingPage(input({ ctaUrl: 'https://client.example\n' })).reason, 'unsafe_url');
});

// Length limits

test('each field accepts exactly its limit', () => {
  const result = renderLandingPage(
    input({
      title: 'a'.repeat(LANDING_PAGE_LIMITS.title),
      headline: 'a'.repeat(LANDING_PAGE_LIMITS.headline),
      body: 'a'.repeat(LANDING_PAGE_LIMITS.body),
      ctaText: 'a'.repeat(LANDING_PAGE_LIMITS.ctaText),
    }),
  );
  assert.equal(result.ok, true);
});

test('title over 120 characters is refused', () => {
  assert.equal(renderLandingPage(input({ title: 'a'.repeat(121) })).reason, 'too_long');
});

test('headline over 200 characters is refused', () => {
  assert.equal(renderLandingPage(input({ headline: 'a'.repeat(201) })).reason, 'too_long');
});

test('body over 5000 characters is refused', () => {
  assert.equal(renderLandingPage(input({ body: 'a'.repeat(5001) })).reason, 'too_long');
});

test('ctaText over 40 characters is refused', () => {
  assert.equal(renderLandingPage(input({ ctaText: 'a'.repeat(41) })).reason, 'too_long');
});

test('length is counted in characters, not UTF-16 code units', () => {
  // Each emoji is one character but two UTF-16 code units.
  assert.equal(renderLandingPage(input({ ctaText: '\u{1F600}'.repeat(40) })).ok, true);
  assert.equal(renderLandingPage(input({ ctaText: '\u{1F600}'.repeat(41) })).reason, 'too_long');
});

test('length is checked on the raw value, before escaping', () => {
  // Escaping would expand this past 120 characters, but the limit applies to the input.
  assert.equal(renderLandingPage(input({ title: '<'.repeat(120) })).ok, true);
  assert.equal(renderLandingPage(input({ title: '<'.repeat(121) })).reason, 'too_long');
});

// Company id

test('a valid UUID company id is accepted', () => {
  assert.equal(renderLandingPage(input({ companyId: COMPANY })).ok, true);
});

test('a non-UUID company id is refused', () => {
  assert.equal(renderLandingPage(input({ companyId: 'acme' })).reason, 'invalid_company');
});

test('an empty company id is refused', () => {
  assert.equal(renderLandingPage(input({ companyId: '' })).reason, 'invalid_company');
});

test('a UUID with a stray character is refused', () => {
  assert.equal(
    renderLandingPage(input({ companyId: `${COMPANY}<` })).reason,
    'invalid_company',
  );
});

test('a company id containing HTML is refused', () => {
  assert.equal(
    renderLandingPage(input({ companyId: '"><script>alert(1)</script>' })).reason,
    'invalid_company',
  );
});

// Input shape

test('non-string fields are refused as invalid_input', () => {
  assert.equal(renderLandingPage(input({ title: 42 })).reason, 'invalid_input');
  assert.equal(renderLandingPage(input({ body: null })).reason, 'invalid_input');
});

test('a missing object is refused as invalid_input', () => {
  assert.equal(renderLandingPage(null).reason, 'invalid_input');
});
