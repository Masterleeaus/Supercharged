/**
 * Connected Instagram accounts and their encrypted credentials.
 * - Credentials are one JSON object, sealed as a whole with SecretBox under the company id. Stored as the versioned
 *   string (secrets/sealed-form.ts). Rows written as the older contract object still open.
 * - A ciphertext copied to another company fails to open, so openCredentials returns null for it.
 * - publicAccountView is the only shape that may leave the server. It has no token and no secret.
 * - Nothing here logs a plaintext value.
 */
import { requireCompanyId } from "../../chatbot-scope.ts";
import type {
  ChannelCredentials,
  ChannelCredentialSource,
  SecretBox,
} from "../../contracts/index.ts";
import { openStored, sealToString, type StoredSealed } from "../../secrets/sealed-form.ts";
import { SecretOpenError } from "../../secrets/secret-box.ts";
import { INSTAGRAM_CHANNEL_KIND } from "./config.ts";

/** Keys held inside the sealed credentials. Anything else in a stored object is dropped on read. */
export const INSTAGRAM_CREDENTIAL_KEYS = [
  "app_id",
  "page_id",
  "page_name",
  "instagram_id",
  "username",
  "name",
  "picture",
  "access_token",
  "app_secret",
  "verify_token",
  "token_expires_at",
] as const;

export type InstagramCredentialKey = (typeof INSTAGRAM_CREDENTIAL_KEYS)[number];

export interface InstagramAccountRecord {
  companyId: string;
  /** Instagram business account id. */
  id: string;
  pageId: string;
  username: string | null;
  /** Read form: the versioned string, or the older contract object. Writes always produce the string. */
  sealedCredentials: StoredSealed;
  tokenExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InstagramAccountStorage {
  upsert(companyId: string, record: InstagramAccountRecord): Promise<void>;
  get(companyId: string, accountId: string): Promise<InstagramAccountRecord | null>;
  /** Accounts whose token expires at or before cutoff. Used by the refresh job. */
  listExpiringBefore(companyId: string, cutoff: Date, limit: number): Promise<InstagramAccountRecord[]>;
}

/** Keeps only the known keys, and only string values. */
export function normaliseCredentials(input: Readonly<Record<string, unknown>>): ChannelCredentials {
  const out: Record<string, string> = {};
  for (const key of INSTAGRAM_CREDENTIAL_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.length > 0) out[key] = value;
  }
  return out;
}

export async function sealCredentials(
  box: SecretBox,
  companyId: string,
  credentials: ChannelCredentials,
): Promise<string> {
  requireCompanyId(companyId);
  return sealToString(box, companyId, JSON.stringify(normaliseCredentials(credentials)));
}

/**
 * Opens sealed credentials. Returns null when the ciphertext does not belong to this company, or is damaged.
 * A missing or malformed key is not caught here, so a misconfigured server fails loudly.
 */
export async function openCredentials(
  box: SecretBox,
  companyId: string,
  sealed: StoredSealed,
): Promise<ChannelCredentials | null> {
  requireCompanyId(companyId);
  let plaintext: string;
  try {
    plaintext = await openStored(box, companyId, sealed);
  } catch (error) {
    // The box throws SecretOpenError for a failed authentication and a malformed value. Both mean "not this company's
    // or damaged", so both return null. Anything else (a missing key, for example) still propagates.
    if (error instanceof SecretOpenError || isCode(error, "SECRET_DECRYPT_FAILED")) return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(plaintext);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return normaliseCredentials(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

function isCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && (error as { code?: unknown }).code === code;
}

/** The only view that may reach a browser or an API response. The access token and app secret never appear. */
export function publicAccountView(credentials: ChannelCredentials): {
  instagramId: string | null;
  pageId: string | null;
  username: string | null;
  name: string | null;
  picture: string | null;
  tokenExpiresAt: string | null;
} {
  return {
    instagramId: credentials.instagram_id ?? null,
    pageId: credentials.page_id ?? null,
    username: credentials.username ?? null,
    name: credentials.name ?? null,
    picture: credentials.picture ?? null,
    tokenExpiresAt: credentials.token_expires_at ?? null,
  };
}

/** Credential source the framework calls before verification and send. Returns null when the account is not this company's. */
export function createInstagramCredentialSource(
  storage: InstagramAccountStorage,
  box: SecretBox,
): ChannelCredentialSource {
  return {
    async load(companyId, kind, accountId) {
      requireCompanyId(companyId);
      if (kind !== INSTAGRAM_CHANNEL_KIND) return null;
      const record = await storage.get(companyId, accountId);
      if (!record) return null;
      return openCredentials(box, companyId, record.sealedCredentials);
    },
  };
}

/** In-memory storage for tests and local runs. Every read compares company_id, as the SQL does. */
export function createMemoryInstagramAccountStorage(): InstagramAccountStorage & {
  rowsFor(companyId: string): InstagramAccountRecord[];
} {
  const rows = new Map<string, InstagramAccountRecord>();
  const key = (companyId: string, id: string) => `${companyId}\u0000${id}`;
  return {
    async upsert(companyId, record) {
      requireCompanyId(companyId);
      if (record.companyId !== companyId) throw new Error("company mismatch");
      const existing = rows.get(key(companyId, record.id));
      rows.set(key(companyId, record.id), {
        ...record,
        createdAt: existing?.createdAt ?? record.createdAt,
      });
    },
    async get(companyId, accountId) {
      requireCompanyId(companyId);
      const row = rows.get(key(companyId, accountId));
      return row && row.companyId === companyId ? { ...row } : null;
    },
    async listExpiringBefore(companyId, cutoff, limit) {
      requireCompanyId(companyId);
      return [...rows.values()]
        .filter((row) => row.companyId === companyId && row.tokenExpiresAt !== null && row.tokenExpiresAt <= cutoff)
        .sort((a, b) => (a.tokenExpiresAt?.getTime() ?? 0) - (b.tokenExpiresAt?.getTime() ?? 0))
        .slice(0, Math.max(0, limit))
        .map((row) => ({ ...row }));
    },
    rowsFor(companyId) {
      return [...rows.values()].filter((row) => row.companyId === companyId).map((row) => ({ ...row }));
    },
  };
}
