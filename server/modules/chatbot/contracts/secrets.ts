/**
 * Secret encryption port. Used for channel tokens, marketplace credentials, Calendly tokens and webhook signing secrets.
 *
 * Implementation rules (not written here):
 * - The key comes from the environment variable SECRET_KEY_ENV only. No default key, ever.
 * - The implementation FAILS CLOSED: if the variable is missing or malformed, construction throws. It does not
 *   fall back to plaintext or to a random key.
 * - The companyId is bound as associated data, so a ciphertext copied from one tenant cannot be decrypted under
 *   another. decrypt() throws when the companyId does not match the one used by encrypt().
 * - Plaintext secrets are never logged, returned to the browser, or included in an error message.
 */

export const SECRET_KEY_ENV = "CHATBOT_SECRET_KEY";

export const SECRET_BOX_ALGORITHM = "aes-256-gcm" as const;

/** Stored form of an encrypted value. Safe to keep in a database column as JSON. */
export interface SealedSecret {
  /** Format version. Bumped only when the layout changes. */
  v: 1;
  alg: typeof SECRET_BOX_ALGORITHM;
  /** Identifies which key sealed the value, so a rotated key can still open old rows. */
  keyId: string;
  /** Base64. Unique per encryption. */
  iv: string;
  /** Base64 authentication tag. */
  tag: string;
  /** Base64 ciphertext. */
  ciphertext: string;
}

export interface SecretBox {
  encrypt(companyId: string, plaintext: string): Promise<SealedSecret>;
  decrypt(companyId: string, sealed: SealedSecret): Promise<string>;
}

/** Thrown by a SecretBox implementation when the key is absent or invalid. Callers must not catch and continue. */
export interface SecretKeyError {
  code: "SECRET_KEY_MISSING" | "SECRET_KEY_INVALID" | "SECRET_DECRYPT_FAILED";
  message: string;
}
