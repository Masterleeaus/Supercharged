/**
 * Anonymous visitor id. Random, created in the browser, kept in localStorage when it is available.
 * It is not a customer id and it carries no personal data.
 */
export const VISITOR_STORAGE_KEY = "titan-chat-visitor";
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
const VISITOR_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function newVisitorId(random: (n: number) => Uint8Array = defaultRandom): string {
  const bytes = random(22);
  let out = "";
  for (let i = 0; i < 22; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function defaultRandom(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

/** Reads the stored id, or creates and stores one. Storage errors (private mode, blocked) fall back to memory. */
export function getVisitorId(store: KeyValueStore | null, random?: (n: number) => Uint8Array): string {
  try {
    const existing = store?.getItem(VISITOR_STORAGE_KEY);
    if (existing && VISITOR_PATTERN.test(existing)) return existing;
    const id = newVisitorId(random);
    store?.setItem(VISITOR_STORAGE_KEY, id);
    return id;
  } catch {
    return newVisitorId(random);
  }
}
