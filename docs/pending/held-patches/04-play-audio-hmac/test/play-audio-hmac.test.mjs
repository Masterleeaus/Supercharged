// Security regression test: play-audio tool webhook must require an HMAC before acting.
// Run: node --test tests/security/play-audio-hmac.test.mjs   (apply SEC-02 first; this uses its helper)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { verifyElevenLabsWebhookAgainstSecrets } from '../../server/services/elevenlabs-webhook-signature.ts';

const src = fs
  .readFileSync(new URL('../../server/routes/webhook-routes.ts', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n');
const start = src.indexOf('export async function handlePlayAudioToolWebhook(');
const handler = src.slice(start, src.indexOf('\n}\n', start) + 2);

test('play-audio handler verifies an HMAC with a configured tool secret', () => {
  assert.ok(start >= 0, 'handler not found');
  assert.match(handler, /verifyElevenLabsWebhookAgainstSecrets\(/);
  assert.match(handler, /process\.env\.ELEVENLABS_TOOL_HMAC_SECRET/);
  assert.match(handler, /PLAY_AUDIO_SIGNATURE_HEADER/);
});

test('play-audio authenticates before it logs or reads the body', () => {
  const authAt = handler.indexOf('verifyElevenLabsWebhookAgainstSecrets(');
  const logAt = handler.indexOf("console.log('[PlayAudio Webhook] Received request");
  assert.ok(authAt > 0 && logAt > authAt, 'auth must come before the body is logged');
  assert.ok(!/console\.log\([^)]*req\.body/.test(handler.slice(0, authAt)), 'body logged before auth');
});

test('play-audio rejects with 401 when auth fails and only accepts https audio', () => {
  assert.match(handler, /res\.status\(401\)/);
  assert.match(handler, /\^https:/);
});

// Behaviour of the HMAC rule the handler depends on. Header is `t=<unix>,v0=<hmac of t.body>`.
const SECRET = 'test-tool-secret-not-real';
const NOW = 1_800_000_000;
const body = JSON.stringify({ audioUrl: 'https://example.com/a.mp3', interruptible: false });
const sign = (payload, secret, ts = NOW) =>
  `t=${ts},v0=` + crypto.createHmac('sha256', secret).update(`${ts}.${payload}`).digest('hex');

test('accepts a request whose HMAC matches the tool secret', () => {
  assert.equal(verifyElevenLabsWebhookAgainstSecrets(body, sign(body, SECRET, NOW), [SECRET], NOW).verified, true);
});

test('rejects an unsigned request (no header)', () => {
  assert.equal(verifyElevenLabsWebhookAgainstSecrets(body, undefined, [SECRET], NOW).verified, false);
});

test('rejects when ELEVENLABS_TOOL_HMAC_SECRET is unset (empty secret)', () => {
  assert.equal(verifyElevenLabsWebhookAgainstSecrets(body, sign(body, '', NOW), [''], NOW).verified, false);
});

test('rejects a body changed after signing (for example a swapped audioUrl)', () => {
  const swapped = body.replace('example.com', 'attacker.example');
  assert.equal(verifyElevenLabsWebhookAgainstSecrets(swapped, sign(body, SECRET, NOW), [SECRET], NOW).verified, false);
});
