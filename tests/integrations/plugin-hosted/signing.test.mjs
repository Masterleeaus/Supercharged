/**
 * tzfd-ai/1 signing tests. Offline: no network, no server.
 * The PHP-side vectors come from fixtures/tzfd-ai-v1.mjs (see the source comment there).
 * The reference formula here is written with node:crypto directly, not by calling the module under test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signTzfd, verifyTzfdSignature, constantTimeEquals } from '../../../server/integrations/plugin-hosted/signing.ts';
import { TEST_SECRET, PHP_REQUEST, PHP_RESPONSE, CONTRACT_V1_SERVICE_VECTOR } from './fixtures/tzfd-ai-v1.mjs';

// Plugin-side formula as written in TZFD_AI_Connector::sign(): HMAC-SHA256 over "<ts>.<nonce>.<body>".
const pluginSign = (secret, ts, nonce, body) =>
  'sha256=' + createHmac('sha256', secret).update(`${ts}.${nonce}.${body}`).digest('hex');

test('PHP-signed request signature is reproduced byte for byte', () => {
  const computed = signTzfd(TEST_SECRET, PHP_REQUEST.timestamp, PHP_REQUEST.nonce, PHP_REQUEST.body);
  assert.equal(computed, PHP_REQUEST.signature);
  assert.equal(pluginSign(TEST_SECRET, PHP_REQUEST.timestamp, PHP_REQUEST.nonce, PHP_REQUEST.body), PHP_REQUEST.signature);
});

test('PHP-signed request verifies here', () => {
  assert.equal(verifyTzfdSignature(TEST_SECRET, PHP_REQUEST.timestamp, PHP_REQUEST.nonce, PHP_REQUEST.body, PHP_REQUEST.signature), true);
});

test('PHP-signed response signature verifies with the plugin-side formula', () => {
  const { 'X-TZFD-Timestamp': ts, 'X-TZFD-Nonce': nonce, 'X-TZFD-Signature': sig } = PHP_RESPONSE.headers;
  assert.equal(pluginSign(TEST_SECRET, ts, nonce, PHP_RESPONSE.body), sig);
  assert.equal(verifyTzfdSignature(TEST_SECRET, ts, nonce, PHP_RESPONSE.body, sig), true);
});

test('a single changed byte, timestamp, nonce or secret breaks verification', () => {
  const { timestamp, nonce, body, signature } = PHP_REQUEST;
  assert.equal(verifyTzfdSignature(TEST_SECRET, timestamp, nonce, body.replace('\\/', '/'), signature), false);
  assert.equal(verifyTzfdSignature(TEST_SECRET, String(Number(timestamp) + 1), nonce, body, signature), false);
  assert.equal(verifyTzfdSignature(TEST_SECRET, timestamp, nonce.replace(/.$/, '0'), body, signature), false);
  assert.equal(verifyTzfdSignature(`${TEST_SECRET}x`, timestamp, nonce, body, signature), false);
});

test('a presented signature of the wrong length is refused without throwing', () => {
  const { timestamp, nonce, body } = PHP_REQUEST;
  assert.equal(verifyTzfdSignature(TEST_SECRET, timestamp, nonce, body, 'sha256=00'), false);
  assert.equal(constantTimeEquals('abc', 'abcd'), false);
  assert.equal(constantTimeEquals('abc', 'abc'), true);
});

test('module signature matches the plugin formula for a multibyte body', () => {
  const body = '{"payload":{"question":"Ouvert le dimanche? ✓"}}';
  assert.equal(
    signTzfd(TEST_SECRET, '1794932497', 'a'.repeat(32), body),
    pluginSign(TEST_SECRET, '1794932497', 'a'.repeat(32), body),
  );
});

test('contract-v1 service vector uses a different scheme and is not a tzfd-ai/1 vector', () => {
  // Reference only. The frozen signature_vector signs sorted-key JSON of a booking envelope.
  const { key, envelope, sig } = CONTRACT_V1_SERVICE_VECTOR;
  const sortedJson = JSON.stringify(Object.fromEntries(Object.entries(envelope).sort(([a], [b]) => (a < b ? -1 : 1))));
  const serviceSig = createHmac('sha256', key).update(sortedJson).digest('hex');
  assert.equal(serviceSig, sig);
  assert.notEqual(pluginSign(key, String(envelope.ts), envelope.nonce, sortedJson), `sha256=${sig}`);
});
