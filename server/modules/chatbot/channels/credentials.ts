/**
 * Per-channel credentials, stored encrypted. One record per (company, channel kind, account).
 *
 * Plaintext exists only inside load() and save(), for the duration of one call. The stored form is the versioned
 * SecretBox string (secrets/sealed-form.ts), with the company id bound as associated data, so a row copied to another company
 * cannot be opened there.
 *
 * Load is fail closed: a missing row, a decrypt failure, bad JSON or a malformed value all return null. The
 * pipeline then rejects the request. No error text carries a credential value.
 */
import type {
  ChannelCredentialSource,
  ChannelCredentials,
  ChannelKind,
  SecretBox,
} from "../contracts/index.ts";
import { openStored, sealToString, type StoredSealed } from "../secrets/sealed-form.ts";
import { isChannelKind } from "./framework.ts";

/** Upper bound on one credential value. Keeps a stored row small and a bad payload from being decrypted in full. */
export const MAX_CREDENTIAL_VALUE_LENGTH = 4096;
const CREDENTIAL_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export interface ChannelAccountStorage {
  /** Returns the stored value in either form: the versioned string (current) or the contract object (legacy). */
  findSealed(companyId: string, kind: ChannelKind, accountId: string): Promise<StoredSealed | null>;
  /** Always the versioned string. */
  saveSealed(companyId: string, kind: ChannelKind, accountId: string, sealed: string): Promise<void>;
}

export class ChannelCredentialError extends Error {
  readonly code: "CREDENTIALS_INVALID" | "ACCOUNT_INVALID";

  constructor(code: "CREDENTIALS_INVALID" | "ACCOUNT_INVALID", message: string) {
    super(message);
    this.name = "ChannelCredentialError";
    this.code = code;
  }
}

/**
 * Checks a credential object before it is sealed. Keys must be snake_case. Values must be non-empty strings.
 * The error names the key, never the value.
 */
export function validateCredentials(credentials: unknown): ChannelCredentials {
  if (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)) {
    throw new ChannelCredentialError("CREDENTIALS_INVALID", "Credentials must be an object");
  }
  const entries = Object.entries(credentials as Record<string, unknown>);
  if (entries.length === 0) {
    throw new ChannelCredentialError("CREDENTIALS_INVALID", "Credentials must not be empty");
  }
  for (const [key, value] of entries) {
    if (!CREDENTIAL_KEY_PATTERN.test(key)) {
      throw new ChannelCredentialError("CREDENTIALS_INVALID", "A credential key is not snake_case");
    }
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_CREDENTIAL_VALUE_LENGTH) {
      throw new ChannelCredentialError("CREDENTIALS_INVALID", `Credential "${key}" is missing or too long`);
    }
  }
  return Object.fromEntries(entries) as ChannelCredentials;
}

function checkAccount(kind: unknown, accountId: unknown): asserts kind is ChannelKind {
  if (!isChannelKind(kind)) {
    throw new ChannelCredentialError("ACCOUNT_INVALID", "Unknown channel kind");
  }
  if (typeof accountId !== "string" || accountId.length === 0 || accountId.length > 191) {
    throw new ChannelCredentialError("ACCOUNT_INVALID", "Channel account id is missing or too long");
  }
}

export interface CredentialStoreDeps {
  storage: ChannelAccountStorage;
  secretBox: SecretBox;
}

/** Seals and stores one account's credentials. */
export async function saveChannelCredentials(
  deps: CredentialStoreDeps,
  companyId: string,
  kind: ChannelKind,
  accountId: string,
  credentials: unknown,
): Promise<void> {
  if (typeof companyId !== "string" || companyId.length === 0) {
    throw new ChannelCredentialError("ACCOUNT_INVALID", "Company id is required");
  }
  checkAccount(kind, accountId);
  const valid = validateCredentials(credentials);
  const sealed = await sealToString(deps.secretBox, companyId, JSON.stringify(valid));
  await deps.storage.saveSealed(companyId, kind, accountId, sealed);
}

/**
 * Builds the ChannelCredentialSource the webhook and send pipelines use. Returns null for every failure, so the
 * caller rejects. The decrypted JSON is parsed and validated again on the way out.
 */
export function createChannelCredentialSource(deps: CredentialStoreDeps): ChannelCredentialSource {
  return {
    async load(companyId: string, kind: ChannelKind, accountId: string): Promise<ChannelCredentials | null> {
      if (typeof companyId !== "string" || companyId.length === 0) return null;
      if (!isChannelKind(kind) || typeof accountId !== "string" || accountId.length === 0) return null;

      const sealed = await deps.storage.findSealed(companyId, kind, accountId);
      if (!sealed) return null;

      try {
        const plaintext = await openStored(deps.secretBox, companyId, sealed);
        return validateCredentials(JSON.parse(plaintext));
      } catch {
        return null;
      }
    },
  };
}
