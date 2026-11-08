/**
 * The one SecretBox for every chatbot secret store. AES-256-GCM, one implementation, several views of the same output.
 *
 * Keyring. Every key is exactly 32 bytes, base64 encoded. The keys are read and checked when createSecretBox() runs.
 *   CHATBOT_SECRET_KEY              required. The v1 key. Always registered under version "v1" (back compatible).
 *   CHATBOT_SECRET_KEYRING          optional. JSON object mapping version to base64 key, e.g. {"v2":"<base64>"}.
 *                                   Use it to add newer keys and to keep older ones openable during rotation.
 *   CHATBOT_SECRET_KEY_VERSION      optional. The current version, used for every seal. Default "v1".
 *                                   It must name a key in the keyring.
 * A missing, empty, or wrong-length key, a malformed keyring, or an unknown current version throws SecretKeyError.
 * There is no default key and no plaintext fallback.
 *
 * Sealing: always with the current version, a fresh random 12-byte IV for every seal. The 16-byte GCM auth tag is kept
 * with the ciphertext. When the caller passes a companyId, it is bound as associated data (AAD). Opening with a
 * different companyId fails.
 *
 * Opening: the version is read from the stored value and that key is used. A version that is not in the keyring fails
 * closed with the same generic SecretOpenError as any other failed open.
 *
 * Canonical stored form: a versioned string, "<version>:<iv>:<tag>:<ciphertext>", each part base64 (base64 has no ':').
 * The prefix is the key version. The layout is unchanged from the single-key form, so existing "v1:" rows still open.
 *
 * Views (same keyring, same bytes, no second implementation):
 *   sealString / openString   the canonical versioned string
 *   encrypt / decrypt         the contracts/secrets.ts port: async, companyId required, object form with v, alg, keyId
 *   seal / open               the bookings shape: three separate base64 columns (iv, tag, ciphertext) plus an optional
 *                             keyId. Without keyId, open uses "v1", which is what every existing row was sealed with.
 *
 * Errors never include the plaintext, the key, the sealed bytes, or the keyring contents.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const SECRET_KEY_ENV = "CHATBOT_SECRET_KEY";
export const SECRET_KEYRING_ENV = "CHATBOT_SECRET_KEYRING";
export const SECRET_KEY_VERSION_ENV = "CHATBOT_SECRET_KEY_VERSION";

/** Version name of the CHATBOT_SECRET_KEY key, and the default current version. */
export const LEGACY_SECRET_KEY_VERSION = "v1";
/** Layout version of the sealed string. The key version is carried in the same prefix position. */
export const SECRET_FORMAT_VERSION = "v1";
/** Key identifier of the original single key. New seals use the current keyring version instead. */
export const SECRET_KEY_ID = "v1";
export const SECRET_BOX_ALGORITHM = "aes-256-gcm" as const;

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEPARATOR = ":";
const VERSION_PATTERN = /^v[0-9]{1,9}$/;

export type EnvLike = Readonly<Record<string, string | undefined>>;

/** Bookings shape: three base64 values, stored in three columns. keyId is the key version, if one was recorded. */
export interface SealedSecret {
  iv: string;
  tag: string;
  ciphertext: string;
  keyId?: string;
}

/** Contract shape (contracts/secrets.ts): a JSON object with the version, algorithm and key id beside the parts. */
export interface ContractSealedSecret {
  v: 1;
  alg: typeof SECRET_BOX_ALGORITHM;
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface SecretBox {
  sealString(plaintext: string, companyId?: string): string;
  openString(sealed: string, companyId?: string): string;
  encrypt(companyId: string, plaintext: string): Promise<ContractSealedSecret>;
  decrypt(companyId: string, sealed: ContractSealedSecret): Promise<string>;
  seal(plaintext: string): SealedSecret;
  open(sealed: SealedSecret): string;
}

export class SecretKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretKeyError";
  }
}

/** Generic failure for any open that does not authenticate. Says nothing about which check failed. */
export class SecretOpenError extends Error {
  constructor() {
    super("Sealed secret could not be opened");
    this.name = "SecretOpenError";
  }
}

/** Decodes one base64 key and checks it is exactly 32 bytes. The error names the setting, never the value. */
function decodeKey(raw: string, setting: string): Buffer {
  const decoded = Buffer.from(raw, "base64");
  // Canonical check: the value must round-trip through base64 exactly, which rejects stray characters and padding errors.
  if (decoded.length !== KEY_BYTES || decoded.toString("base64") !== raw) {
    throw new SecretKeyError(`${setting} must be base64 that decodes to exactly ${KEY_BYTES} bytes.`);
  }
  return decoded;
}

interface Keyring {
  keys: ReadonlyMap<string, Buffer>;
  current: string;
}

function readKeyring(env: EnvLike): Keyring {
  const v1Raw = env[SECRET_KEY_ENV];
  if (v1Raw === undefined || v1Raw === "") {
    throw new SecretKeyError(`${SECRET_KEY_ENV} is not set. Refusing to create a secret box without a key.`);
  }
  const keys = new Map<string, Buffer>();
  keys.set(LEGACY_SECRET_KEY_VERSION, decodeKey(v1Raw, SECRET_KEY_ENV));

  const ringRaw = env[SECRET_KEYRING_ENV];
  if (ringRaw !== undefined && ringRaw !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(ringRaw);
    } catch {
      // The parser message can echo part of its input, so it is replaced with a fixed one.
      throw new SecretKeyError(`${SECRET_KEYRING_ENV} must be a JSON object mapping version to base64 key.`);
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new SecretKeyError(`${SECRET_KEYRING_ENV} must be a JSON object mapping version to base64 key.`);
    }
    for (const [version, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!VERSION_PATTERN.test(version)) {
        throw new SecretKeyError(`${SECRET_KEYRING_ENV} version names must look like v1, v2, and so on.`);
      }
      if (typeof value !== "string") {
        throw new SecretKeyError(`${SECRET_KEYRING_ENV} entry ${version} must be a base64 string.`);
      }
      const key = decodeKey(value, `${SECRET_KEYRING_ENV} entry ${version}`);
      const existing = keys.get(version);
      if (existing === undefined) {
        keys.set(version, key);
      } else if (!existing.equals(key)) {
        throw new SecretKeyError(
          version === LEGACY_SECRET_KEY_VERSION
            ? `${SECRET_KEYRING_ENV} entry v1 conflicts with ${SECRET_KEY_ENV}.`
            : `${SECRET_KEYRING_ENV} lists version ${version} more than once with different keys.`,
        );
      }
    }
  }

  const currentRaw = env[SECRET_KEY_VERSION_ENV];
  const current = currentRaw === undefined || currentRaw === "" ? LEGACY_SECRET_KEY_VERSION : currentRaw;
  if (!VERSION_PATTERN.test(current) || !keys.has(current)) {
    throw new SecretKeyError(`${SECRET_KEY_VERSION_ENV} must name a version present in the keyring.`);
  }
  return { keys, current };
}

function aadFor(companyId: string | undefined): Buffer | undefined {
  if (companyId === undefined) return undefined;
  if (typeof companyId !== "string" || companyId.length === 0) {
    throw new TypeError("companyId must be a non-empty string");
  }
  return Buffer.from(companyId, "utf8");
}

function assertPlaintext(plaintext: unknown): asserts plaintext is string {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new TypeError("Only a non-empty string can be sealed");
  }
}

function decodeParts(iv: string, tag: string, ciphertext: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const ivBytes = Buffer.from(iv, "base64");
  const tagBytes = Buffer.from(tag, "base64");
  const ctBytes = Buffer.from(ciphertext, "base64");
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES || ctBytes.length === 0) {
    throw new SecretOpenError();
  }
  return { iv: ivBytes, tag: tagBytes, ciphertext: ctBytes };
}

/** Builds a SecretBox. Throws SecretKeyError at construction when a key is missing, malformed, or the wrong length. */
export function createSecretBox(options: { env?: EnvLike } = {}): SecretBox {
  const { keys, current } = readKeyring(options.env ?? process.env);
  const currentKey = keys.get(current);
  if (currentKey === undefined) throw new SecretKeyError(`${SECRET_KEY_VERSION_ENV} must name a version present in the keyring.`);

  const sealParts = (plaintext: string, aad: Buffer | undefined) => {
    assertPlaintext(plaintext);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(SECRET_BOX_ALGORITHM, currentKey, iv, { authTagLength: TAG_BYTES });
    if (aad) cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") };
  };

  const openParts = (
    parts: { iv: string; tag: string; ciphertext: string },
    aad: Buffer | undefined,
    key: Buffer,
  ): string => {
    const decoded = decodeParts(parts.iv, parts.tag, parts.ciphertext);
    try {
      const decipher = createDecipheriv(SECRET_BOX_ALGORITHM, key, decoded.iv, { authTagLength: TAG_BYTES });
      if (aad) decipher.setAAD(aad);
      decipher.setAuthTag(decoded.tag);
      // Throws when the tag does not match (wrong key, wrong companyId, or tampered bytes). No partial output is returned.
      const plaintext = Buffer.concat([decipher.update(decoded.ciphertext), decipher.final()]);
      return plaintext.toString("utf8");
    } catch {
      throw new SecretOpenError();
    }
  };

  /** Looks up the key for a stored version. An unknown or malformed version fails closed with the generic error. */
  const keyFor = (version: unknown): Buffer => {
    if (typeof version !== "string") throw new SecretOpenError();
    const key = keys.get(version);
    if (key === undefined) throw new SecretOpenError();
    return key;
  };

  return {
    sealString(plaintext, companyId) {
      const parts = sealParts(plaintext, aadFor(companyId));
      return [current, parts.iv, parts.tag, parts.ciphertext].join(SEPARATOR);
    },

    openString(sealed, companyId) {
      if (typeof sealed !== "string") throw new SecretOpenError();
      const fields = sealed.split(SEPARATOR);
      if (fields.length !== 4) {
        throw new SecretOpenError();
      }
      const key = keyFor(fields[0]);
      return openParts({ iv: fields[1], tag: fields[2], ciphertext: fields[3] }, aadFor(companyId), key);
    },

    async encrypt(companyId, plaintext) {
      const parts = sealParts(plaintext, aadFor(companyId));
      return { v: 1, alg: SECRET_BOX_ALGORITHM, keyId: current, ...parts };
    },

    async decrypt(companyId, sealed) {
      if (sealed.v !== 1 || sealed.alg !== SECRET_BOX_ALGORITHM) {
        throw new SecretOpenError();
      }
      const key = keyFor(sealed.keyId);
      return openParts(sealed, aadFor(companyId), key);
    },

    seal(plaintext) {
      const parts = sealParts(plaintext, undefined);
      return { ...parts, keyId: current };
    },

    open(sealed) {
      // Rows sealed before keyId existed were all written with the v1 key.
      const key = keyFor(sealed.keyId ?? LEGACY_SECRET_KEY_VERSION);
      return openParts(sealed, undefined, key);
    },
  };
}
