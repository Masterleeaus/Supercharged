// Security regression test: server/utils/credential-crypto.ts must load its key from
// CREDENTIAL_ENCRYPTION_KEY, fail closed without a valid key, and never return plaintext
// when a stored value is tampered with or the key is wrong.
// Run: node --test --experimental-transform-types tests/security/credential-crypto-env.test.mjs
//
// All keys and values below are FAKE test fixtures. No real key is used.
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence console output before importing server code (test runner IPC uses stdout).
const sink = () => {};
console.log = sink;
console.info = sink;
console.warn = sink;
console.error = sink;
console.debug = sink;

const { encryptCredentialValue, decryptCredentialValue, loadCredentialKey } = await import(
  '../../server/utils/credential-crypto.ts'
);

// FAKE fixture keys: 32 bytes each, filled with a constant. Not real secrets.
const FAKE_KEY_B64 = Buffer.alloc(32, 0x5a).toString('base64');
const FAKE_WRONG_KEY_B64 = Buffer.alloc(32, 0x3c).toString('base64');
const FAKE_PLAINTEXT = 'FAKE-ELEVENLABS-KEY-0000';

const goodEnv = { CREDENTIAL_ENCRYPTION_KEY: FAKE_KEY_B64 };

test('round trip returns the original plaintext', () => {
  const stored = encryptCredentialValue(FAKE_PLAINTEXT, goodEnv);
  assert.equal(decryptCredentialValue(stored, goodEnv), FAKE_PLAINTEXT);
});

test('stored value is versioned, carries a 12-byte IV, and never contains plaintext', () => {
  const stored = encryptCredentialValue(FAKE_PLAINTEXT, goodEnv);
  const parts = stored.split(':');
  assert.equal(parts.length, 4);
  assert.equal(parts[0], 'v1');
  assert.equal(Buffer.from(parts[1], 'base64').length, 12);
  assert.equal(Buffer.from(parts[2], 'base64').length, 16);
  assert.ok(!stored.includes(FAKE_PLAINTEXT));
});

test('each encryption uses a fresh random IV', () => {
  const a = encryptCredentialValue(FAKE_PLAINTEXT, goodEnv);
  const b = encryptCredentialValue(FAKE_PLAINTEXT, goodEnv);
  assert.notEqual(a.split(':')[1], b.split(':')[1]);
  assert.notEqual(a, b);
});

test('missing key fails closed with a generic message', () => {
  assert.throws(() => encryptCredentialValue(FAKE_PLAINTEXT, {}), /CREDENTIAL_ENCRYPTION_KEY is not set/);
  const stored = encryptCredentialValue(FAKE_PLAINTEXT, goodEnv);
  assert.throws(() => decryptCredentialValue(stored, {}), /CREDENTIAL_ENCRYPTION_KEY is not set/);
});

test('wrong-length key fails closed and the message does not echo the key', () => {
  const shortKey = Buffer.alloc(16, 0x5a).toString('base64');
  assert.throws(
    () => loadCredentialKey({ CREDENTIAL_ENCRYPTION_KEY: shortKey }),
    (err) => err instanceof Error && !err.message.includes(shortKey),
  );
});

test('non-canonical base64 key (whitespace, url-safe alphabet) is rejected', () => {
  assert.throws(() => loadCredentialKey({ CREDENTIAL_ENCRYPTION_KEY: ` ${FAKE_KEY_B64}` }));
  assert.throws(() => loadCredentialKey({ CREDENTIAL_ENCRYPTION_KEY: 'not base64 at all !!' }));
});

test('decrypting with a different key throws and returns nothing', () => {
  const stored = encryptCredentialValue(FAKE_PLAINTEXT, goodEnv);
  assert.throws(() => decryptCredentialValue(stored, { CREDENTIAL_ENCRYPTION_KEY: FAKE_WRONG_KEY_B64 }));
});

test('tampered ciphertext or auth tag throws', () => {
  const [v, iv, tag, ct] = encryptCredentialValue(FAKE_PLAINTEXT, goodEnv).split(':');
  const flip = (b64) => {
    const buf = Buffer.from(b64, 'base64');
    buf[0] ^= 0x01;
    return buf.toString('base64');
  };
  assert.throws(() => decryptCredentialValue([v, iv, tag, flip(ct)].join(':'), goodEnv));
  assert.throws(() => decryptCredentialValue([v, iv, flip(tag), ct].join(':'), goodEnv));
});

test('unknown version prefix is refused', () => {
  const [, iv, tag, ct] = encryptCredentialValue(FAKE_PLAINTEXT, goodEnv).split(':');
  assert.throws(() => decryptCredentialValue(['v2', iv, tag, ct].join(':'), goodEnv), /unsupported/);
});
