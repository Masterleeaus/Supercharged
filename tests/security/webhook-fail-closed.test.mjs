// Security regression test: webhooks must fail closed when their secret is missing.
// Static text test: the middleware and route are read as source, so no server is started.
// Run: node --test --experimental-transform-types tests/security/webhook-fail-closed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

const MIDDLEWARE = 'server/middleware/webhookValidation.ts';
const STRIPE_ROUTES = 'server/routes/stripe-routes.ts';

// Matches an `if (!<something>Secret...) { ... }` guard whose body has no nested braces.
const SECRET_GUARD = /if\s*\(\s*!\s*\w*[sS]ecret\w*\b[^)]*\)\s*\{([^}]*)\}/g;

test('webhookValidation.ts has secret-missing guards that reject instead of calling next()', () => {
  const src = read(MIDDLEWARE);
  const bodies = [...src.matchAll(SECRET_GUARD)].map((m) => m[1]);
  // Guards for Stripe, Razorpay and the generic HMAC validator. Require them, so the check cannot pass vacuously.
  assert.ok(bodies.length >= 3, `expected at least 3 secret-missing guards, found ${bodies.length}`);
  for (const body of bodies) {
    assert.doesNotMatch(body, /\bnext\s*\(/, `secret-missing branch must not call next(): ${body.trim()}`);
    assert.match(body, /throw\s+new\s+WebhookValidationError/, 'secret-missing branch must throw WebhookValidationError');
  }
});

test('webhookValidation.ts has no return-next shortcut anywhere', () => {
  assert.doesNotMatch(read(MIDDLEWARE), /return\s+next\s*\(\s*\)/);
});

test('Stripe validator rejects when STRIPE_WEBHOOK_SECRET is unset', () => {
  const src = read(MIDDLEWARE);
  assert.match(src, /if\s*\(\s*!webhookSecret\s*\)\s*\{\s*throw new WebhookValidationError\("stripe"/);
});

test('stripe-routes /webhook refuses with 403 when STRIPE_WEBHOOK_SECRET is unset', () => {
  const src = read(STRIPE_ROUTES);
  const start = src.indexOf("router.post('/webhook'");
  assert.ok(start >= 0, 'router.post(\'/webhook\') must exist');
  const handler = src.slice(start, start + 1200);
  assert.match(handler, /if\s*\(\s*!webhookSecret\s*\)\s*\{[\s\S]*?return res\.status\(403\)/,
    'missing STRIPE_WEBHOOK_SECRET must return 403 before any event is processed');
  // The refusal must come before signature verification, so no unverified event is ever handled.
  const refuseAt = handler.indexOf('return res.status(403)');
  const verifyAt = handler.indexOf('constructEvent');
  assert.ok(refuseAt >= 0 && verifyAt > refuseAt, 'secret refusal must precede constructEvent');
});
