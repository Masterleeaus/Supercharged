// Provider-neutral signed telephony events (issue #328). Fake secrets only.
// Run: node --test --experimental-transform-types tests/security/telephony-event-adapter.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplayGuard } from '../../server/middleware/webhook-replay.ts';
import {
  processTelephonyEvent,
  signTelephonyEvent,
  verifyTelephonyEvent,
  TELEPHONY_EVENT_ID_HEADER,
  TELEPHONY_SIGNATURE_HEADER,
  TELEPHONY_TIMESTAMP_HEADER,
} from '../../server/modules/comms/telephony-event-adapter.ts';

const SECRETS = { 'tenant-a': 'fake-secret-tenant-a-0001', 'tenant-b': 'fake-secret-tenant-b-0002' };
const body = JSON.stringify({ callId: 'c-1', event: 'missed_call' });
const NOW_SEC = 1_800_000_000;

function makeDeps(nowSec = NOW_SEC) {
  const guard = createReplayGuard({ now: () => nowSec * 1000, windowMs: 5 * 60 * 1000, maxEntries: 1000 });
  return { guard, secretFor: (t) => SECRETS[t] ?? null };
}

function signedHeaders({ secret = SECRETS['tenant-a'], ts = NOW_SEC, eventId = 'evt-1', rawBody = body } = {}) {
  return {
    [TELEPHONY_TIMESTAMP_HEADER]: String(ts),
    [TELEPHONY_EVENT_ID_HEADER]: eventId,
    [TELEPHONY_SIGNATURE_HEADER]: signTelephonyEvent(secret, ts, rawBody),
  };
}

const input = (headers, tenantId = 'tenant-a', rawBody = body) => ({ provider: 'voice-hosted', tenantId, headers, rawBody });

test('a correctly signed event for its own tenant is accepted', () => {
  const v = verifyTelephonyEvent(input(signedHeaders()), makeDeps());
  assert.equal(v.accepted, true);
});

test('the same signed event delivered twice is refused as a replay', () => {
  const deps = makeDeps();
  assert.equal(verifyTelephonyEvent(input(signedHeaders()), deps).accepted, true);
  assert.deepEqual(verifyTelephonyEvent(input(signedHeaders()), deps), { accepted: false, reason: 'replay' });
});

test('an event signed with another tenant secret is refused for this tenant', () => {
  const headers = signedHeaders({ secret: SECRETS['tenant-b'] });
  assert.deepEqual(verifyTelephonyEvent(input(headers, 'tenant-a'), makeDeps()), { accepted: false, reason: 'bad_signature' });
});

test('a tampered body fails the signature check', () => {
  const headers = signedHeaders();
  assert.deepEqual(verifyTelephonyEvent(input(headers, 'tenant-a', body.replace('c-1', 'c-2')), makeDeps()), { accepted: false, reason: 'bad_signature' });
});

test('an event for a tenant with no secret is refused', () => {
  assert.deepEqual(verifyTelephonyEvent(input(signedHeaders(), 'tenant-z'), makeDeps()), { accepted: false, reason: 'unknown_tenant' });
});

test('a stale timestamp outside the window is refused', () => {
  const headers = signedHeaders({ ts: NOW_SEC - 10 * 60 });
  assert.deepEqual(verifyTelephonyEvent(input(headers), makeDeps()), { accepted: false, reason: 'timestamp_out_of_window' });
});

test('missing signature, id or timestamp headers are refused', () => {
  const full = signedHeaders();
  for (const name of [TELEPHONY_SIGNATURE_HEADER, TELEPHONY_EVENT_ID_HEADER, TELEPHONY_TIMESTAMP_HEADER]) {
    const { [name]: _drop, ...rest } = full;
    assert.deepEqual(verifyTelephonyEvent(input(rest), makeDeps()), { accepted: false, reason: 'missing_headers' }, name);
  }
});

test('the same provider event id in another tenant is not a replay', () => {
  const deps = makeDeps();
  assert.equal(verifyTelephonyEvent(input(signedHeaders()), deps).accepted, true);
  assert.equal(verifyTelephonyEvent(input(signedHeaders({ secret: SECRETS['tenant-b'] }), 'tenant-b'), deps).accepted, true);
});

test('a forged signature never consumes the replay table', () => {
  const deps = makeDeps();
  verifyTelephonyEvent(input(signedHeaders({ secret: 'wrong-secret-value-000000' })), deps);
  assert.equal(deps.guard.size(), 0);
});

test('a handler that fails releases the event so the provider retry is processed once', async () => {
  const deps = makeDeps();
  let runs = 0;
  await assert.rejects(
    processTelephonyEvent(input(signedHeaders()), deps, async () => { runs += 1; throw new Error('db down'); }),
    /db down/,
  );
  const retry = await processTelephonyEvent(input(signedHeaders()), deps, async () => { runs += 1; return 'booked'; });
  assert.deepEqual(retry, { accepted: true, result: 'booked' });
  const dup = await processTelephonyEvent(input(signedHeaders()), deps, async () => { runs += 1; });
  assert.deepEqual(dup, { accepted: false, reason: 'replay' });
  assert.equal(runs, 2, 'handler ran once for the failed attempt and once for the successful retry');
});
