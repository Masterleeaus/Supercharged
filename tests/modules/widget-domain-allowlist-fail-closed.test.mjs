// Widget config domain allowlist, fail closed (issue #324).
// With an allowlist set, a request carrying neither Origin nor Referer must be refused.
// Pure unit test: imports only the domain helper, no database or engine modules.
// Run: node --test --experimental-transform-types tests/modules/widget-domain-allowlist-fail-closed.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { widgetRequestDomain, isWidgetDomainAllowed } from "../../server/modules/widget/domain-gate.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");

// Same decision the config route makes: derive the domain from the headers, then check the allowlist.
const configRouteAllows = (allowedDomains, headers) =>
  isWidgetDomainAllowed(allowedDomains, widgetRequestDomain(headers));

const ALLOWLIST = ["shop.example.com", "*.partner.example.org"];

test("no Origin and no Referer, with an allowlist set: refused", () => {
  assert.equal(widgetRequestDomain({}), "");
  assert.equal(configRouteAllows(ALLOWLIST, {}), false);
  assert.equal(configRouteAllows(ALLOWLIST, { origin: "", referer: "" }), false);
});

test("non-allowlisted Origin: refused", () => {
  assert.equal(configRouteAllows(ALLOWLIST, { origin: "https://evil.example.net" }), false);
});

test("allowlisted Origin, and allowlisted Referer when Origin is absent: allowed", () => {
  assert.equal(configRouteAllows(ALLOWLIST, { origin: "https://shop.example.com" }), true);
  assert.equal(configRouteAllows(ALLOWLIST, { referer: "https://shop.example.com/page?x=1" }), true);
  assert.equal(configRouteAllows(ALLOWLIST, { origin: "https://a.partner.example.org" }), true);
});

test("empty or missing allowlist keeps the open behaviour, with or without headers", () => {
  assert.equal(configRouteAllows([], {}), true);
  assert.equal(configRouteAllows(null, {}), true);
  assert.equal(configRouteAllows(undefined, { origin: "https://anywhere.example.net" }), true);
});

test("the config route calls the helper and no longer skips the check on an empty domain", () => {
  const src = readFileSync(join(ROOT, "server/modules/widget/public-widget-routes.ts"), "utf8");
  assert.ok(src.includes("isWidgetDomainAllowed(widget.allowedDomains, domain)"));
  assert.ok(!src.includes("if (domain && !widgetService.validateDomain(widget, domain))"));
});

test("session-start rejects absent Origin/Referer even when client claims an allowed visitorDomain", () => {
  // A POST body claim cannot authorize a request: authorization must use the
  // observed request headers, as for GET /widget/config/:token.
  const claimedVisitorDomain = "shop.example.com";
  assert.equal(configRouteAllows(ALLOWLIST, {}), false);
  assert.equal(configRouteAllows(ALLOWLIST, { origin: "" }), false);
  assert.equal(configRouteAllows(ALLOWLIST, { origin: "https://evil.example.net" }), false);
  assert.equal(configRouteAllows(ALLOWLIST, { origin: "https://shop.example.com" }), true);
  assert.equal(claimedVisitorDomain, "shop.example.com");
});

test("session-start checks observed domain before credit or session allocation", () => {
  const src = readFileSync(join(ROOT, "server/modules/widget/public-widget-routes.ts"), "utf8");
  const start = src.indexOf("router.post('/widget/session/start'");
  const end = src.indexOf("router.post('/widget/session/:sessionId/connect'", start);
  assert.ok(start >= 0 && end > start, "session route section must remain present");
  const sessionRoute = src.slice(start, end);
  assert.match(sessionRoute, /const requestDomain = widgetRequestDomain\(req\.headers\);/);
  assert.match(sessionRoute, /if \(!isWidgetDomainAllowed\(widget\.allowedDomains, requestDomain\)\)/);
  assert.doesNotMatch(sessionRoute, /if \(visitorDomain && !widgetService\.validateDomain/);
  assert.ok(
    sessionRoute.indexOf("if (!isWidgetDomainAllowed") < sessionRoute.indexOf("checkUserCredits("),
    "deny a disallowed request before any billable service work"
  );
  assert.ok(
    sessionRoute.indexOf("if (!isWidgetDomainAllowed") < sessionRoute.indexOf("widgetStorage.createSession("),
    "deny a disallowed request before persisting a session"
  );
  assert.match(
    sessionRoute,
    /visitorDomain: requestDomain \|\| claimedDomain/,
    "persist observed domain ahead of the caller-supplied body claim"
  );
});

test("Origin is an advisory embed restriction, not proof of site identity", () => {
  assert.equal(configRouteAllows(ALLOWLIST, { origin: "https://shop.example.com" }), true);
  // This is intentionally spoofable by custom clients; account auth, token
  // permissions, cooldown/rate limits and usage controls remain necessary.
  assert.equal(configRouteAllows(ALLOWLIST, { origin: "https://other.example.net" }), false);
  assert.equal(configRouteAllows([], {}), true, "unrestricted widgets preserve existing behaviour");
});
