const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface EncryptedPayload {
  iv: string;
  ciphertext: string;
}

export async function encryptJson(value: unknown, secret: string): Promise<EncryptedPayload> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(plaintext),
  );
  return { iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
}

export async function decryptJson<T>(payload: EncryptedPayload, secret: string): Promise<T> {
  const key = await deriveKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(fromBase64(payload.iv)) },
    key,
    toArrayBuffer(fromBase64(payload.ciphertext)),
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 8) {
    throw new Error('Device outbox secret must contain at least eight characters.');
  }
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(encoder.encode(secret)));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
