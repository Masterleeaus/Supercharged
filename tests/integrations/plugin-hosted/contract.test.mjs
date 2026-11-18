/**
 * tzfd-ai/1 contract tests. Checks that the code constants and the published contract document
 * agree, and that signing and verification behave as documented. No network, no database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TZFD_CONTRACT, TZFD_CONSENT_VERSION, TZFD_HEADERS, TZFD_LIMITS, TZFD_RESPONSE_STATUSES,
  TZFD_FEATURES, TZFD_NONCE_PATTERN, TZFD_SITE_ID_PATTERN, tzfdSign, tzfdVerify, isTzfdFeature,
} from '../../../server/integrations/plugin-hosted/contract.ts';

const here = dirname(fileURLToPath(import.meta.url));
const doc = readFileSync(join(here, '../../../docs/PLUGIN_CONNECTOR_TZFD_AI_1.md'), 'utf8');
const SECRET = 'TEST-TZFD-SECRET-NOT-REAL-0123456789-ABCDEF';

test('contract version and consent version match the document', () => {
  assert.equal(TZFD_CONTRACT, 'tzfd-ai/1');
  assert.equal(TZFD_CONSENT_VERSION, 'tzfd-ai-consent-1');
  assert.ok(doc.includes('`tzfd-ai/1`'));
  assert.ok(doc.includes('tzfd-ai-consent-1'));
});

test('header names, limits and site/nonce formats match the document', () => {
  assert.equal(TZFD_HEADERS.contract, 'x-tzfd-contract');
  assert.equal(TZFD_HEADERS.site, 'x-tzfd-site');
  assert.equal(TZFD_HEADERS.timestamp, 'x-tzfd-timestamp');
  assert.equal(TZFD_HEADERS.nonce, 'x-tzfd-nonce');
  assert.equal(TZFD_HEADERS.signature, 'x-tzfd-signature');
  for (const name of ['X-TZFD-Contract', 'X-TZFD-Site', 'X-TZFD-Timestamp', 'X-TZFD-Nonce', 'X-TZFD-Signature']) {
    assert.ok(doc.includes(`\`${name}\``), `document lists ${name}`);
  }
  assert.equal(TZFD_LIMITS.requestBodyBytes, 16 * 1024);
  assert.equal(TZFD_LIMITS.responseBodyBytes, 64 * 1024);
  assert.equal(TZFD_LIMITS.timestampSkewSeconds, 300);
  assert.equal(TZFD_LIMITS.minSecretChars, 32);
  assert.ok(doc.includes('at most 16 KB'));
  assert.ok(doc.includes('at most 64 KB'));
  assert.ok(doc.includes('300 s'));
  assert.equal(TZFD_SITE_ID_PATTERN.test('site_1.a-b'), true);
  assert.equal(TZFD_SITE_ID_PATTERN.test('x'.repeat(65)), false);
  assert.equal(TZFD_SITE_ID_PATTERN.test('bad id'), false);
  assert.equal(TZFD_NONCE_PATTERN.test('0123456789abcdef0123456789abcdef'), true);
  assert.equal(TZFD_NONCE_PATTERN.test('0123456789ABCDEF0123456789abcdef'), false);
});

test('response statuses are exactly the four the plugin accepts', () => {
  assert.deepEqual([...TZFD_RESPONSE_STATUSES], ['ok', 'allowance_exhausted', 'service_error', 'contract_unsupported']);
});

test('feature allowlist and scopes match the document table', () => {
  assert.deepEqual(Object.keys(TZFD_FEATURES).sort(), [
    'agent.run', 'assistant.turn', 'faq.answer', 'faq.embed_query', 'faq.suggest_batch', 'insight.monthly',
  ]);
  assert.deepEqual([...TZFD_FEATURES['agent.run'].scopes], ['booking.read', 'booking.write', 'customer.read']);
  for (const feature of Object.keys(TZFD_FEATURES)) {
    assert.ok(doc.includes(`\`${feature}\``), `document lists ${feature}`);
  }
  assert.equal(isTzfdFeature('faq.answer'), true);
  assert.equal(isTzfdFeature('constructor'), false);
  assert.equal(isTzfdFeature('__proto__'), false);
  assert.equal(isTzfdFeature('admin.dump'), false);
});

test('signature is HMAC-SHA256 over timestamp.nonce.body in sha256= form', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const body = '{"contract":"tzfd-ai/1"}';
  const sig = tzfdSign(SECRET, '1700000000', nonce, body);
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.equal(tzfdVerify(SECRET, '1700000000', nonce, body, sig), true);
});

test('verification rejects a changed body, timestamp, nonce, secret or malformed header', () => {
  const nonce = '0123456789abcdef0123456789abcdef';
  const body = '{"a":1}';
  const sig = tzfdSign(SECRET, '1700000000', nonce, body);
  assert.equal(tzfdVerify(SECRET, '1700000000', nonce, '{"a":2}', sig), false);
  assert.equal(tzfdVerify(SECRET, '1700000001', nonce, body, sig), false);
  assert.equal(tzfdVerify(SECRET, '1700000000', 'f'.repeat(32), body, sig), false);
  assert.equal(tzfdVerify(`${SECRET}-other`, '1700000000', nonce, body, sig), false);
  assert.equal(tzfdVerify(SECRET, '1700000000', nonce, body, undefined), false);
  assert.equal(tzfdVerify(SECRET, '1700000000', nonce, body, sig.toUpperCase()), false);
  assert.equal(tzfdVerify(SECRET, '1700000000', nonce, body, sig.slice(0, 40)), false);
});
