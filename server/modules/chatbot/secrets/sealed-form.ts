/**
 * The one write form and the read-compatible forms for sealed secrets in the chatbot stores.
 *
 * Write form (always used for new rows): the versioned string "<keyVersion>:<iv>:<tag>:<ciphertext>", each part base64.
 * The prefix is the key version the value was sealed with (the same string SecretBox.sealString() produces).
 * It is stored as a plain string. In a JSON or JSONB column it is stored as a JSON string, not as an object.
 *
 * Read forms (existing rows, still accepted):
 *   contract object   { v, alg, keyId, iv, tag, ciphertext } from contracts/secrets.ts, stored by earlier code.
 *
 * The bookings three-column shape is handled in bookings/secret-box.ts, because it has its own columns.
 *
 * Errors name no plaintext, key or sealed bytes.
 */
import type { SealedSecret as ContractSealedSecret, SecretBox as ContractSecretBox } from "../contracts/secrets.ts";
import { SECRET_BOX_ALGORITHM, SecretOpenError } from "./secret-box.ts";

/** What a store may hold on read: the string (current) or the contract object (legacy). */
export type StoredSealed = string | ContractSealedSecret;

const SEPARATOR = ":";
const KEY_VERSION_PATTERN = /^v[0-9]{1,9}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

function isContractShape(value: ContractSealedSecret): boolean {
  return (
    value.v === 1 &&
    value.alg === SECRET_BOX_ALGORITHM &&
    typeof value.keyId === "string" &&
    KEY_VERSION_PATTERN.test(value.keyId) &&
    typeof value.iv === "string" &&
    typeof value.tag === "string" &&
    typeof value.ciphertext === "string"
  );
}

/** Converts a contract object to the write form. Refuses anything it cannot store losslessly. */
export function toSealedString(sealed: ContractSealedSecret): string {
  if (!isContractShape(sealed)) {
    throw new TypeError("Sealed secret has an unsupported shape");
  }
  return [sealed.keyId, sealed.iv, sealed.tag, sealed.ciphertext].join(SEPARATOR);
}

/** Splits a write-form string back into the contract object. Returns null when the string is not in that form. */
export function parseSealedString(value: string): ContractSealedSecret | null {
  const fields = value.split(SEPARATOR);
  if (fields.length !== 4) return null;
  const [keyId, iv, tag, ciphertext] = fields;
  if (!KEY_VERSION_PATTERN.test(keyId)) return null;
  if (!BASE64_PATTERN.test(iv) || !BASE64_PATTERN.test(tag) || !BASE64_PATTERN.test(ciphertext)) return null;
  return { v: 1, alg: SECRET_BOX_ALGORITHM, keyId, iv, tag, ciphertext };
}

/** Seals a plaintext through the contract port and returns the write form. This is what stores persist. */
export async function sealToString(box: ContractSecretBox, companyId: string, plaintext: string): Promise<string> {
  return toSealedString(await box.encrypt(companyId, plaintext));
}

/**
 * Opens a value read from a store, in either form. A string that is not in the write form, or any other shape, fails
 * with SecretOpenError. A failed authentication fails the same way (the box throws it).
 */
export async function openStored(box: ContractSecretBox, companyId: string, stored: unknown): Promise<string> {
  if (typeof stored === "string") {
    const parsed = parseSealedString(stored);
    if (parsed === null) throw new SecretOpenError();
    return box.decrypt(companyId, parsed);
  }
  if (typeof stored === "object" && stored !== null) {
    return box.decrypt(companyId, stored as ContractSealedSecret);
  }
  throw new SecretOpenError();
}
