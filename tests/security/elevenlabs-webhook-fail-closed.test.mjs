// Security regression test: ElevenLabs webhook must fail closed.
// Run: node --test tests/security/elevenlabs-webhook-fail-closed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  verifyElevenLabsWebhookAgainstSecrets,
  verifyElevenLabsSignature,
} from '../../server/services/elevenlabs-webhook-signature.ts';

const SECRET = 'test-elevenlabs-secret-not-real';
const OTHER = 'test-rotated-secret-not-real';
const NOW = 1_800_000_000;
const body = JSON.stringify({ type: 'post_call_transcription', data: { metadata: { phone_call: { sip_trunk_id: 'x' } } } });

function sign(payload, secret, ts = NOW) {
  const v0 = crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');
  return `t=${ts},v0=${v0}`;
}

test('accepts a correctly signed, fresh webhook', () => {
  const r = verifyElevenLabsWebhookAgainstSecrets(body, sign(body, SECRET, NOW), [SECRET], NOW);
  assert.equal(r.verified, true);
  assert.equal(r.matchedSecret, SECRET);
});

test('rejects every webhook when no secret is configured, even with a header present', () => {
  const r = verifyElevenLabsWebhookAgainstSecrets(body, sign(body, SECRET, NOW), [], NOW);
  assert.equal(r.verified, false);
});

test('rejects an unsigned webhook when no secret is configured', () => {
  assert.equal(verifyElevenLabsWebhookAgainstSecrets(body, undefined, [], NOW).verified, false);
});

test('rejects an empty-string secret as if it were not configured', () => {
  assert.equal(verifyElevenLabsWebhookAgainstSecrets(body, sign(body, '', NOW), [''], NOW).verified, false);
});

test('rejects an unsigned SIP-shaped webhook when secrets are configured (no SIP bypass)', () => {
  const r = verifyElevenLabsWebhookAgainstSecrets(body, undefined, [SECRET], NOW);
  assert.equal(r.verified, false);
  assert.match(r.error, /Missing/);
});

test('rejects a tampered body', () => {
  const tampered = body.replace('post_call_transcription', 'post_call_audio');
  assert.equal(verifyElevenLabsWebhookAgainstSecrets(tampered, sign(body, SECRET, NOW), [SECRET], NOW).verified, false);
});

test('rejects a signature made with the wrong secret', () => {
  assert.equal(verifyElevenLabsWebhookAgainstSecrets(body, sign(body, 'wrong-secret', NOW), [SECRET], NOW).verified, false);
});

test('rejects a stale signature (older than 30 minutes)', () => {
  const stale = NOW - 31 * 60;
  assert.equal(verifyElevenLabsWebhookAgainstSecrets(body, sign(body, SECRET, stale), [SECRET], NOW).verified, false);
});

test('rejects a malformed header with no v0 part', () => {
  assert.equal(verifyElevenLabsWebhookAgainstSecrets(body, `t=${NOW}`, [SECRET], NOW).verified, false);
});

test('supports credential rotation: a later secret in the pool still verifies', () => {
  const r = verifyElevenLabsWebhookAgainstSecrets(body, sign(body, OTHER, NOW), [SECRET, OTHER], NOW);
  assert.equal(r.verified, true);
  assert.equal(r.matchedSecret, OTHER);
});

test('low-level check reports expiry explicitly', () => {
  const r = verifyElevenLabsSignature(body, sign(body, SECRET, NOW - 3600), SECRET, NOW);
  assert.equal(r.valid, false);
  assert.match(r.error, /expired/);
});
