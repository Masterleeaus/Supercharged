import { decryptCredential, encryptCredential } from '../services/credential-crypto.ts';

/**
 * Env-backed entry points for encrypting credential columns (ElevenLabs, OpenAI, Plivo, SIP).
 *
 * The AES-256-GCM primitives live in server/services/credential-crypto.ts and are reused here,
 * not copied. This module only decides where the key comes from.
 *
 * CREDENTIAL_ENCRYPTION_KEY must be the canonical standard base64 of exactly 32 random bytes.
 * When it is missing or malformed, every call throws. There is no fallback key and no
 * plaintext passthrough.
 */

const KEY_ENV = 'CREDENTIAL_ENCRYPTION_KEY';
const KEY_BYTES = 32;

export function loadCredentialKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env[KEY_ENV];
  if (!raw) {
    throw new Error(`credential-crypto: ${KEY_ENV} is not set`);
  }
  const key = Buffer.from(raw, 'base64');
  // Canonical round-trip check rejects whitespace, url-safe alphabet and truncated input.
  if (key.length !== KEY_BYTES || key.toString('base64') !== raw) {
    // Never include the value in the message.
    throw new Error(`credential-crypto: ${KEY_ENV} must be base64 of exactly ${KEY_BYTES} bytes`);
  }
  return key;
}

export function encryptCredentialValue(plaintext: string, env: NodeJS.ProcessEnv = process.env): string {
  return encryptCredential(plaintext, () => loadCredentialKey(env));
}

export function decryptCredentialValue(stored: string, env: NodeJS.ProcessEnv = process.env): string {
  return decryptCredential(stored, () => loadCredentialKey(env));
}
