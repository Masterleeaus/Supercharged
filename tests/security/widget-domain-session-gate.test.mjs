import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { widgetRequestDomain, isWidgetDomainAllowed } from '../../server/modules/widget/domain-gate.ts';

// Browser origin/referer is a defence-in-depth allowlist, not a cryptographic
// client authentication mechanism. Direct API callers can forge these headers.
const allow = ['example.com', '*.trusted.example'];

test('valid HTTPS Origin and Referer produce the actual browser page hostname', () => {
  assert.equal(widgetRequestDomain({ origin: 'https://www.example.com:443' }), 'www.example.com');
  assert.equal(widgetRequestDomain({ referer: 'https://shop.example.com/checkout?ref=test' }), 'shop.example.com');
  assert.equal(widgetRequestDomain({ origin: 'https://SHOP.example.com' }), 'shop.example.com');
});

test('a configured allowlist fails closed when Origin and Referer are absent', () => {
  assert.equal(widgetRequestDomain({}), '');
  assert.equal(isWidgetDomainAllowed(allow, widgetRequestDomain({})), false);
  assert.equal(isWidgetDomainAllowed([], widgetRequestDomain({})), true);
  assert.equal(isWidgetDomainAllowed(null, widgetRequestDomain({})), true);
});

test('malformed, null, file and credential-bearing Origin are never treated as a trusted domain', () => {
  for (const origin of ['null', 'example.com', 'not a url', 'file:///etc/passwd', 'https://evil@www.example.com']) {
    assert.equal(widgetRequestDomain({ origin }), '', origin);
    assert.equal(isWidgetDomainAllowed(allow, widgetRequestDomain({ origin })), false, origin);
  }
  assert.equal(widgetRequestDomain({ origin: 'null', referer: 'https://www.example.com/a' }), '');
});

test('exact, www and wildcard allowed domains match without suffix-lookalike bypass', () => {
  for (const hostname of ['example.com', 'www.example.com', 'tools.trusted.example', 'trusted.example']) {
    assert.equal(isWidgetDomainAllowed(allow, hostname), true, hostname);
  }
  for (const hostname of ['evil-example.com', 'example.com.evil.net', 'untrusted.example', 'example.org']) {
    assert.equal(isWidgetDomainAllowed(allow, hostname), false, hostname);
  }
});

test('session/start checks header-derived origin before credit or token allocation', () => {
  const src = readFileSync(new URL('../../server/modules/widget/public-widget-routes.ts', import.meta.url), 'utf8');
  const start = src.indexOf("router.post('/widget/session/start'");
  const end = src.indexOf("router.post('/widget/session/:sessionId/connect'", start);
  assert.ok(start >= 0 && end > start);
  const handler = src.slice(start, end);
  const check = handler.indexOf('!isWidgetDomainAllowed(widget.allowedDomains, requestDomain)');
  assert.ok(check >= 0, 'session must check the configured allowlist even with no Origin/Referer');
  assert.ok(handler.includes('widgetRequestDomain(req.headers)'), 'domain derived from headers');
  assert.ok(check < handler.indexOf('widgetService.checkUserCredits'), 'reject before credit checks');
  assert.ok(check < handler.indexOf('widgetStorage.createSession'), 'reject before any session write');
  assert.ok(handler.includes("typeof visitorDomain !== 'string'"), 'reject malformed client-provided visitor domains');
  assert.ok(handler.includes('visitorDomain: requestDomain || claimedDomain || null'), 'persist validated browser origin first');
  assert.ok(!handler.includes('if (visitorDomain && !widgetService.validateDomain'), 'old bypass removed');
});
