import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveTrustProxy } = await import('../../server/middleware/trust-proxy.ts');

test('trust proxy defaults to false when TRUST_PROXY is unset or empty', () => {
  assert.equal(resolveTrustProxy(undefined), false);
  assert.equal(resolveTrustProxy(null), false);
  assert.equal(resolveTrustProxy(''), false);
  assert.equal(resolveTrustProxy('   '), false);
});

test('trust proxy accepts a hop count and an explicit address list', () => {
  assert.equal(resolveTrustProxy('1'), 1);
  assert.equal(resolveTrustProxy('10.0.0.5'), '10.0.0.5');
  assert.equal(resolveTrustProxy('10.0.0.0/8, 127.0.0.1'), '10.0.0.0/8,127.0.0.1');
});

test('trust proxy never becomes true, and unknown values fall back to false', () => {
  assert.equal(resolveTrustProxy('true'), false);
  assert.equal(resolveTrustProxy('garbage here'), false);
});
