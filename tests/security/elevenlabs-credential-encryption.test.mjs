// Security regression test: ElevenLabs credential secrets (api_key, webhook_secret) must be
// sealed on write and opened on read in server/services/elevenlabs-pool.ts, and the module must
// fail closed when CREDENTIAL_ENCRYPTION_KEY is missing or malformed.
// Run: node --test --experimental-transform-types tests/security/elevenlabs-credential-encryption.test.mjs
//
// The pool module itself is not imported (it opens the database on load). Its wiring is checked
// against the source text. All keys and values below are FAKE test fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Silence console output before importing server code (test runner IPC uses stdout).
const sink = () => {};
console.log = sink;
console.info = sink;
console.warn = sink;
console.error = sink;
console.debug = sink;

const { encryptCredentialValue, decryptCredentialValue } = await import(
  '../../server/utils/credential-crypto.ts'
);

const POOL_PATH = fileURLToPath(new URL('../../server/services/elevenlabs-pool.ts', import.meta.url));

// FAKE fixtures. Not real secrets.
const FAKE_KEY_B64 = Buffer.alloc(32, 0x41).toString('base64');
const goodEnv = { CREDENTIAL_ENCRYPTION_KEY: FAKE_KEY_B64 };
const FAKE_API_KEY = 'FAKE-ELEVENLABS-API-KEY-0000';
const FAKE_WEBHOOK_SECRET = 'FAKE-ELEVENLABS-WEBHOOK-SECRET-0000';

test('missing key: sealing and opening both throw, nothing is stored or returned', () => {
  const stored = encryptCredentialValue(FAKE_API_KEY, goodEnv);
  assert.throws(() => encryptCredentialValue(FAKE_API_KEY, {}), /not set/);
  assert.throws(() => decryptCredentialValue(stored, {}), /not set/);
});

test('malformed key: wrong length or non-canonical base64 throws', () => {
  const shortKey = Buffer.alloc(16, 0x41).toString('base64');
  assert.throws(() => encryptCredentialValue(FAKE_API_KEY, { CREDENTIAL_ENCRYPTION_KEY: shortKey }));
  assert.throws(() => encryptCredentialValue(FAKE_API_KEY, { CREDENTIAL_ENCRYPTION_KEY: `${FAKE_KEY_B64} ` }));
});

test('round trip restores the fake api key and webhook secret', () => {
  const storedKey = encryptCredentialValue(FAKE_API_KEY, goodEnv);
  const storedSecret = encryptCredentialValue(FAKE_WEBHOOK_SECRET, goodEnv);
  assert.equal(decryptCredentialValue(storedKey, goodEnv), FAKE_API_KEY);
  assert.equal(decryptCredentialValue(storedSecret, goodEnv), FAKE_WEBHOOK_SECRET);
});

test('stored values are v1 ciphertext and contain no plaintext', () => {
  const stored = encryptCredentialValue(FAKE_API_KEY, goodEnv);
  assert.ok(stored.startsWith('v1:'));
  assert.ok(!stored.includes(FAKE_API_KEY));
});

test('a legacy plaintext value is refused, not passed through', () => {
  assert.throws(() => decryptCredentialValue(FAKE_API_KEY, goodEnv));
});

test('a value sealed under a different key does not open', () => {
  const wrongEnv = { CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 0x3c).toString('base64') };
  const stored = encryptCredentialValue(FAKE_API_KEY, goodEnv);
  assert.throws(() => decryptCredentialValue(stored, wrongEnv));
});

test('pool wiring: write path seals both secrets before insert', () => {
  const src = readFileSync(POOL_PATH, 'utf8');
  assert.match(src, /from ["']\.\.\/utils\/credential-crypto["']/);
  assert.match(src, /\.\.\.sealSecrets\(data\)/);
  assert.match(src, /encryptCredentialValue\(data\.apiKey\)/);
  assert.match(src, /encryptCredentialValue\(data\.webhookSecret\)/);
});

test('pool wiring: every raw api_key or webhook_secret read is opened', () => {
  const lines = readFileSync(POOL_PATH, 'utf8').split('\n');
  const rawReads = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /row\.(api_key|webhook_secret)/.test(line));
  assert.ok(rawReads.length >= 4, 'expected the raw row mappings to be present');
  for (const { i } of rawReads) {
    // The mapped object must be passed through openSecrets, from a few lines above the read to 25 below.
    const window = lines.slice(Math.max(0, i - 6), i + 25).join('\n');
    assert.match(window, /openSecrets\(/, `raw secret read at line ${i + 1} is not opened`);
  }
});
