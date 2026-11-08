/**
 * Commerce credentials (Shopify access token, WooCommerce consumer key and secret).
 *
 * Port of CommerceCredentialRuntime.php and CredentialRedactor.php. Differences are logged in DECISIONS.md:
 * - Values are sealed with the injected SecretBox, with companyId as associated data. No plaintext column.
 * - Only summaries leave this module. A summary holds status, version and a fingerprint, never a value.
 * - Connection tests use an injected probe over the injected HttpClient. This module has no endpoint of its own.
 * - Errors name the field, never the value.
 */
import { createHash } from "node:crypto";
import type { CommerceCredentialStore, CommerceCredentials, HttpClient, SecretBox } from "../../contracts/index.ts";
import { openStored, sealToString, type StoredSealed } from "../../secrets/sealed-form.ts";
import { CommerceError } from "./errors.ts";

export const CREDENTIAL_PROVIDERS = ["shopify", "woocommerce"] as const;
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number];

const REQUIRED_FIELDS: Readonly<Record<CredentialProvider, readonly string[]>> = {
  shopify: ["access_token"],
  woocommerce: ["consumer_key", "consumer_secret"],
};

const SECRET_FRAGMENTS = [
  "access_token", "refresh_token", "consumer_key", "consumer_secret", "api_key",
  "client_secret", "private_key", "password", "credential", "secret",
];

/** Port of CredentialRedactor::isSecretKey. */
export function isSecretKey(key: string): boolean {
  const lower = key.trim().toLowerCase();
  return SECRET_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

/** Port of CredentialRedactor::containsSecretKey. Walks nested objects. */
export function containsSecretKey(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  return Object.entries(payload).some(([key, value]) => isSecretKey(key) || containsSecretKey(value));
}

/** Port of CredentialRedactor::redact. Use before any value is logged. */
export function redactSecrets(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  if (Array.isArray(payload)) return payload.map(redactSecrets);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key] = isSecretKey(key) ? "[REDACTED]" : redactSecrets(value);
  }
  return out;
}

export interface CredentialRecord {
  /** Doubles as the connectionId of the CommerceCredentialStore contract. */
  id: string;
  companyId: string;
  chatbotId: string;
  ownerUserId: string;
  provider: CredentialProvider;
  sealed: StoredSealed | null;
  configuration: Record<string, string | number | boolean | null>;
  fingerprint: string | null;
  status: "active" | "revoked";
  version: number;
  lastTestSucceeded: boolean | null;
  lastTestedAt: Date | null;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export interface CredentialRecordStore {
  findById(companyId: string, id: string): Promise<CredentialRecord | null>;
  findByProvider(companyId: string, chatbotId: string, provider: CredentialProvider): Promise<CredentialRecord | null>;
  /** Upsert keyed by id. The record's companyId must match the row it writes. */
  save(record: CredentialRecord): Promise<void>;
}

export interface ChatbotOwnerRef {
  companyId: string;
  chatbotId: string;
  ownerUserId: string;
}

export interface CredentialSummary {
  provider: CredentialProvider;
  configured: boolean;
  status: "missing" | "active" | "revoked";
  version: number;
  fingerprint: string | null;
  lastTestSucceeded: boolean | null;
  lastTestedAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
}

/** Reachability check for one provider. Built by the provider adapter, given the injected HttpClient. */
export type CredentialProbe = (
  provider: CredentialProvider,
  domain: string,
  credentials: CommerceCredentials,
  http: HttpClient,
) => Promise<boolean>;

export interface CredentialStoreDeps {
  records: CredentialRecordStore;
  secretBox: SecretBox;
  now: () => Date;
  newId: () => string;
}

export function fingerprintCredentials(values: Readonly<Record<string, string>>): string {
  const parts = Object.keys(values)
    .sort()
    .map((key) => `${key}:${createHash("sha256").update(values[key] ?? "", "utf8").digest("hex").slice(-12)}`);
  return createHash("sha256").update(parts.join("|"), "utf8").digest("hex");
}

export function normaliseCredentials(provider: CredentialProvider, input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of REQUIRED_FIELDS[provider]) {
    const raw = input[key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "") {
      throw new CommerceError("validation", "This credential value is required.", { [`credentials.${key}`]: "required" });
    }
    out[key] = value;
  }
  return out;
}

export interface CommerceCredentialService {
  /** Contract method. Returns decrypted credentials in memory for one call. Null when missing, revoked or another tenant. */
  load(companyId: string, connectionId: string): Promise<CommerceCredentials | null>;
  /** Contract method. Seals the values before writing. Used by the owner-checked store() below. */
  save(companyId: string, connectionId: string, provider: string, credentials: CommerceCredentials): Promise<void>;
  remove(companyId: string, connectionId: string): Promise<boolean>;
  store(owner: ChatbotOwnerRef, actorUserId: string, provider: CredentialProvider, credentials: Record<string, unknown>, configuration?: Record<string, unknown>): Promise<CredentialSummary>;
  revoke(owner: ChatbotOwnerRef, actorUserId: string, provider: CredentialProvider): Promise<CredentialSummary>;
  summary(owner: ChatbotOwnerRef, provider: CredentialProvider): Promise<CredentialSummary>;
  testConnection(owner: ChatbotOwnerRef, actorUserId: string, provider: CredentialProvider, probe: CredentialProbe, http: HttpClient): Promise<{ provider: CredentialProvider; connected: boolean; testedAt: string; error?: string }>;
}

export function createCommerceCredentialService(deps: CredentialStoreDeps): CommerceCredentialService {
  const { records, secretBox, now, newId } = deps;

  async function sealedCredentials(companyId: string, values: Record<string, string>): Promise<StoredSealed> {
    return sealToString(secretBox, companyId, JSON.stringify(values));
  }

  function assertOwner(owner: ChatbotOwnerRef, actorUserId: string): void {
    if (actorUserId.trim() === "" || owner.ownerUserId !== actorUserId) {
      throw new CommerceError("forbidden", "Only the chatbot owner can manage commerce credentials.");
    }
  }

  function toSummary(provider: CredentialProvider, record: CredentialRecord | null): CredentialSummary {
    if (record === null) {
      return { provider, configured: false, status: "missing", version: 0, fingerprint: null, lastTestSucceeded: null, lastTestedAt: null, rotatedAt: null, revokedAt: null };
    }
    return {
      provider,
      configured: record.status === "active" && record.sealed !== null,
      status: record.status,
      version: record.version,
      fingerprint: record.fingerprint,
      lastTestSucceeded: record.lastTestSucceeded,
      lastTestedAt: record.lastTestedAt?.toISOString() ?? null,
      rotatedAt: record.rotatedAt?.toISOString() ?? null,
      revokedAt: record.revokedAt?.toISOString() ?? null,
    };
  }

  async function currentRecord(owner: ChatbotOwnerRef, provider: CredentialProvider): Promise<CredentialRecord | null> {
    return records.findByProvider(owner.companyId, owner.chatbotId, provider);
  }

  const service: CommerceCredentialService = {
    async load(companyId, connectionId) {
      const record = await records.findById(companyId, connectionId);
      if (record === null || record.companyId !== companyId || record.status !== "active" || record.sealed === null) return null;
      let plaintext: string;
      try {
        plaintext = await openStored(secretBox, companyId, record.sealed);
      } catch {
        throw new CommerceError("validation", "The stored credentials could not be opened. Reconnect the store.");
      }
      return JSON.parse(plaintext) as CommerceCredentials;
    },

    async save(companyId, connectionId, provider, credentials) {
      const p = provider as CredentialProvider;
      if (!CREDENTIAL_PROVIDERS.includes(p)) throw new CommerceError("validation", "Supported credential providers are Shopify and WooCommerce.");
      const existing = await records.findById(companyId, connectionId);
      if (existing === null || existing.companyId !== companyId || existing.provider !== p) {
        throw new CommerceError("not_found", "The commerce connection was not found.");
      }
      const values = normaliseCredentials(p, { ...credentials });
      const at = now();
      await records.save({
        id: connectionId,
        companyId,
        chatbotId: existing?.chatbotId ?? "",
        ownerUserId: existing?.ownerUserId ?? "",
        provider: p,
        sealed: await sealedCredentials(companyId, values),
        configuration: existing?.configuration ?? {},
        fingerprint: fingerprintCredentials(values),
        status: "active",
        version: (existing?.version ?? 0) + 1,
        lastTestSucceeded: null,
        lastTestedAt: null,
        rotatedAt: at,
        revokedAt: null,
      });
    },

    async remove(companyId, connectionId) {
      const existing = await records.findById(companyId, connectionId);
      if (existing === null || existing.companyId !== companyId) return false;
      await records.save({ ...existing, sealed: null, status: "revoked", version: existing.version + 1, revokedAt: now() });
      return true;
    },

    async store(owner, actorUserId, provider, credentials, configuration = {}) {
      assertOwner(owner, actorUserId);
      if (containsSecretKey(configuration)) {
        throw new CommerceError("validation", "Secret values belong in the encrypted credentials payload, not configuration.", { configuration: "secret_in_configuration" });
      }
      const values = normaliseCredentials(provider, credentials);
      const existing = await currentRecord(owner, provider);
      const at = now();
      const record: CredentialRecord = {
        id: existing?.id ?? newId(),
        companyId: owner.companyId,
        chatbotId: owner.chatbotId,
        ownerUserId: owner.ownerUserId,
        provider,
        sealed: await sealedCredentials(owner.companyId, values),
        configuration: Object.fromEntries(Object.entries(configuration).filter(([, v]) => v === null || ["string", "number", "boolean"].includes(typeof v))) as CredentialRecord["configuration"],
        fingerprint: fingerprintCredentials(values),
        status: "active",
        version: (existing?.version ?? 0) + 1,
        lastTestSucceeded: null,
        lastTestedAt: null,
        rotatedAt: at,
        revokedAt: null,
      };
      await records.save(record);
      return toSummary(provider, record);
    },

    async revoke(owner, actorUserId, provider) {
      assertOwner(owner, actorUserId);
      const existing = await currentRecord(owner, provider);
      if (existing === null) return toSummary(provider, null);
      const record: CredentialRecord = { ...existing, sealed: null, status: "revoked", version: existing.version + 1, revokedAt: now() };
      await records.save(record);
      return toSummary(provider, record);
    },

    async summary(owner, provider) {
      return toSummary(provider, await currentRecord(owner, provider));
    },

    async testConnection(owner, actorUserId, provider, probe, http) {
      assertOwner(owner, actorUserId);
      const record = await currentRecord(owner, provider);
      const testedAt = now();
      const domain = String(record?.configuration.domain ?? "").trim();
      if (record === null || record.sealed === null || record.status !== "active") {
        return { provider, connected: false, testedAt: testedAt.toISOString(), error: "The store connection could not be verified." };
      }
      if (domain === "") {
        throw new CommerceError("validation", "A store domain is required.", { domain: "required" });
      }
      let connected = false;
      try {
        const values = await service.load(owner.companyId, record.id);
        connected = values !== null && (await probe(provider, domain, values, http)) === true;
      } catch {
        connected = false;
      }
      await records.save({ ...record, lastTestSucceeded: connected, lastTestedAt: testedAt });
      return connected
        ? { provider, connected: true, testedAt: testedAt.toISOString() }
        : { provider, connected: false, testedAt: testedAt.toISOString(), error: "The store connection could not be verified." };
    },
  };
  return service;
}

/** Compile-time link: the service satisfies the contract's CommerceCredentialStore. */
export function asContractCredentialStore(service: CommerceCredentialService): CommerceCredentialStore {
  return service;
}
