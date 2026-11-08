// Security regression test: provider webhook rate limit (Twilio, ElevenLabs).
// Run: node --test --experimental-transform-types tests/security/provider-webhook-rate-limit.test.mjs
// Silence console first: this file imports server code and test output must not reach stdout.
console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.error = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProviderWebhookRateLimit,
  readTwilioAccountSid,
  TWILIO_ACCOUNT_SID_PATTERN,
} from '../../server/middleware/provider-webhook-rate-limit.ts';

const SID_A = `AC${'a'.repeat(32)}`; // fake
const SID_B = `AC${'b'.repeat(32)}`; // fake

function fakeReq({ ip = '198.51.100.1', body } = {}) {
  return { ip, socket: { remoteAddress: ip }, body, headers: {} };
}

function fakeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    status(code) { this.statusCode = code; return this; },
    json(b) { this.body = b; return this; },
  };
}

function send(mw, req) {
  const res = fakeRes();
  let called = false;
  mw(req, res, () => { called = true; });
  return { called, status: res.statusCode, res };
}

function twilioLimiter(extra = {}) {
  return createProviderWebhookRateLimit({
    provider: 'twilio',
    windowMs: 60_000,
    maxRequests: 2,
    readAccountId: readTwilioAccountSid,
    accountIdPattern: TWILIO_ACCOUNT_SID_PATTERN,
    now: () => 1_000_000,
    ...extra,
  });
}

test('Twilio: one AccountSid shares a bucket across source IPs', () => {
  const mw = twilioLimiter();
  assert.equal(send(mw, fakeReq({ ip: '198.51.100.1', body: { AccountSid: SID_A } })).called, true);
  assert.equal(send(mw, fakeReq({ ip: '198.51.100.2', body: { AccountSid: SID_A } })).called, true);
  const third = send(mw, fakeReq({ ip: '198.51.100.3', body: { AccountSid: SID_A } }));
  assert.equal(third.called, false);
  assert.equal(third.status, 429);
  assert.ok(third.res.headers['retry-after']);
});

test('Twilio: different AccountSids from the same IP get separate buckets', () => {
  const mw = twilioLimiter();
  const ip = '198.51.100.9';
  assert.equal(send(mw, fakeReq({ ip, body: { AccountSid: SID_A } })).called, true);
  assert.equal(send(mw, fakeReq({ ip, body: { AccountSid: SID_A } })).called, true);
  assert.equal(send(mw, fakeReq({ ip, body: { AccountSid: SID_A } })).called, false);
  assert.equal(send(mw, fakeReq({ ip, body: { AccountSid: SID_B } })).called, true);
});

test('Twilio: a missing AccountSid falls back to the socket IP', () => {
  const mw = twilioLimiter({ maxRequests: 1 });
  assert.equal(send(mw, fakeReq({ ip: '198.51.100.20', body: {} })).called, true);
  assert.equal(send(mw, fakeReq({ ip: '198.51.100.20', body: {} })).called, false);
  assert.equal(send(mw, fakeReq({ ip: '198.51.100.21', body: {} })).called, true);
});

test('Twilio: a malformed AccountSid is refused and does not fall back to IP', () => {
  const mw = twilioLimiter();
  for (const bad of ['AC123', ['AC' + 'a'.repeat(32)], { sid: 1 }, 42]) {
    const r = send(mw, fakeReq({ body: { AccountSid: bad } }));
    assert.equal(r.called, false);
    assert.equal(r.status, 401);
  }
});

test('fails closed when there is neither an account id nor an IP', () => {
  const mw = twilioLimiter();
  const r = send(mw, { socket: {}, body: undefined, headers: {} });
  assert.equal(r.called, false);
  assert.equal(r.status, 401);
});

test('ElevenLabs-style limiter with no account reader keys on IP only', () => {
  const mw = createProviderWebhookRateLimit({
    provider: 'elevenlabs',
    windowMs: 60_000,
    maxRequests: 1,
    now: () => 1_000_000,
  });
  assert.equal(send(mw, fakeReq({ ip: '198.51.100.30', body: { AccountSid: SID_A } })).called, true);
  assert.equal(send(mw, fakeReq({ ip: '198.51.100.30', body: { AccountSid: SID_B } })).called, false);
  assert.equal(send(mw, fakeReq({ ip: '198.51.100.31' })).called, true);
});

test('the window resets after windowMs', () => {
  let t = 1_000_000;
  const mw = twilioLimiter({ maxRequests: 1, now: () => t });
  assert.equal(send(mw, fakeReq({ body: { AccountSid: SID_A } })).called, true);
  assert.equal(send(mw, fakeReq({ body: { AccountSid: SID_A } })).called, false);
  t += 60_000;
  assert.equal(send(mw, fakeReq({ body: { AccountSid: SID_A } })).called, true);
});

test('refuses a new key with 429 when the bucket table is full', () => {
  const mw = twilioLimiter({ maxBuckets: 1 });
  assert.equal(send(mw, fakeReq({ body: { AccountSid: SID_A } })).called, true);
  const r = send(mw, fakeReq({ body: { AccountSid: SID_B } }));
  assert.equal(r.called, false);
  assert.equal(r.status, 429);
  assert.equal(send(mw, fakeReq({ body: { AccountSid: SID_A } })).called, true);
});

test('rejects invalid options at creation time', () => {
  assert.throws(() => createProviderWebhookRateLimit({ provider: 'twilio', windowMs: 0, maxRequests: 1 }));
  assert.throws(() => createProviderWebhookRateLimit({ provider: 'twilio', windowMs: 1000, maxRequests: 0 }));
  assert.throws(() => createProviderWebhookRateLimit({ provider: '', windowMs: 1000, maxRequests: 1 }));
});
