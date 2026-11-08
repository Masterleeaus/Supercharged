import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSqliteCompanyPlacementRegistry,
  createSqliteCompanyFilePlacementRegistry,
  createSqliteCompanyPlacementRegistryWriter,
  initializeSqliteCompanyPlacementRegistry,
} from "./company-placement-registry.js";
import { createSqliteCompanyStoreOpener } from "./company-store-opener.js";
import { createCompanyStorageResolver, type VerifiedCompanyScope } from "./company-storage-resolver.js";
import { createSqliteStorage, type StorageClient } from "./index.js";

const directories: string[] = [];
const disposers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose().catch(() => undefined);
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "titan-placement-registry-"));
  directories.push(directory);
  return directory;
}

function trackStorage(filename: string): StorageClient {
  const storage = createSqliteStorage(filename);
  disposers.push(() => storage.close());
  return storage;
}

function scope(companyId: string): VerifiedCompanyScope {
  return {
    kind: "authenticated",
    current: {
      company_id: companyId,
      actor_id: `actor-${companyId}`,
      session_id: `session-${companyId}`,
      session_revision: 1,
      context_revision: "membership-revision-1",
      audience: "workforce",
      expires_at: "2026-10-03T00:00:00.000Z",
      authority_neutral: true,
    },
  };
}

const fixedNow = () => Date.parse("2026-10-02T12:00:00.000Z");

function placementRow(input: {
  companyId: string;
  placementId: string;
  revision?: number;
  status?: string;
}): readonly unknown[] {
  return [input.companyId, input.placementId, input.revision ?? 1, "sqlite", "native-fsm/1", input.status ?? "READY"];
}

async function insertPlacement(storage: StorageClient, values: readonly unknown[]): Promise<void> {
  await storage.query(
    `INSERT INTO titan_company_storage_placements
      (company_id, placement_id, placement_revision, provider, schema_version, status)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    values,
  );
}

function createCompanyDb(filename: string, companyId: string, label: string): void {
  const db = new Database(filename);
  db.exec("CREATE TABLE work_orders (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, label TEXT NOT NULL)");
  db.prepare("INSERT INTO work_orders (id, company_id, label) VALUES (?, ?, ?)").run("same-work-order", companyId, label);
  db.close();
}

function resolverFor(storage: StorageClient, companyStoreRoot: string) {
  const registry = createSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
  const opener = createSqliteCompanyStoreOpener({ companyStoreRoot });
  return registry.then(value => createCompanyStorageResolver<StorageClient>({
    registry: value,
    scopeRevalidator: { assertCurrent: async () => undefined },
    opener,
    now: fixedNow,
  }));
}

describe("persistent SQLite company placements", () => {
  it("initializes only explicit GLOBAL_REGISTRY metadata and refuses implicit startup schema creation", async () => {
    const directory = tempDirectory();
    const storage = trackStorage(join(directory, "global-registry.sqlite"));

    await expect(createSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" }))
      .rejects.toThrow("company-placement-registry-schema-unavailable");
    await expect(initializeSqliteCompanyPlacementRegistry({
      storage,
      storage_role: "COMPANY_NATIVE_FSM",
    } as unknown as { storage: StorageClient; storage_role: "GLOBAL_REGISTRY" }))
      .rejects.toThrow("company-placement-registry-storage-role-required");

    await initializeSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    await initializeSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    const tables = (await storage.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )).rows.map(row => row.name);
    expect(tables).toEqual([
      "titan_company_file_placements",
      "titan_company_storage_migrations",
      "titan_company_storage_placements",
    ]);
    await expect(createSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" }))
      .resolves.toBeDefined();
  });

  it("reopens persisted placement metadata and opens two companies from distinct physical files", async () => {
    const directory = tempDirectory();
    const companyStoreRoot = join(directory, "company-stores");
    mkdirSync(companyStoreRoot, { mode: 0o700 });
    const registryPath = join(directory, "global-registry.sqlite");
    const storage = trackStorage(registryPath);
    await initializeSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    await insertPlacement(storage, placementRow({ companyId: "company-a", placementId: "placement-a" }));
    await insertPlacement(storage, placementRow({ companyId: "company-b", placementId: "placement-b" }));

    const companyAPath = join(companyStoreRoot, "placement-a.sqlite");
    const companyBPath = join(companyStoreRoot, "placement-b.sqlite");
    createCompanyDb(companyAPath, "company-a", "A-only row");
    createCompanyDb(companyBPath, "company-b", "B-only row");
    expect(companyAPath).not.toBe(companyBPath);

    const firstResolver = await resolverFor(storage, companyStoreRoot);
    const aPlacement = await firstResolver.resolve(scope("company-a"));
    const bPlacement = await firstResolver.resolve(scope("company-b"));
    const aLease = await firstResolver.open(aPlacement);
    const bLease = await firstResolver.open(bPlacement);
    disposers.push(() => aLease.close(), () => bLease.close());
    expect((await aLease.client.query<{ company_id: string; label: string }>(
      "SELECT company_id, label FROM work_orders WHERE id = $1", ["same-work-order"],
    )).rows).toEqual([{ company_id: "company-a", label: "A-only row" }]);
    expect((await bLease.client.query<{ company_id: string; label: string }>(
      "SELECT company_id, label FROM work_orders WHERE id = $1", ["same-work-order"],
    )).rows).toEqual([{ company_id: "company-b", label: "B-only row" }]);

    await aLease.close();
    await bLease.close();
    await storage.close();
    const restartedRegistryStorage = trackStorage(registryPath);
    const restartedResolver = await resolverFor(restartedRegistryStorage, companyStoreRoot);
    const reopened = await restartedResolver.open(await restartedResolver.resolve(scope("company-a")));
    disposers.push(() => reopened.close());
    expect((await reopened.client.query<{ company_id: string; label: string }>(
      "SELECT company_id, label FROM work_orders WHERE id = $1", ["same-work-order"],
    )).rows).toEqual([{ company_id: "company-a", label: "A-only row" }]);
  });

  it("reserves opaque placements in PROVISIONING and uses compare-and-set for failure state", async () => {
    const directory = tempDirectory();
    const storage = trackStorage(join(directory, "global-registry.sqlite"));
    await initializeSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    const writer = await createSqliteCompanyPlacementRegistryWriter({ storage, storage_role: "GLOBAL_REGISTRY" });
    const reader = await createSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });

    const reserved = await writer.beginProvisioning({ company_id: "company-a", schema_version: "native-fsm/1" });
    expect(reserved.database).toMatchObject({ company_id: "company-a", status: "PROVISIONING", provider: "sqlite", placement_revision: 1 });
    expect(reserved.database.placement_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(reserved.files).toMatchObject({ company_id: "company-a", status: "PROVISIONING", provider: "localfs", file_placement_revision: 1 });
    expect(reserved.files.file_placement_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(await reader.findByCompanyId("company-a")).toEqual(reserved.database);
    const fileRegistry = await createSqliteCompanyFilePlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    expect(await fileRegistry.findFileByCompanyId("company-a")).toEqual(reserved.files);
    await expect(writer.beginProvisioning({ company_id: "company-a", schema_version: "native-fsm/1" }))
      .rejects.toThrow();

    await expect(writer.setUnavailable({
      company_id: "company-a", placement_id: reserved.database.placement_id,
      placement_revision: reserved.database.placement_revision, expected_status: "PROVISIONING", status: "FAILED",
    })).resolves.toMatchObject({ database: { status: "FAILED" }, files: { status: "FAILED" } });
    await expect(writer.setUnavailable({
      company_id: "company-a", placement_id: reserved.database.placement_id,
      placement_revision: reserved.database.placement_revision, expected_status: "PROVISIONING", status: "DISABLED",
    })).rejects.toMatchObject({ code: "placement-stale" });
    expect(Object.keys(writer).sort()).toEqual(["beginProvisioning", "setUnavailable"]);
  });

  it("upgrades the existing v1 database registry without inventing a ready file mapping", async () => {
    const directory = tempDirectory();
    const storage = trackStorage(join(directory, "global-registry.sqlite"));
    await storage.query("CREATE TABLE titan_company_storage_migrations (version INTEGER PRIMARY KEY)");
    await storage.query("INSERT INTO titan_company_storage_migrations (version) VALUES (1)");
    await storage.query(`CREATE TABLE titan_company_storage_placements (
      company_id TEXT PRIMARY KEY NOT NULL,
      placement_id TEXT NOT NULL UNIQUE,
      placement_revision INTEGER NOT NULL,
      provider TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      status TEXT NOT NULL
    )`);
    await insertPlacement(storage, placementRow({ companyId: "legacy-company", placementId: "legacy-db" }));

    await initializeSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    const databaseRegistry = await createSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    const fileRegistry = await createSqliteCompanyFilePlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    expect(await databaseRegistry.findByCompanyId("legacy-company")).toMatchObject({ placement_id: "legacy-db", status: "READY" });
    expect(await fileRegistry.findFileByCompanyId("legacy-company")).toBeNull();
  });

  it("fails closed for missing, unready, and revision-changed persistent placements", async () => {
    const directory = tempDirectory();
    const companyStoreRoot = join(directory, "company-stores");
    mkdirSync(companyStoreRoot, { mode: 0o700 });
    const storage = trackStorage(join(directory, "global-registry.sqlite"));
    await initializeSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    const resolver = await resolverFor(storage, companyStoreRoot);

    await expect(resolver.resolve(scope("company-missing"))).rejects.toMatchObject({ code: "placement-missing" });
    await insertPlacement(storage, placementRow({ companyId: "company-a", placementId: "placement-a", status: "PROVISIONING" }));
    await expect(resolver.resolve(scope("company-a"))).rejects.toMatchObject({ code: "placement-not-ready" });

    await storage.query(
      "UPDATE titan_company_storage_placements SET status = 'READY' WHERE company_id = $1",
      ["company-a"],
    );
    const oldPlacement = await resolver.resolve(scope("company-a"));
    await storage.query(
      "UPDATE titan_company_storage_placements SET placement_id = $1, placement_revision = 2 WHERE company_id = $2",
      ["placement-a-v2", "company-a"],
    );
    await expect(resolver.open(oldPlacement)).rejects.toMatchObject({ code: "placement-stale" });
  });

  it("rechecks registry readiness inside a queued opener transaction after resolver admission", async () => {
    const directory = tempDirectory();
    const companyStoreRoot = join(directory, "company-stores");
    mkdirSync(companyStoreRoot, { mode: 0o700 });
    const storage = trackStorage(join(directory, "global-registry.sqlite"));
    await initializeSqliteCompanyPlacementRegistry({ storage, storage_role: "GLOBAL_REGISTRY" });
    await insertPlacement(storage, placementRow({ companyId: "company-a", placementId: "placement-a", status: "READY" }));
    createCompanyDb(join(companyStoreRoot, "placement-a.sqlite"), "company-a", "initial row");
    const resolver = await resolverFor(storage, companyStoreRoot);
    const lease = await resolver.open(await resolver.resolve(scope("company-a")));

    await storage.query("UPDATE titan_company_storage_placements SET status='FAILED' WHERE company_id=$1", ["company-a"]);
    await expect(lease.client.query(
      "INSERT INTO work_orders(id,company_id,label) VALUES($1,$2,$3)", ["late-write", "company-a", "late"],
    )).rejects.toMatchObject({ code: "placement-not-ready" });
    const inspection = trackStorage(join(companyStoreRoot, "placement-a.sqlite"));
    expect((await inspection.query("SELECT id FROM work_orders WHERE id='late-write'")).rows).toEqual([]);
    await lease.close();
  });

  it("rejects traversal, missing files, symlinks, and replacement of an opened store", async () => {
    const directory = tempDirectory();
    const companyStoreRoot = join(directory, "company-stores");
    mkdirSync(companyStoreRoot, { mode: 0o700 });
    const opener = createSqliteCompanyStoreOpener({ companyStoreRoot });
    const descriptor = {
      company_id: "company-a",
      placement_id: "../company-b",
      placement_revision: 1,
      provider: "sqlite" as const,
      schema_version: "native-fsm/1",
    };
    await expect(opener.open(descriptor)).rejects.toMatchObject({ code: "company-store-invalid" });

    const missing = { ...descriptor, placement_id: "missing-placement" };
    await expect(opener.open(missing)).rejects.toMatchObject({ code: "company-store-invalid" });
    expect(existsSync(join(companyStoreRoot, "missing-placement.sqlite"))).toBe(false);

    const outsidePath = join(directory, "outside.sqlite");
    createCompanyDb(outsidePath, "company-b", "outside");
    symlinkSync(outsidePath, join(companyStoreRoot, "linked-placement.sqlite"));
    await expect(opener.open({ ...missing, placement_id: "linked-placement" }))
      .rejects.toMatchObject({ code: "company-store-invalid" });

    const validPath = join(companyStoreRoot, "placement-a.sqlite");
    createCompanyDb(validPath, "company-a", "inside");
    const opened = await opener.open({ ...missing, placement_id: "placement-a" });
    const backupPath = `${validPath}.original`;
    renameSync(validPath, backupPath);
    symlinkSync(outsidePath, validPath);
    await expect(opened.assertPlacementBound())
      .rejects.toMatchObject({ code: "company-store-binding-mismatch" });
    await opened.client.close();
  });

  it("rejects a symlink as the configured company-store root", () => {
    const directory = tempDirectory();
    const companyStoreRoot = join(directory, "company-stores");
    mkdirSync(companyStoreRoot, { mode: 0o700 });
    const rootAlias = join(directory, "company-store-alias");
    symlinkSync(companyStoreRoot, rootAlias, "dir");
    expect(() => createSqliteCompanyStoreOpener({ companyStoreRoot: rootAlias }))
      .toThrow("company-store-invalid");
  });
});
