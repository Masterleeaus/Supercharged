// Wiring regression test: the replay guard must be called by the Stripe and Plivo webhook routes,
// and only after signature verification passes.
// Static source test: no server, database or network is started.
// Run: node --test --experimental-transform-types tests/security/replay-wiring.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../../' + rel, import.meta.url), 'utf8');

const STRIPE_ROUTES = 'server/routes/stripe-routes.ts';
const PLIVO_ROUTES = 'server/engines/plivo/routes/plivo-webhooks.ts';

test('stripe-routes.ts imports createReplayGuard and builds a guard', () => {
  const src = read(STRIPE_ROUTES);
  assert.match(src, /import\s*\{\s*createReplayGuard\s*\}\s*from\s*'\.\.\/middleware\/webhook-replay'/);
  assert.match(src, /const\s+stripeReplayGuard\s*=\s*createReplayGuard\(/);
});

test('stripe webhook checks the replay guard after constructEvent and before event handling', () => {
  const src = read(STRIPE_ROUTES);
  const verify = src.indexOf('stripe.webhooks.constructEvent(');
  const check = src.indexOf('stripeReplayGuard.check(');
  const dispatch = src.indexOf('switch (event.type)', verify);
  assert.ok(verify > 0, 'constructEvent call not found');
  assert.ok(check > verify, 'replay check must come after signature verification');
  assert.ok(dispatch > check, 'replay check must come before event dispatch');
  assert.match(src, /eventId:\s*event\.id/);
  assert.match(src, /if\s*\(\s*!replay\.accepted\s*\)\s*\{[\s\S]*?status\(409\)/);
});

test('plivo-webhooks.ts imports createReplayGuard and builds a guard', () => {
  const src = read(PLIVO_ROUTES);
  assert.match(src, /import\s*\{\s*createReplayGuard\s*\}\s*from\s*'\.\.\/\.\.\/\.\.\/middleware\/webhook-replay'/);
  assert.match(src, /const\s+plivoReplayGuard\s*=\s*createReplayGuard\(/);
});

test('plivo replay middleware runs after signature verification in every verifyPlivo chain', () => {
  const src = read(PLIVO_ROUTES);
  const chain = src.match(/const\s+verifyPlivo\s*=\s*\[([^\]]*)\]/);
  assert.ok(chain, 'verifyPlivo must be an ordered chain');
  const parts = chain[1].split(',').map((s) => s.trim());
  assert.deepEqual(parts, ['verifyPlivoSignature', 'verifyPlivoReplay']);
  assert.match(src, /plivoReplayGuard\.check\(/);
  assert.match(src, /status\(409\)/);
});

test('plivo replay refusal on capacity returns 503 with a generic body, inside the middleware and before next()', () => {
  const src = read(PLIVO_ROUTES);
  const start = src.indexOf('const verifyPlivoReplay');
  const end = src.indexOf('const verifyPlivo = [', start);
  assert.ok(start > 0 && end > start, 'verifyPlivoReplay middleware not found');
  const mw = src.slice(start, end);
  const cap = mw.indexOf("replay.reason === 'capacity'");
  assert.ok(cap > 0, 'capacity branch missing');
  const block = mw.slice(mw.indexOf('{', cap), mw.indexOf('return;', cap));
  assert.match(block, /res\.status\(503\)\.json\(\{ error: 'Webhook temporarily unavailable' \}\)/);
  // The 503 body carries no reason or internal detail.
  assert.doesNotMatch(block, /reason/);
  // Capacity is checked before the 409 branch and before next() advances the chain.
  assert.ok(mw.indexOf('status(409)') > cap, 'capacity branch must precede the 409 branch');
  assert.ok(mw.indexOf('next()') > mw.indexOf('status(409)'), 'next() must come after refusal handling');
});

// Every catch block in the Plivo routes that answers the request must answer 5xx, never 2xx.
// A 2xx tells Plivo the event was handled, so it does not retry and the event is lost.
function responderCatchBodies(src) {
  const bodies = [];
  const re = /\} catch \(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const open = src.indexOf('{', m.index + 2);
    let depth = 0;
    let i = open;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    const body = src.slice(open + 1, i);
    if (/\bres\b/.test(body)) bodies.push(body);
  }
  return bodies;
}

test('plivo catch blocks that answer the request return 500, never 2xx', () => {
  const src = read(PLIVO_ROUTES);
  const bodies = responderCatchBodies(src);
  // Ten responder catches: incoming, answer x2, status x2, recording x3, transfer, hangup, transfer-XML.
  assert.ok(bodies.length >= 10, `expected at least 10 responder catch blocks, found ${bodies.length}`);
  for (const body of bodies) {
    assert.doesNotMatch(body, /sendStatus\(\s*2\d\d\s*\)/, 'catch sends a 2xx status');
    assert.doesNotMatch(body, /status\(\s*2\d\d\s*\)/, 'catch sets a 2xx status');
    assert.match(body, /sendWebhookInternalError\(res\)/, 'catch does not use the 500 helper');
  }
  const helper = src.slice(src.indexOf('const sendWebhookInternalError'), src.indexOf('const sendWebhookInternalError') + 300);
  assert.match(helper, /res\.status\(500\)\.json\(\{ error: 'Internal error' \}\)/);
  assert.doesNotMatch(helper, /error\.message|stack/);
});
