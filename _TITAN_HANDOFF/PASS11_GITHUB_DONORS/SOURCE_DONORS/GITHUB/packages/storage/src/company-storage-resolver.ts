import type { StorageClient, StorageDialect } from "./index.js";

/** Minimal fields from the freshly resolved #302 CurrentSessionContext. */
export interface AuthenticatedCompanyContext {
  readonly company_id: string;
  readonly actor_id: string;
  readonly session_id: string;
  readonly session_revision: number;
  readonly context_revision: string;
  readonly audience: string;
  readonly expires_at: string;
  readonly authority_neutral: true;
}

export interface PublicCapabilityIntent {
  readonly resource_type: string;
  readonly resource_id: string;
  readonly action: string;
}

/** Normalized output of a server-side capability verifier, never request JSON. */
export interface VerifiedPublicCompanyCapability extends PublicCapabilityIntent {
  readonly company_id: string;
  /** Stable opaque revocation/rotation key (the verifier has confirmed it is current). */
  readonly capability_id: string;
  readonly expires_at: string;
}

/** Placement resolution accepts either an authenticated context or a verified
 * public capability. The public branch deliberately has no actor/session/role
 * or legacy account field. */
export type VerifiedCompanyScope =
  | Readonly<{ kind: "authenticated"; current: AuthenticatedCompanyContext }>
  | Readonly<{
      kind: "public-capability";
      capability: VerifiedPublicCompanyCapability;
      requested: PublicCapabilityIntent;
    }>;

export type CompanyPlacementStatus = "READY" | "PROVISIONING" | "MIGRATING" | "FAILED" | "DISABLED";

/** Raw, bounded control metadata read from GLOBAL_REGISTRY. It must contain no
 * company business rows. Implementations may carry other registry columns;
 * the resolver copies only these allowlisted fields into a placement lease. */
export interface CompanyPlacementRecord {
  readonly company_id: string;
  readonly placement_id: string;
  readonly placement_revision: number;
  readonly provider: StorageDialect;
  readonly schema_version: string;
  readonly status: CompanyPlacementStatus;
  /** Explicit compatibility mapping. Never sourced from a request or token. */
  readonly legacy_account_id?: string | null;
}

declare const registeredPlacementBrand: unique symbol;

/** A resolver-issued, in-process placement reference. Do not serialize it into
 * queues or accept one reconstructed from caller data; re-resolve each access. */
export type RegisteredCompanyPlacement = Readonly<{
  company_id: string;
  placement_id: string;
  placement_revision: number;
  provider: StorageDialect;
  schema_version: string;
  legacy_account_id?: string;
  readonly [registeredPlacementBrand]: true;
}>;

export type CompanyDatabasePlacementDescriptor = Readonly<Pick<
  RegisteredCompanyPlacement,
  "company_id" | "placement_id" | "placement_revision" | "provider" | "schema_version"
>>;

export interface CompanyStorageResolverOptions {
  readonly signal?: AbortSignal;
  /** Supplied internally by the resolver to revalidate scope and placement
   * after a storage operation has acquired its per-placement gate. */
  readonly assertCurrent?: () => Promise<void>;
}

export interface CompanyPlacementRegistry {
  /** Must read only trusted GLOBAL_REGISTRY placement metadata by canonical ID. */
  findByCompanyId(companyId: string, options?: CompanyStorageResolverOptions): Promise<CompanyPlacementRecord | null>;
}

/** Confirms the scope came from its canonical server-side verifier and
 * revalidates current membership or public capability revocation state. It must
 * fail closed and must not open a company business database. */
export interface CompanyScopeRevalidator {
  assertCurrent(scope: VerifiedCompanyScope, options?: CompanyStorageResolverOptions): Promise<void>;
}

export interface CompanyStoreOpenResult<Client> {
  /** Physical-store identity attested by the opener after opening the selected
   * registered placement. It must not echo unchecked request fields. */
  readonly company_id: string;
  readonly placement_id: string;
  readonly placement_revision: number;
  readonly provider: StorageDialect;
  readonly schema_version: string;
  readonly client: Client;
  /** Re-check the mounted store's physical identity before a protected effect. */
  assertPlacementBound(): Promise<void>;
}

export interface CompanyStoreOpener<Client extends { close(): Promise<void> } = StorageClient> {
  /** Open only the registered opaque placement. This port must resolve paths or
   * credentials from trusted server configuration, never from request data. */
  open(
    placement: CompanyDatabasePlacementDescriptor,
    options?: CompanyStorageResolverOptions,
  ): Promise<CompanyStoreOpenResult<Client>>;
}

export interface CompanyStoreLease<Client extends { close(): Promise<void> } = StorageClient> {
  readonly company_id: string;
  readonly placement_id: string;
  readonly placement_revision: number;
  readonly provider: StorageDialect;
  readonly schema_version: string;
  readonly legacy_account_id?: string;
  readonly client: Client;
  /** Re-check both current identity/capability and the registry placement before
   * each protected operation or long-running effect. */
  assertCurrent(options?: CompanyStorageResolverOptions): Promise<void>;
  close(): Promise<void>;
}

export interface CompanyStorageResolver<Client extends { close(): Promise<void> } = StorageClient> {
  resolve(scope: VerifiedCompanyScope, options?: CompanyStorageResolverOptions): Promise<RegisteredCompanyPlacement>;
  open(placement: RegisteredCompanyPlacement, options?: CompanyStorageResolverOptions): Promise<CompanyStoreLease<Client>>;
}

export type CompanyStorageResolutionErrorCode =
  | "resolution-aborted"
  | "scope-invalid"
  | "scope-not-current"
  | "public-capability-expired"
  | "public-capability-intent-mismatch"
  | "placement-missing"
  | "placement-invalid"
  | "placement-company-mismatch"
  | "placement-not-ready"
  | "placement-reference-unrecognized"
  | "placement-stale"
  | "placement-provider-mismatch"
  | "company-store-binding-mismatch"
  | "company-store-invalid"
  | "company-store-lease-closed";

export class CompanyStorageResolutionError extends Error {
  readonly code: CompanyStorageResolutionErrorCode;

  constructor(code: CompanyStorageResolutionErrorCode) {
    super(code);
    this.name = "CompanyStorageResolutionError";
    this.code = code;
  }
}

export interface CreateCompanyStorageResolverOptions<Client extends { close(): Promise<void> } = StorageClient> {
  readonly registry: CompanyPlacementRegistry;
  readonly scopeRevalidator: CompanyScopeRevalidator;
  readonly opener: CompanyStoreOpener<Client>;
  /** Injectable clock for deterministic expiry checks. */
  readonly now?: () => number;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond, , , rawOffsetHour, rawOffsetMinute] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
    && Number(rawHour) <= 23 && Number(rawMinute) <= 59 && Number(rawSecond) <= 59
    && (!rawOffsetHour || (Number(rawOffsetHour) <= 23 && Number(rawOffsetMinute) <= 59))
    && Number.isFinite(Date.parse(value));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CompanyStorageResolutionError("resolution-aborted");
}

function validateScope(scope: VerifiedCompanyScope, now: number): VerifiedCompanyScope {
  if (!scope || typeof scope !== "object") throw new CompanyStorageResolutionError("scope-invalid");
  if (scope.kind === "authenticated") {
    const current = scope.current;
    if (!current || !safeId(current.company_id) || !safeId(current.actor_id) || !safeId(current.session_id)
      || !safeId(current.context_revision) || !safeId(current.audience)
      || !Number.isSafeInteger(current.session_revision) || current.session_revision < 1
      || current.authority_neutral !== true || !validTimestamp(current.expires_at)
      || Date.parse(current.expires_at) <= now) {
      throw new CompanyStorageResolutionError("scope-invalid");
    }
    return Object.freeze({
      kind: "authenticated",
      current: Object.freeze({
        company_id: current.company_id,
        actor_id: current.actor_id,
        session_id: current.session_id,
        session_revision: current.session_revision,
        context_revision: current.context_revision,
        audience: current.audience,
        expires_at: current.expires_at,
        authority_neutral: true,
      }),
    });
  }
  if (scope.kind === "public-capability") {
    const { capability, requested } = scope;
    if (!capability || typeof capability !== "object" || !requested || typeof requested !== "object"
      || !safeId(capability.company_id) || !safeId(capability.capability_id)
      || !safeId(capability.resource_type) || !safeId(capability.resource_id) || !safeId(capability.action)
      || !safeId(requested.resource_type) || !safeId(requested.resource_id) || !safeId(requested.action)
      || !validTimestamp(capability.expires_at)) {
      throw new CompanyStorageResolutionError("scope-invalid");
    }
    if (Date.parse(capability.expires_at) <= now) {
      throw new CompanyStorageResolutionError("public-capability-expired");
    }
    if (capability.resource_type !== requested.resource_type || capability.resource_id !== requested.resource_id
      || capability.action !== requested.action) {
      throw new CompanyStorageResolutionError("public-capability-intent-mismatch");
    }
    return Object.freeze({
      kind: "public-capability",
      capability: Object.freeze({
        company_id: capability.company_id,
        capability_id: capability.capability_id,
        resource_type: capability.resource_type,
        resource_id: capability.resource_id,
        action: capability.action,
        expires_at: capability.expires_at,
      }),
      requested: Object.freeze({
        resource_type: requested.resource_type,
        resource_id: requested.resource_id,
        action: requested.action,
      }),
    });
  }
  throw new CompanyStorageResolutionError("scope-invalid");
}

function companyIdForScope(scope: VerifiedCompanyScope): string {
  return scope.kind === "authenticated" ? scope.current.company_id : scope.capability.company_id;
}

function validPlacementId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function normalizePlacement(record: CompanyPlacementRecord | null, expectedCompanyId: string): Omit<RegisteredCompanyPlacement, typeof registeredPlacementBrand> {
  if (!record) throw new CompanyStorageResolutionError("placement-missing");
  if (!safeId(record.company_id) || record.company_id !== expectedCompanyId) {
    throw new CompanyStorageResolutionError("placement-company-mismatch");
  }
  if (record.status !== "READY") throw new CompanyStorageResolutionError("placement-not-ready");
  if (!validPlacementId(record.placement_id) || !Number.isSafeInteger(record.placement_revision) || record.placement_revision < 1
    || !["sqlite", "postgres", "mysql"].includes(record.provider)
    || !safeId(record.schema_version)
    || (record.legacy_account_id != null && !safeId(record.legacy_account_id))) {
    throw new CompanyStorageResolutionError("placement-invalid");
  }
  const placement = {
    company_id: record.company_id,
    placement_id: record.placement_id,
    placement_revision: record.placement_revision,
    provider: record.provider,
    schema_version: record.schema_version,
    ...(record.legacy_account_id ? { legacy_account_id: record.legacy_account_id } : {}),
  };
  return Object.freeze(placement);
}

function descriptorOf(placement: RegisteredCompanyPlacement): CompanyDatabasePlacementDescriptor {
  return Object.freeze({
    company_id: placement.company_id,
    placement_id: placement.placement_id,
    placement_revision: placement.placement_revision,
    provider: placement.provider,
    schema_version: placement.schema_version,
  });
}

function samePlacement(a: RegisteredCompanyPlacement, b: RegisteredCompanyPlacement): boolean {
  return a.company_id === b.company_id && a.placement_id === b.placement_id
    && a.placement_revision === b.placement_revision && a.provider === b.provider
    && a.schema_version === b.schema_version && a.legacy_account_id === b.legacy_account_id;
}

/**
 * Reusable resolver core. It owns no database connection or persistent schema:
 * GLOBAL_REGISTRY lookup, identity/capability revalidation and physical store
 * opening are injected canonical-owner ports. A placement can only be opened
 * when it is the exact in-process object issued by this resolver, and the
 * registry record is re-read before open and before a lease is asserted current.
 */
export function createCompanyStorageResolver<Client extends { close(): Promise<void> } = StorageClient>(
  options: CreateCompanyStorageResolverOptions<Client>,
): CompanyStorageResolver<Client> {
  const now = options.now ?? Date.now;
  const placementScopes = new WeakMap<object, VerifiedCompanyScope>();

  async function currentPlacement(scope: VerifiedCompanyScope, signal?: AbortSignal): Promise<RegisteredCompanyPlacement> {
    throwIfAborted(signal);
    const checkedScope = validateScope(scope, now());
    try {
      await options.scopeRevalidator.assertCurrent(checkedScope, { signal });
    } catch {
      throw new CompanyStorageResolutionError("scope-not-current");
    }
    throwIfAborted(signal);
    // Verification may involve I/O. Re-check the local expiry boundary after
    // it completes so a slow verifier cannot authorize lookup with an expired
    // authenticated context or public capability.
    validateScope(checkedScope, now());
    const companyId = companyIdForScope(checkedScope);
    const record = await options.registry.findByCompanyId(companyId, { signal });
    throwIfAborted(signal);
    // Registry I/O can outlive the authenticated context or public capability.
    // Never issue a placement reference from a scope that expired while it was
    // waiting for the control-plane lookup.
    validateScope(checkedScope, now());
    const normalized = normalizePlacement(record, companyId) as RegisteredCompanyPlacement;
    placementScopes.set(normalized, checkedScope);
    return normalized;
  }

  async function assertPlacementCurrent(
    placement: RegisteredCompanyPlacement,
    scope: VerifiedCompanyScope,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    const checkedScope = validateScope(scope, now());
    try {
      await options.scopeRevalidator.assertCurrent(checkedScope, { signal });
    } catch {
      throw new CompanyStorageResolutionError("scope-not-current");
    }
    throwIfAborted(signal);
    // Revalidation can involve I/O. Re-check expiry before touching the
    // registry or opening a company store so an expired scope cannot cause
    // even a physical-store attestation attempt.
    validateScope(checkedScope, now());
    const companyId = companyIdForScope(checkedScope);
    const record = await options.registry.findByCompanyId(companyId, { signal });
    throwIfAborted(signal);
    // This helper gates both the pre-open lookup and open's final post-open
    // lookup. Re-check after the registry await so expiry cannot authorize an
    // opener call or let a newly expired scope receive a lease.
    validateScope(checkedScope, now());
    const current = normalizePlacement(record, companyId) as RegisteredCompanyPlacement;
    if (!samePlacement(placement, current)) throw new CompanyStorageResolutionError("placement-stale");
  }

  const resolver: CompanyStorageResolver<Client> = {
    resolve(scope: VerifiedCompanyScope, resolveOptions?: CompanyStorageResolverOptions) {
      return currentPlacement(scope, resolveOptions?.signal);
    },
    async open(placement: RegisteredCompanyPlacement, openOptions?: CompanyStorageResolverOptions) {
      const scope = placement && typeof placement === "object" ? placementScopes.get(placement) : undefined;
      if (!scope) throw new CompanyStorageResolutionError("placement-reference-unrecognized");
      await assertPlacementCurrent(placement, scope, openOptions?.signal);
      throwIfAborted(openOptions?.signal);
      const opened = await options.opener.open(descriptorOf(placement), {
        ...openOptions,
        assertCurrent: () => assertPlacementCurrent(placement, scope, openOptions?.signal),
      });
      if (openOptions?.signal?.aborted) {
        if (opened?.client && typeof opened.client.close === "function") {
          try { await opened.client.close(); } catch { /* preserve cancellation */ }
        }
        throw new CompanyStorageResolutionError("resolution-aborted");
      }
      if (!opened || !opened.client || typeof opened.client.close !== "function") {
        throw new CompanyStorageResolutionError("company-store-invalid");
      }
      if (opened.company_id !== placement.company_id || opened.placement_id !== placement.placement_id
        || opened.placement_revision !== placement.placement_revision || opened.schema_version !== placement.schema_version) {
        try { await opened.client.close(); } catch { /* preserve the binding failure */ }
        throw new CompanyStorageResolutionError("company-store-binding-mismatch");
      }
      if (opened.provider !== placement.provider) {
        try { await opened.client.close(); } catch { /* preserve the binding failure */ }
        throw new CompanyStorageResolutionError("placement-provider-mismatch");
      }
      try {
        await opened.assertPlacementBound();
      } catch {
        try { await opened.client.close(); } catch { /* preserve the binding failure */ }
        throw new CompanyStorageResolutionError("company-store-binding-mismatch");
      }
      try {
        // The registry may rotate while the physical store is opening. Do not
        // hand out a lease unless the same placement is still current after
        // the opener has attested the mounted store.
        await assertPlacementCurrent(placement, scope, openOptions?.signal);
      } catch (error) {
        try { await opened.client.close(); } catch { /* preserve the current-placement failure */ }
        throw error;
      }

      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await opened.client.close();
      };
      const lease: CompanyStoreLease<Client> = {
        company_id: placement.company_id,
        placement_id: placement.placement_id,
        placement_revision: placement.placement_revision,
        provider: placement.provider,
        schema_version: placement.schema_version,
        ...(placement.legacy_account_id ? { legacy_account_id: placement.legacy_account_id } : {}),
        client: opened.client,
        async assertCurrent(assertOptions) {
          if (closed) throw new CompanyStorageResolutionError("company-store-lease-closed");
          try {
            await assertPlacementCurrent(placement, scope, assertOptions?.signal);
            await opened.assertPlacementBound();
          } catch (error) {
            await close().catch(() => undefined);
            if (error instanceof CompanyStorageResolutionError) throw error;
            throw new CompanyStorageResolutionError("company-store-binding-mismatch");
          }
        },
        close,
      };
      return Object.freeze(lease);
    },
  };
  return Object.freeze(resolver);
}
