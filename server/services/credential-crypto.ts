import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM helpers for credential columns (ElevenLabs, OpenAI, Plivo, SIP keys).
 *
 * Wire format: `v1:<iv>:<tag>:<ciphertext>` where each segment is standard base64.
 * The key is never a literal here: callers inject a provider that returns a 32-byte Buffer.
 *
 * Decryption fails closed: any malformed field, tampered byte, or wrong key throws
 * and no plaintext is returned.
 */

export type KeyProvider = () => Buffer;

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

function resolveKey(keyProvider: KeyProvider): Buffer {
  if (typeof keyProvider !== 'function') {
    throw new Error('credential-crypto: key provider must be a function');
  }
  const key = keyProvider();
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    // Never include key material in the message.
    throw new Error('credential-crypto: key provider must return a 32-byte Buffer');
  }
  return key;
}

// Strict decode: rejects anything that is not exactly the canonical base64 of its bytes.
// expectedBytes = null means any length (used for the ciphertext segment).
function decodeCanonical(value: string, expectedBytes: number | null): Buffer {
  const decoded = Buffer.from(value, 'base64');
  const lengthOk = expectedBytes === null || decoded.length === expectedBytes;
  if (!lengthOk || decoded.toString('base64') !== value) {
    throw new Error('credential-crypto: malformed ciphertext');
  }
  return decoded;
}

export function encryptCredential(plaintext: string, keyProvider: KeyProvider): string {
  if (typeof plaintext !== 'string') {
    throw new Error('credential-crypto: plaintext must be a string');
  }
  const key = resolveKey(keyProvider);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decryptCredential(encoded: string, keyProvider: KeyProvider): string {
  if (typeof encoded !== 'string') {
    throw new Error('credential-crypto: ciphertext must be a string');
  }
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('credential-crypto: unsupported or malformed ciphertext');
  }
  const iv = decodeCanonical(parts[1], IV_BYTES);
  const tag = decodeCanonical(parts[2], TAG_BYTES);
  const ciphertext = decodeCanonical(parts[3], null);

  const key = resolveKey(keyProvider);
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);

  // Nothing is returned until final() has verified the GCM tag.
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new Error('credential-crypto: authentication failed');
  }
}
