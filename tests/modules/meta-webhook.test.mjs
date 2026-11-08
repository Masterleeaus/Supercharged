// Meta webhook checks (node:test). Pure functions only: no network, no Meta API, no clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  verifySubscription,
  verifySignature,
} from '../../server/modules/comms/meta-webhook.ts';

const TOKEN = 'verify-token-7f3a9c';
const SECRET = 'app-secret-b81e2d4f0a';
const BODY = JSON.stringify({ object: 'instagram', entry: [{ id: '17841400000', time: 1793750400 }] });

const sign = (body, secret = SECRET) =>
  'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

const subscribe = (overrides = {}) => ({
  mode: 'subscribe',
  token: TOKEN,
  challenge: '1158201444',
  expectedToken: TOKEN,
  ...overrides,
});

// --- verifySubscription ---

test('subscribe handshake with the correct token returns the challenge', () => {
  assert.deepEqual(verifySubscription(subscribe()), { ok: true, challenge: '1158201444' });
});

test('wrong verify token is refused with verification_failed', () => {
  assert.deepEqual(
    verifySubscription(subscribe({ token: 'verify-token-0000000' })),
    { ok: false, reason: 'verification_failed' },
  );
});

test('token of a different length is refused without throwing', () => {
  assert.deepEqual(
    verifySubscription(subscribe({ token: 'short' })),
    { ok: false, reason: 'verification_failed' },
  );
});

test('wrong hub mode is refused with verification_failed', () => {
  assert.deepEqual(
    verifySubscription(subscribe({ mode: 'unsubscribe' })),
    { ok: false, reason: 'verification_failed' },
  );
});

test('missing hub mode is refused with verification_failed', () => {
  assert.deepEqual(
    verifySubscription(subscribe({ mode: undefined })),
    { ok: false, reason: 'verification_failed' },
  );
});

test('missing challenge is refused with verification_failed', () => {
  assert.deepEqual(
    verifySubscription(subscribe({ challenge: undefined })),
    { ok: false, reason: 'verification_failed' },
  );
});

test('missing expected token is refused as not_configured, even with a matching token', () => {
  assert.deepEqual(
    verifySubscription(subscribe({ expectedToken: undefined })),
    { ok: false, reason: 'not_configured' },
  );
  assert.deepEqual(
    verifySubscription(subscribe({ expectedToken: '' })),
    { ok: false, reason: 'not_configured' },
  );
});

// --- verifySignature ---

test('correct signature passes', () => {
  assert.deepEqual(
    verifySignature({ rawBody: BODY, signatureHeader: sign(BODY), appSecret: SECRET }),
    { ok: true },
  );
});

test('correct signature passes when the raw body is a Buffer', () => {
  const buf = Buffer.from(BODY, 'utf8');
  assert.deepEqual(
    verifySignature({ rawBody: buf, signatureHeader: sign(BODY), appSecret: SECRET }),
    { ok: true },
  );
});

test('tampered body fails with signature_mismatch', () => {
  const tampered = BODY.replace('instagram', 'messenger');
  assert.deepEqual(
    verifySignature({ rawBody: tampered, signatureHeader: sign(BODY), appSecret: SECRET }),
    { ok: false, reason: 'signature_mismatch' },
  );
});

test('signature made with a different secret fails with signature_mismatch', () => {
  assert.deepEqual(
    verifySignature({ rawBody: BODY, signatureHeader: sign(BODY, 'other-secret'), appSecret: SECRET }),
    { ok: false, reason: 'signature_mismatch' },
  );
});

test('missing signature header fails with missing_signature', () => {
  for (const signatureHeader of [undefined, null, '']) {
    assert.deepEqual(
      verifySignature({ rawBody: BODY, signatureHeader, appSecret: SECRET }),
      { ok: false, reason: 'missing_signature' },
    );
  }
});

test('malformed signature header fails with malformed_signature', () => {
  const hex = sign(BODY).slice('sha256='.length);
  const malformed = [
    hex, // no scheme prefix
    'sha1=' + hex, // wrong scheme
    'sha256=' + hex.slice(0, 40), // truncated digest
    'sha256=' + hex + 'ab', // overlong digest
    'sha256=' + 'z'.repeat(64), // non-hex characters
    'sha256=', // empty digest
    ['sha256=' + hex, 'x'], // not a string
  ];
  for (const signatureHeader of malformed) {
    assert.deepEqual(
      verifySignature({ rawBody: BODY, signatureHeader, appSecret: SECRET }),
      { ok: false, reason: 'malformed_signature' },
    );
  }
});

test('missing app secret is refused as not_configured', () => {
  for (const appSecret of [undefined, null, '']) {
    assert.deepEqual(
      verifySignature({ rawBody: BODY, signatureHeader: sign(BODY), appSecret }),
      { ok: false, reason: 'not_configured' },
    );
  }
});

// --- secret and token never leak into results ---

test('the app secret never appears in any returned value', () => {
  const results = [
    verifySignature({ rawBody: BODY, signatureHeader: sign(BODY), appSecret: SECRET }),
    verifySignature({ rawBody: BODY, signatureHeader: sign(BODY, 'other'), appSecret: SECRET }),
    verifySignature({ rawBody: BODY, signatureHeader: 'sha256=bad', appSecret: SECRET }),
    verifySignature({ rawBody: BODY, signatureHeader: undefined, appSecret: SECRET }),
    verifySignature({ rawBody: BODY, signatureHeader: sign(BODY), appSecret: undefined }),
  ];
  for (const r of results) {
    assert.equal(JSON.stringify(r).includes(SECRET), false);
  }
});

test('the verify token never appears in any returned value', () => {
  const results = [
    verifySubscription(subscribe()),
    verifySubscription(subscribe({ token: 'nope-nope-nope' })),
    verifySubscription(subscribe({ mode: 'bogus' })),
    verifySubscription(subscribe({ expectedToken: undefined })),
  ];
  for (const r of results) {
    assert.equal(JSON.stringify(r).includes(TOKEN), false);
  }
});
