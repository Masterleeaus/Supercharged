import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCompanyFileStorageResolver } from "./company-file-storage-resolver.js";
import { createSqliteCompanyFilePlacementRegistry, initializeSqliteCompanyPlacementRegistry } from "./company-placement-registry.js";
import { createSqliteStorage, type StorageClient } from "./index.js";

const roots: string[] = [];
const clients: StorageClient[] = [];
const scope = (company_id: string) => ({ kind: "authenticated" as const, current: {
  company_id, actor_id: "actor-1", session_id: "session-1", session_revision: 1,
  context_revision: "context-1", audience: "titan-web", expires_at: "2099-01-01T00:00:00Z", authority_neutral: true as const,
} });

afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe("company file storage resolver", () => {
  it("requires current authenticated company scope and passes only its registered placement to the opener", async () => {
    const root = await mkdtemp(join(tmpdir(), "titan-file-resolver-"));
    roots.push(root);
    const storage = createSqliteStorage(join(root, "registry.sqlite"));
    clients.push(storage);
    await initializeSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    await storage.query(`INSERT INTO titan_company_file_placements
      (company_id, file_placement_id, file_placement_revision, provider, schema_version, status)
      VALUES ('company-a', 'files-a', 1, 'localfs', 'localfs/1', 'READY'),
             ('company-b', 'files-b', 1, 'localfs', 'localfs/1', 'READY'),
             ('company-c', 'files-c', 1, 'localfs', 'localfs/1', 'PROVISIONING')`);
    const registry = await createSqliteCompanyFilePlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    const assertCurrent = vi.fn(async () => undefined);
    const open = vi.fn(async () => ({ company_id: "company-a", file_placement_id: "files-a", file_placement_revision: 1,
      putObject: vi.fn(), readObject: vi.fn() }));
    const resolver = createCompanyFileStorageResolver({ registry, scopeRevalidator: { assertCurrent }, opener: { open } });

    const placement = await resolver.resolve(scope("company-a"));
    expect(placement.company_id).toBe("company-a");
    expect((await resolver.open(placement)).company_id).toBe("company-a");
    expect(assertCurrent).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledWith(placement);
    await expect(resolver.resolve(scope("company-missing"))).rejects.toThrow("placement-missing");
    await expect(resolver.resolve(scope("company-c"))).rejects.toThrow("placement-not-ready");
    await expect(resolver.open({ ...placement })).rejects.toThrow("placement-reference-unrecognized");
  });

  it("revalidates scope and placement before opening and rejects stale cross-company references", async () => {
    const root = await mkdtemp(join(tmpdir(), "titan-file-resolver-"));
    roots.push(root);
    const storage = createSqliteStorage(join(root, "registry.sqlite"));
    clients.push(storage);
    await initializeSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    await storage.query(`INSERT INTO titan_company_file_placements
      (company_id, file_placement_id, file_placement_revision, provider, schema_version, status)
      VALUES ('company-a', 'files-a', 1, 'localfs', 'localfs/1', 'READY')`);
    const registry = await createSqliteCompanyFilePlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    const assertCurrent = vi.fn(async () => undefined);
    const open = vi.fn(async () => ({ company_id: "company-a", file_placement_id: "files-a", file_placement_revision: 1,
      putObject: vi.fn(), readObject: vi.fn() }));
    const resolver = createCompanyFileStorageResolver({ registry, scopeRevalidator: { assertCurrent }, opener: { open } });
    const placement = await resolver.resolve(scope("company-a"));
    await storage.query("UPDATE titan_company_file_placements SET file_placement_revision = 2 WHERE company_id = 'company-a'");
    await expect(resolver.open(placement)).rejects.toThrow("placement-stale");
    expect(open).not.toHaveBeenCalled();
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
});
