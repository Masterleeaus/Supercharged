/**
 * Bookings view of the SecretBox. The SecretBox itself lives in server/modules/chatbot/secrets/secret-box.ts, which
 * reads CHATBOT_SECRET_KEY when it is built. This file wraps it so the key is read on the first token operation,
 * not at construction. A deployment with no key can build bookings storage; the first token call fails closed.
 *
 * The first attempt is cached: the box (or the SecretKeyError it threw) is kept, and a later call rethrows that
 * same error. A key set after the first token call is not picked up.
 *
 * Token columns. The current write form is one versioned string ("<keyVersion>:<iv>:<tag>:<ciphertext>") in the
 * ciphertext column, with the iv and tag columns null. Rows written before that have all three columns set, and still
 * open. The two layouts are told apart by the iv and tag columns, since a legacy row never has them null.
 */
import {
  SECRET_KEY_ENV,
  SecretKeyError,
  createSecretBox as createEagerSecretBox,
  type EnvLike,
  type SealedSecret,
  type SecretBox,
} from "../secrets/secret-box.ts";

export { SECRET_KEY_ENV, SecretKeyError, type EnvLike, type SealedSecret, type SecretBox };

/** Token columns in the current write form. */
export interface CalendlyTokenColumns {
  calendlyTokenIv: null;
  calendlyTokenTag: null;
  calendlyTokenCiphertext: string;
}

/** Token columns as read from a row, in either layout. */
export interface CalendlyTokenRow {
  calendlyTokenIv: string | null;
  calendlyTokenTag: string | null;
  calendlyTokenCiphertext: string | null;
}

/** Seals a token into the current write form. No companyId is bound, as in the legacy three-column form. */
export function sealCalendlyTokenColumns(box: SecretBox, plaintext: string): CalendlyTokenColumns {
  return { calendlyTokenIv: null, calendlyTokenTag: null, calendlyTokenCiphertext: box.sealString(plaintext) };
}

/** Opens a stored token from either layout. Returns null when no token is stored. */
export function openCalendlyTokenColumns(box: SecretBox, row: CalendlyTokenRow): string | null {
  if (row.calendlyTokenCiphertext === null) return null;
  if (row.calendlyTokenIv === null && row.calendlyTokenTag === null) {
    return box.openString(row.calendlyTokenCiphertext);
  }
  return box.open({
    iv: row.calendlyTokenIv ?? "",
    tag: row.calendlyTokenTag ?? "",
    ciphertext: row.calendlyTokenCiphertext,
  });
}

/** Builds a bookings SecretBox. Nothing is read from the environment until a method is called. */
export function createSecretBox(options: { env?: EnvLike } = {}): SecretBox {
  let box: SecretBox | undefined;
  let failure: unknown;
  let failed = false;

  const ready = (): SecretBox => {
    if (box) return box;
    if (failed) throw failure;
    try {
      box = createEagerSecretBox(options);
      return box;
    } catch (err) {
      failed = true;
      failure = err;
      throw err;
    }
  };

  return {
    sealString: (plaintext, companyId) => ready().sealString(plaintext, companyId),
    openString: (sealed, companyId) => ready().openString(sealed, companyId),
    encrypt: async (companyId, plaintext) => ready().encrypt(companyId, plaintext),
    decrypt: async (companyId, sealed) => ready().decrypt(companyId, sealed),
    seal: (plaintext) => ready().seal(plaintext),
    open: (sealed) => ready().open(sealed),
  };
}
