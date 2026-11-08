import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  encryptCredential,
  decryptCredential,
} from '../../server/services/credential-crypto.ts';

const keyA = randomBytes(32);
const keyB = randomBytes(32);
const providerA = () => keyA;
const providerB = () => keyB;

const SECRET = 'sk-test-ElevenLabs-0123456789';

function flipFirstByte(segment) {
  const buf = Buffer.from(segment, 'base64');
  buf[0] ^= 0x01;
  return buf.toString('base64');
}

test('round trip returns the original plaintext', () => {
  const enc = encryptCredential(SECRET, providerA);
  assert.equal(decryptCredential(enc, providerA), SECRET);
});

test('round trip handles empty and unicode values', () => {
  for (const value of ['', 'héllo ✓ 日本語']) {
    const enc = encryptCredential(value, providerA);
    assert.equal(decryptCredential(enc, providerA), value);
  }
});

test('output uses the v1:iv:tag:ciphertext base64 format', () => {
  const enc = encryptCredential(SECRET, providerA);
  const parts = enc.split(':');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
  assert.equal(Buffer.from(parts[1], 'base64').length, 12);
  assert.equal(Buffer.from(parts[2], 'base64').length, 16);
  assert.ok(!enc.includes(SECRET));
});

test('two encryptions of the same value differ', () => {
  const a = encryptCredential(SECRET, providerA);
  const b = encryptCredential(SECRET, providerA);
  assert.notEqual(a, b);
  assert.notEqual(a.split(':')[1], b.split(':')[1], 'IVs must differ');
  assert.equal(decryptCredential(a, providerA), SECRET);
  assert.equal(decryptCredential(b, providerA), SECRET);
});

test('tampered ciphertext is refused', () => {
  const [v, iv, tag, ct] = encryptCredential(SECRET, providerA).split(':');
  assert.throws(() => decryptCredential([v, iv, tag, flipFirstByte(ct)].join(':'), providerA));
});

test('tampered auth tag is refused', () => {
  const [v, iv, tag, ct] = encryptCredential(SECRET, providerA).split(':');
  assert.throws(() => decryptCredential([v, iv, flipFirstByte(tag), ct].join(':'), providerA));
});

test('tampered IV is refused', () => {
  const [v, iv, tag, ct] = encryptCredential(SECRET, providerA).split(':');
  assert.throws(() => decryptCredential([v, flipFirstByte(iv), tag, ct].join(':'), providerA));
});

test('non-canonical or wrong-length segments are refused', () => {
  const [v, iv, tag, ct] = encryptCredential(SECRET, providerA).split(':');
  assert.throws(() => decryptCredential([v, iv.slice(0, -4), tag, ct].join(':'), providerA));
  assert.throws(() => decryptCredential([v, iv, tag.slice(0, -4), ct].join(':'), providerA));
  assert.throws(() => decryptCredential([v, iv, tag, ct + '!'].join(':'), providerA));
  assert.throws(() => decryptCredential([v, iv, tag, ct, 'extra'].join(':'), providerA));
});

test('unknown version prefix is refused', () => {
  const [, iv, tag, ct] = encryptCredential(SECRET, providerA).split(':');
  assert.throws(() => decryptCredential(['v2', iv, tag, ct].join(':'), providerA));
});

test('wrong key is refused and no plaintext is returned', () => {
  const enc = encryptCredential(SECRET, providerA);
  let result;
  assert.throws(() => {
    result = decryptCredential(enc, providerB);
  });
  assert.equal(result, undefined);
});

test('key provider must return a 32-byte Buffer', () => {
  assert.throws(() => encryptCredential(SECRET, () => randomBytes(16)));
  assert.throws(() => encryptCredential(SECRET, () => 'not-a-buffer-key-material-xxxxxxx'));
  assert.throws(() => decryptCredential('v1:a:b:c', () => randomBytes(8)));
});

test('error messages do not contain key material or plaintext', () => {
  const enc = encryptCredential(SECRET, providerA);
  try {
    decryptCredential(enc, providerB);
    assert.fail('expected decryption to throw');
  } catch (err) {
    assert.ok(!String(err.message).includes(SECRET));
    assert.ok(!String(err.message).includes(keyB.toString('base64')));
    assert.ok(!String(err.message).includes(keyB.toString('hex')));
  }
});
