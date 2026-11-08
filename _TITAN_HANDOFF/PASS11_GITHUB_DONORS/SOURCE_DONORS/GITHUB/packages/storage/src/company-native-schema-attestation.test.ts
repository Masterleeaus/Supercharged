import { afterEach, describe, expect, it } from "vitest";
import {
  CompanyNativeSchemaAttestationError,
  computeCompanyNativeSchemaManifestDigest,
  fingerprintCompanyNativeSchema,
  verifyCompanyNativeSchemaAttestation,
  type CompanyNativeSchemaManifest,
} from "./company-native-schema-attestation.js";
import { createSqliteStorage } from "./sqlite-client.js";
import type { StorageClient } from "./index.js";

const stores: StorageClient[] = [];
const company = "company-native-a";
const migrationId = "company-native-fsm/0001-core";
const migrationHash = "a".repeat(64);

function markerSchema() {
  return `CREATE TABLE titan_company_native_schema_attestation (
    singleton_id TEXT PRIMARY KEY CHECK(singleton_id='COMPANY_NATIVE_FSM'),
    company_id TEXT NOT NULL,
    placement_id TEXT NOT NULL,
    placement_revision INTEGER NOT NULL,
    schema_version TEXT NOT NULL,
    manifest_sha256 TEXT NOT NULL,
    schema_fingerprint_sha256 TEXT NOT NULL
  );
  CREATE TABLE titan_company_native_schema_migrations (
    sequence INTEGER PRIMARY KEY,
    migration_id TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL
  );`;
}

async function fixture(overrides: {
  markerCompany?: string;
  markerPlacement?: string;
  markerRevision?: number;
  markerVersion?: string;
  markerManifestDigest?: string;
  markerFingerprint?: string;
  migrationRows?: Array<{ sequence: number; migration_id: string; sha256: string }>;
  omitMarker?: boolean;
} = {}) {
  const storage = createSqliteStorage(":memory:");
  stores.push(storage);
  await storage.query("CREATE TABLE companies (id TEXT PRIMARY KEY, name TEXT NOT NULL)");
  await storage.query("INSERT INTO companies(id,name) VALUES($1,'Company A')", [company]);
  await storage.query("CREATE TABLE work_orders (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, status TEXT NOT NULL)");
  for (const statement of markerSchema().split(";")) {
    if (statement.trim()) await storage.query(statement);
  }

  const schemaFingerprint = await fingerprintCompanyNativeSchema(storage);
  const manifest: CompanyNativeSchemaManifest = {
    format: "titan-company-native-fsm-manifest/v1",
    owner: "COMPANY_NATIVE_FSM",
    profile_id: "native-fsm-test-v1",
    schema_version: "native-fsm/test-profile-1",
    schema_scope: ["companies", "work_orders"],
    source_provenance: [{
      path: "db/sqlite/test.sql", sha256: "b".repeat(64),
      included_objects: ["companies", "work_orders"], excluded_objects: [], adaptations: [],
    }],
    schema_fingerprint_sha256: schemaFingerprint,
    migrations: [{ sequence: 1, migration_id: migrationId, path: "db/sqlite/test.sql", sha256: migrationHash }],
  };
  const manifestDigest = computeCompanyNativeSchemaManifestDigest(manifest);
  if (!overrides.omitMarker) {
    await storage.query(
      `INSERT INTO titan_company_native_schema_attestation
       (singleton_id,company_id,placement_id,placement_revision,schema_version,manifest_sha256,schema_fingerprint_sha256)
       VALUES('COMPANY_NATIVE_FSM',$1,$2,$3,$4,$5,$6)`,
      [overrides.markerCompany ?? company, overrides.markerPlacement ?? "placement-native-a",
        overrides.markerRevision ?? 7, overrides.markerVersion ?? manifest.schema_version,
        overrides.markerManifestDigest ?? manifestDigest, overrides.markerFingerprint ?? schemaFingerprint],
    );
  }
  for (const row of overrides.migrationRows ?? [{ sequence: 1, migration_id: migrationId, sha256: migrationHash }]) {
    await storage.query(
      "INSERT INTO titan_company_native_schema_migrations(sequence,migration_id,sha256) VALUES($1,$2,$3)",
      [row.sequence, row.migration_id, row.sha256],
    );
  }
  return {
    storage,
    manifest,
    placement: {
      company_id: company,
      placement_id: "placement-native-a",
      placement_revision: 7,
      provider: "sqlite" as const,
      schema_version: manifest.schema_version,
    },
  };
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(storage => storage.close()));
});

describe("native COMPANY_NATIVE_FSM schema attestation verifier", () => {
  it("verifies the physical company, exact immutable manifest, ledger and schema without writing readiness", async () => {
    const f = await fixture();
    const before = await f.storage.query("SELECT singleton_id FROM titan_company_native_schema_attestation");
    const result = await verifyCompanyNativeSchemaAttestation({
      storage: f.storage,
      placement: f.placement,
      manifest: f.manifest,
    });

    expect(result).toMatchObject({
      company_id: company,
      placement_id: "placement-native-a",
      placement_revision: 7,
      provider: "sqlite",
      schema_version: "native-fsm/test-profile-1",
    });
    expect(result.manifest_sha256).toBe(computeCompanyNativeSchemaManifestDigest(f.manifest));
    const after = await f.storage.query("SELECT singleton_id FROM titan_company_native_schema_attestation");
    expect(after.rows).toEqual(before.rows);
    const readyTables = await f.storage.query("SELECT name FROM sqlite_master WHERE name LIKE '%ready%'");
    expect(readyTables.rows).toEqual([]);
  });

  it("rejects a marker bound to another company", async () => {
    const f = await fixture({ markerCompany: "company-native-b" });
    await expect(verifyCompanyNativeSchemaAttestation({ ...f, placement: f.placement }))
      .rejects.toMatchObject({ code: "company-native-schema-company-mismatch" } satisfies Partial<CompanyNativeSchemaAttestationError>);
  });

  it("rejects a restored store with a different placement identity or revision", async () => {
    const f = await fixture();
    await expect(verifyCompanyNativeSchemaAttestation({
      ...f, placement: { ...f.placement, placement_id: "placement-restored-elsewhere" },
    })).rejects.toMatchObject({ code: "company-native-schema-placement-mismatch" } satisfies Partial<CompanyNativeSchemaAttestationError>);
    await expect(verifyCompanyNativeSchemaAttestation({
      ...f, placement: { ...f.placement, placement_revision: 8 },
    })).rejects.toMatchObject({ code: "company-native-schema-placement-mismatch" } satisfies Partial<CompanyNativeSchemaAttestationError>);
  });

  it("rejects missing marker, schema version, migration history, and physical schema drift", async () => {
    const missing = await fixture({ omitMarker: true });
    await expect(verifyCompanyNativeSchemaAttestation(missing))
      .rejects.toMatchObject({ code: "company-native-schema-marker-missing" });

    const wrongVersion = await fixture({ markerVersion: "native-fsm/unknown" });
    await expect(verifyCompanyNativeSchemaAttestation(wrongVersion))
      .rejects.toMatchObject({ code: "company-native-schema-version-mismatch" });

    const wrongLedger = await fixture({ migrationRows: [{ sequence: 1, migration_id: migrationId, sha256: "b".repeat(64) }] });
    await expect(verifyCompanyNativeSchemaAttestation(wrongLedger))
      .rejects.toMatchObject({ code: "company-native-schema-migration-ledger-mismatch" });

    const changedSchema = await fixture();
    await changedSchema.storage.query("CREATE TABLE unexpected_business_table (id TEXT PRIMARY KEY)");
    await expect(verifyCompanyNativeSchemaAttestation(changedSchema))
      .rejects.toMatchObject({ code: "company-native-schema-fingerprint-mismatch" });
  });

  it("rejects a marker copied onto an altered company-store path even when registry metadata matches", async () => {
    const f = await fixture();
    await f.storage.query("DROP TABLE work_orders");
    await f.storage.query("CREATE TABLE work_orders (id TEXT PRIMARY KEY, company_id TEXT NOT NULL)");
    await expect(verifyCompanyNativeSchemaAttestation(f))
      .rejects.toMatchObject({ code: "company-native-schema-fingerprint-mismatch" });
  });
});
