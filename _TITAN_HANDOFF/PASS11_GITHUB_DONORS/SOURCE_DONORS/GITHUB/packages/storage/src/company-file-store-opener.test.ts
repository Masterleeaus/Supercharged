import { chmod, mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalCompanyFileStoreOpener } from "./company-file-store-opener.js";
import { createSqliteCompanyFilePlacementRegistry, initializeSqliteCompanyPlacementRegistry } from "./company-placement-registry.js";
import { createSqliteStorage, type StorageClient } from "./index.js";

const directories: string[] = [];
const storages: StorageClient[] = [];

async function makeRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "titan-company-files-"));
  await chmod(path, 0o700);
  directories.push(path);
  return path;
}

async function registryFor(root: string, entries: Array<{ companyId: string; filePlacementId: string; status?: string }>) {
  const storage = createSqliteStorage(join(root, "global-registry.sqlite"));
  storages.push(storage);
  await initializeSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
  for (const entry of entries) {
    await storage.query(`INSERT INTO titan_company_file_placements
      (company_id, file_placement_id, file_placement_revision, provider, schema_version, status)
      VALUES ($1, $2, 1, 'localfs', 'localfs/1', $3)`, [entry.companyId, entry.filePlacementId, entry.status ?? "READY"]);
  }
  const registry = await createSqliteCompanyFilePlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
  return { storage, registry };
}

afterEach(async () => {
  await Promise.all(storages.splice(0).map(storage => storage.close()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("registry-selected company file store", () => {
  it("keeps identical object keys isolated by opaque company placement", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "placement-a"), { mode: 0o700 });
    await mkdir(join(root, "placement-b"), { mode: 0o700 });
    const { registry, storage } = await registryFor(root, [
      { companyId: "company-a", filePlacementId: "placement-a" },
      { companyId: "company-b", filePlacementId: "placement-b" },
    ]);
    const opener = createLocalCompanyFileStoreOpener({ companyFileStoreRoot: root, registry });
    const referenceA = await registry.findFileByCompanyId("company-a");
    const referenceB = await registry.findFileByCompanyId("company-b");
    if (!referenceA || !referenceB) throw new Error("test-placement-missing");
    await expect(opener.open({ ...referenceA })).rejects.toThrow();
    const [a, b] = await Promise.all([
      opener.open(referenceA),
      opener.open(referenceB),
    ]);

    await a.putObject("evidence-1", new TextEncoder().encode("company A"));
    await b.putObject("evidence-1", new TextEncoder().encode("company B"));
    expect(new TextDecoder().decode(await a.readObject("evidence-1"))).toBe("company A");
    expect(new TextDecoder().decode(await b.readObject("evidence-1"))).toBe("company B");
    await storage.query("UPDATE titan_company_file_placements SET status = 'DISABLED' WHERE company_id = $1", ["company-a"]);
    await expect(a.readObject("evidence-1")).rejects.toThrow("placement-stale");
  });

  it("rejects paths, overwrites, unready placements, and symlinked namespaces or objects", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "placement-a"), { mode: 0o700 });
    const outsideRoot = join(root, "outside-root");
    await mkdir(outsideRoot, { mode: 0o700 });
    await symlink(outsideRoot, join(root, "placement-link"));
    const { registry } = await registryFor(root, [
      { companyId: "company-a", filePlacementId: "placement-a" },
      { companyId: "company-a-unready", filePlacementId: "placement-unready", status: "PROVISIONING" },
      { companyId: "company-a-link", filePlacementId: "placement-link" },
    ]);
    const opener = createLocalCompanyFileStoreOpener({ companyFileStoreRoot: root, registry });
    const ready = await registry.findFileByCompanyId("company-a");
    const unready = await registry.findFileByCompanyId("company-a-unready");
    const linked = await registry.findFileByCompanyId("company-a-link");
    if (!ready || !unready || !linked) throw new Error("test-placement-missing");
    const store = await opener.open(ready);

    for (const key of ["../company-b", "nested/object", ".", ""]) {
      await expect(store.readObject(key)).rejects.toThrow();
    }
    await store.putObject("object-1", new Uint8Array([1, 2, 3]));
    await expect(store.putObject("object-1", new Uint8Array([4]))).rejects.toThrow();
    await symlink(join(root, "outside"), join(root, "placement-a", "linked-object"));
    await expect(store.readObject("linked-object")).rejects.toThrow();
    await expect(opener.open(unready)).rejects.toThrow();
    await expect(opener.open(linked)).rejects.toThrow();
  });

  it("rejects world-writable roots and namespace directories", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "placement-a"), { mode: 0o700 });
    const { registry } = await registryFor(root, [{ companyId: "company-a", filePlacementId: "placement-a" }]);
    const record = await registry.findFileByCompanyId("company-a");
    if (!record) throw new Error("test-placement-missing");
    const opener = createLocalCompanyFileStoreOpener({ companyFileStoreRoot: root, registry });
    await chmod(root, 0o777);
    await expect(opener.open(record)).rejects.toThrow();

    const secondRoot = await makeRoot();
    await mkdir(join(secondRoot, "placement-b"), { mode: 0o700 });
    await chmod(join(secondRoot, "placement-b"), 0o777);
    const { registry: secondRegistry } = await registryFor(secondRoot, [{ companyId: "company-b", filePlacementId: "placement-b" }]);
    const secondRecord = await secondRegistry.findFileByCompanyId("company-b");
    if (!secondRecord) throw new Error("test-placement-missing");
    const secondOpener = createLocalCompanyFileStoreOpener({ companyFileStoreRoot: secondRoot, registry: secondRegistry });
    await expect(secondOpener.open(secondRecord)).rejects.toThrow();
  });
});
