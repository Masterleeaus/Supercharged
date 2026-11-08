import { describe, expect, it, vi } from "vitest";
import {
  CompanyStorageResolutionError,
  createCompanyStorageResolver,
  type CompanyPlacementRecord,
  type CompanyStoreOpenResult,
  type CompanyStoreOpener,
  type CompanyStoreLease,
  type VerifiedCompanyScope,
} from "./company-storage-resolver.js";

type TestClient = { close: () => Promise<void> };

const now = () => Date.parse("2026-10-02T12:00:00.000Z");
const authenticatedScope: VerifiedCompanyScope = {
  kind: "authenticated",
  current: {
    company_id: "company-a",
    actor_id: "actor-7",
    session_id: "session-4",
    session_revision: 3,
    context_revision: "membership-12",
    audience: "titan-web",
    expires_at: "2026-10-03T12:00:00.000Z",
    authority_neutral: true,
  },
};
const publicScope: VerifiedCompanyScope = {
  kind: "public-capability",
  capability: {
    company_id: "company-a",
    capability_id: "public-link-epoch-8",
    resource_type: "estimate",
    resource_id: "estimate-22",
    action: "view",
    expires_at: "2026-10-03T12:00:00.000Z",
  },
  requested: { resource_type: "estimate", resource_id: "estimate-22", action: "view" },
};

function placement(overrides: Partial<CompanyPlacementRecord> = {}): CompanyPlacementRecord {
  return {
    company_id: "company-a",
    placement_id: "placement-a-v3",
    placement_revision: 3,
    provider: "sqlite",
    schema_version: "native-fsm/1",
    status: "READY",
    legacy_account_id: "legacy-account-a",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise; });
  return { promise, resolve };
}

function setup(options: {
  record?: CompanyPlacementRecord | null;
  assertCurrent?: (scope: VerifiedCompanyScope) => Promise<void>;
  open?: (
    descriptor: Parameters<CompanyStoreOpener<TestClient>["open"]>[0],
    setRecord: (record: CompanyPlacementRecord | null) => void,
  ) => Promise<CompanyStoreOpenResult<TestClient>>;
  findByCompanyId?: (
    companyId: string,
    callNumber: number,
  ) => Promise<CompanyPlacementRecord | null> | CompanyPlacementRecord | null;
  now?: () => number;
} = {}) {
  const events: string[] = [];
  let currentRecord = options.record === undefined ? placement() : options.record;
  let registryCalls = 0;
  const client: TestClient = { close: vi.fn(async () => { events.push("close"); }) };
  const registry = {
    findByCompanyId: vi.fn(async (companyId: string) => {
      events.push(`registry:${companyId}`);
      registryCalls += 1;
      if (options.findByCompanyId) return options.findByCompanyId(companyId, registryCalls);
      return currentRecord;
    }),
    setRecord(record: CompanyPlacementRecord | null) { currentRecord = record; },
  };
  const scopeRevalidator = {
    assertCurrent: vi.fn(async (scope: VerifiedCompanyScope) => {
      events.push(`scope:${scope.kind}`);
      await options.assertCurrent?.(scope);
    }),
  };
  const opener = {
    open: vi.fn(async (descriptor: Parameters<CompanyStoreOpener<TestClient>["open"]>[0]) => {
      events.push(`open:${descriptor.placement_id}`);
      return options.open ? options.open(descriptor, registry.setRecord) : {
        ...descriptor,
        provider: "sqlite" as const,
        client,
        assertPlacementBound: async () => { events.push(`attest:${descriptor.placement_id}`); },
      };
    }),
  };
  const resolver = createCompanyStorageResolver<TestClient>({
    registry,
    scopeRevalidator,
    opener,
    now: options.now ?? now,
  });
  return { events, registry, scopeRevalidator, opener, resolver, client, setRecord: registry.setRecord };
}

describe("company storage resolver contract", () => {
  it("resolves authenticated current company context through registry metadata only", async () => {
    const f = setup();
    const result = await f.resolver.resolve(authenticatedScope);

    expect(f.events).toEqual(["scope:authenticated", "registry:company-a"]);
    expect(result).toMatchObject({
      company_id: "company-a",
      placement_id: "placement-a-v3",
      placement_revision: 3,
      provider: "sqlite",
      legacy_account_id: "legacy-account-a",
    });
    expect("actor_id" in result).toBe(false);
  });

  it("keeps public capability identity separate and revalidates before placement lookup", async () => {
    const f = setup();
    const result = await f.resolver.resolve(publicScope);

    expect(f.events).toEqual(["scope:public-capability", "registry:company-a"]);
    expect(result.company_id).toBe("company-a");
    expect(result.legacy_account_id).toBe("legacy-account-a");
    expect("actor_id" in publicScope).toBe(false);
    expect(f.scopeRevalidator.assertCurrent).toHaveBeenCalledWith(publicScope, { signal: undefined });
  });

  it("rejects a public link bound to another resource or action before registry access", async () => {
    const f = setup();
    const wrongIntent: VerifiedCompanyScope = {
      ...publicScope,
      requested: { resource_type: "estimate", resource_id: "estimate-23", action: "respond" },
    };

    await expect(f.resolver.resolve(wrongIntent)).rejects.toMatchObject({
      code: "public-capability-intent-mismatch",
    } satisfies Partial<CompanyStorageResolutionError>);
    expect(f.registry.findByCompanyId).not.toHaveBeenCalled();
    expect(f.opener.open).not.toHaveBeenCalled();
  });

  it("rejects expired or revoked public capabilities before registry access", async () => {
    const f = setup();
    const expired: VerifiedCompanyScope = {
      ...publicScope,
      capability: { ...publicScope.capability, expires_at: "2026-10-02T11:59:59.000Z" },
    };
    await expect(f.resolver.resolve(expired)).rejects.toMatchObject({ code: "public-capability-expired" });
    expect(f.registry.findByCompanyId).not.toHaveBeenCalled();

    const revoked = setup({ assertCurrent: async () => { throw new Error("revoked"); } });
    await expect(revoked.resolver.resolve(publicScope)).rejects.toMatchObject({ code: "scope-not-current" });
    expect(revoked.events).toEqual(["scope:public-capability"]);
    expect(revoked.registry.findByCompanyId).not.toHaveBeenCalled();
  });

  it("rechecks expiry after a slow server-side scope verifier", async () => {
    let currentTime = now();
    const expiringScope: VerifiedCompanyScope = {
      ...publicScope,
      capability: { ...publicScope.capability, expires_at: "2026-10-02T12:00:00.500Z" },
    };
    const f = setup({
      now: () => currentTime,
      assertCurrent: async () => { currentTime += 1000; },
    });

    await expect(f.resolver.resolve(expiringScope)).rejects.toMatchObject({ code: "public-capability-expired" });
    expect(f.registry.findByCompanyId).not.toHaveBeenCalled();
    expect(f.opener.open).not.toHaveBeenCalled();
  });

  it("does not issue a placement when scope expires during the initial registry lookup", async () => {
    let currentTime = now();
    const expiringScope: VerifiedCompanyScope = {
      ...publicScope,
      capability: { ...publicScope.capability, expires_at: "2026-10-02T12:00:00.500Z" },
    };
    const lookup = deferred<CompanyPlacementRecord | null>();
    const lookupStarted = deferred<void>();
    const f = setup({
      now: () => currentTime,
      findByCompanyId: (_companyId, callNumber) => {
        if (callNumber === 1) {
          lookupStarted.resolve(undefined);
          return lookup.promise;
        }
        return placement();
      },
    });
    const resolving = f.resolver.resolve(expiringScope);

    await lookupStarted.promise;
    currentTime += 1000;
    lookup.resolve(placement());

    await expect(resolving).rejects.toMatchObject({ code: "public-capability-expired" });
    expect(f.registry.findByCompanyId).toHaveBeenCalledTimes(1);
    expect(f.opener.open).not.toHaveBeenCalled();
  });

  it("does not call the store opener when scope expires during placement revalidation", async () => {
    let currentTime = now();
    let verifierCalls = 0;
    const expiringScope: VerifiedCompanyScope = {
      ...publicScope,
      capability: { ...publicScope.capability, expires_at: "2026-10-02T12:00:00.500Z" },
    };
    const f = setup({
      now: () => currentTime,
      assertCurrent: async () => {
        verifierCalls += 1;
        if (verifierCalls === 2) currentTime += 1000;
      },
    });
    const resolved = await f.resolver.resolve(expiringScope);

    await expect(f.resolver.open(resolved)).rejects.toMatchObject({ code: "public-capability-expired" });
    expect(f.registry.findByCompanyId).toHaveBeenCalledTimes(1);
    expect(f.opener.open).not.toHaveBeenCalled();
    expect(f.events).toEqual(["scope:public-capability", "registry:company-a", "scope:public-capability"]);
  });

  it("does not call the store opener when scope expires during the pre-open registry lookup", async () => {
    let currentTime = now();
    const expiringScope: VerifiedCompanyScope = {
      ...publicScope,
      capability: { ...publicScope.capability, expires_at: "2026-10-02T12:00:00.500Z" },
    };
    const lookup = deferred<CompanyPlacementRecord | null>();
    const lookupStarted = deferred<void>();
    const f = setup({
      now: () => currentTime,
      findByCompanyId: (_companyId, callNumber) => {
        if (callNumber === 2) {
          lookupStarted.resolve(undefined);
          return lookup.promise;
        }
        return placement();
      },
    });
    const resolved = await f.resolver.resolve(expiringScope);
    const opening = f.resolver.open(resolved);

    await lookupStarted.promise;
    currentTime += 1000;
    lookup.resolve(placement());

    await expect(opening).rejects.toMatchObject({ code: "public-capability-expired" });
    expect(f.registry.findByCompanyId).toHaveBeenCalledTimes(2);
    expect(f.opener.open).not.toHaveBeenCalled();
    expect(f.events).toEqual([
      "scope:public-capability", "registry:company-a",
      "scope:public-capability", "registry:company-a",
    ]);
  });

  it("closes the opened store when scope expires during the final registry lookup", async () => {
    let currentTime = now();
    const expiringScope: VerifiedCompanyScope = {
      ...publicScope,
      capability: { ...publicScope.capability, expires_at: "2026-10-02T12:00:00.500Z" },
    };
    const openedClient: TestClient = { close: vi.fn(async () => undefined) };
    const lookup = deferred<CompanyPlacementRecord | null>();
    const lookupStarted = deferred<void>();
    const f = setup({
      now: () => currentTime,
      findByCompanyId: (_companyId, callNumber) => {
        if (callNumber === 3) {
          lookupStarted.resolve(undefined);
          return lookup.promise;
        }
        return placement();
      },
      open: async descriptor => ({
        ...descriptor,
        provider: "sqlite",
        client: openedClient,
        assertPlacementBound: async () => undefined,
      }),
    });
    const resolved = await f.resolver.resolve(expiringScope);
    const opening = f.resolver.open(resolved);

    await lookupStarted.promise;
    currentTime += 1000;
    lookup.resolve(placement());

    await expect(opening).rejects.toMatchObject({ code: "public-capability-expired" });
    expect(f.registry.findByCompanyId).toHaveBeenCalledTimes(3);
    expect(f.opener.open).toHaveBeenCalledTimes(1);
    expect(openedClient.close).toHaveBeenCalledTimes(1);
  });

  it("fails closed for absent, mismatched, unready, or invalid placement records", async () => {
    const cases: Array<[CompanyPlacementRecord | null, string]> = [
      [null, "placement-missing"],
      [placement({ company_id: "company-b" }), "placement-company-mismatch"],
      [placement({ status: "MIGRATING" }), "placement-not-ready"],
      [placement({ placement_revision: 0 }), "placement-invalid"],
      [placement({ placement_id: "../company-b" }), "placement-invalid"],
      [placement({ legacy_account_id: "  " }), "placement-invalid"],
    ];
    for (const [record, code] of cases) {
      const f = setup({ record });
      await expect(f.resolver.resolve(authenticatedScope)).rejects.toMatchObject({ code });
      expect(f.opener.open).not.toHaveBeenCalled();
    }
  });

  it("ignores caller-provided placement paths and gives the opener only allowlisted registry metadata", async () => {
    const f = setup({ record: {
      ...placement(),
      database_url: "postgres://attacker/other-company",
      path: "/tmp/attacker.db",
    } as CompanyPlacementRecord });
    const resolved = await f.resolver.resolve({
      ...authenticatedScope,
      current: { ...authenticatedScope.current, account_id: "attacker-account" } as typeof authenticatedScope.current,
    });
    await f.resolver.open(resolved);

    expect(f.opener.open).toHaveBeenCalledWith({
      company_id: "company-a",
      placement_id: "placement-a-v3",
      placement_revision: 3,
      provider: "sqlite",
      schema_version: "native-fsm/1",
    }, expect.objectContaining({ assertCurrent: expect.any(Function) }));
    expect(f.events).not.toContain("registry:attacker-account");
  });

  it("rejects forged and stale placement references without opening them", async () => {
    const f = setup();
    const resolved = await f.resolver.resolve(authenticatedScope);
    await expect(f.resolver.open({ ...resolved })).rejects.toMatchObject({
      code: "placement-reference-unrecognized",
    });
    f.setRecord(placement({ placement_revision: 4, placement_id: "placement-a-v4" }));
    await expect(f.resolver.open(resolved)).rejects.toMatchObject({ code: "placement-stale" });
    expect(f.opener.open).not.toHaveBeenCalled();
  });

  it("opens only a current registered placement and lease revalidates identity and revision", async () => {
    const f = setup();
    const resolved = await f.resolver.resolve(publicScope);
    const lease: CompanyStoreLease<TestClient> = await f.resolver.open(resolved);

    expect(f.events).toEqual([
      "scope:public-capability", "registry:company-a",
      "scope:public-capability", "registry:company-a", "open:placement-a-v3", "attest:placement-a-v3",
      "scope:public-capability", "registry:company-a",
    ]);
    expect(lease).toMatchObject({
      company_id: "company-a",
      placement_id: "placement-a-v3",
      placement_revision: 3,
      legacy_account_id: "legacy-account-a",
      client: f.client,
    });
    await lease.assertCurrent();
    expect(f.events.slice(-3)).toEqual(["scope:public-capability", "registry:company-a", "attest:placement-a-v3"]);
    f.setRecord(placement({ placement_revision: 4 }));
    await expect(lease.assertCurrent()).rejects.toMatchObject({ code: "placement-stale" });
    await lease.close();
    await lease.close();
    expect(f.client.close).toHaveBeenCalledTimes(1);
    await expect(lease.assertCurrent()).rejects.toMatchObject({ code: "company-store-lease-closed" });
  });

  it("closes an opened store if its placement rotates while opening", async () => {
    const openedClient: TestClient = { close: vi.fn(async () => undefined) };
    const f = setup({
      open: async (descriptor, setRecord) => {
        setRecord(placement({ placement_id: "placement-a-v4", placement_revision: 4 }));
        return {
          ...descriptor,
          provider: "sqlite",
          client: openedClient,
          assertPlacementBound: async () => undefined,
        };
      },
    });
    const resolved = await f.resolver.resolve(authenticatedScope);

    await expect(f.resolver.open(resolved)).rejects.toMatchObject({ code: "placement-stale" });
    expect(openedClient.close).toHaveBeenCalledTimes(1);
  });

  it("closes and rejects an opener result whose provider differs from the registry", async () => {
    const client: TestClient = { close: vi.fn(async () => undefined) };
    const f = setup({ open: async descriptor => ({ ...descriptor, provider: "postgres", client, assertPlacementBound: async () => undefined }) });
    const resolved = await f.resolver.resolve(authenticatedScope);

    await expect(f.resolver.open(resolved)).rejects.toMatchObject({ code: "placement-provider-mismatch" });
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("closes a store whose physical identity does not match its registry placement", async () => {
    const client: TestClient = { close: vi.fn(async () => undefined) };
    const f = setup({ open: async descriptor => ({
      ...descriptor,
      company_id: "company-b",
      provider: "sqlite",
      client,
      assertPlacementBound: async () => undefined,
    }) });
    const resolved = await f.resolver.resolve(authenticatedScope);

    await expect(f.resolver.open(resolved)).rejects.toMatchObject({ code: "company-store-binding-mismatch" });
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
