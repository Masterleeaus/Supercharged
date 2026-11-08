import { createHash } from "node:crypto";
import type { StorageClient } from "./index.js";
import type { CompanyDatabasePlacementDescriptor } from "./company-storage-resolver.js";

const attestationTable = "titan_company_native_schema_attestation";
const migrationTable = "titan_company_native_schema_migrations";
const digestPattern = /^[a-f0-9]{64}$/;

/** Immutable expected profile supplied by the COMPANY_NATIVE_FSM migration owner. */
export interface CompanyNativeSchemaManifest {
  readonly format: "titan-company-native-fsm-manifest/v1";
  readonly owner: "COMPANY_NATIVE_FSM";
  readonly profile_id: string;
  readonly schema_version: string;
  /** Declared bounded schema scope; this is not a claim of full FSM coverage. */
  readonly schema_scope: readonly string[];
  /** Exact legacy SQLite source bytes used as donors for this fresh profile. */
  readonly source_provenance: readonly Readonly<{
    path: string;
    sha256: string;
    included_objects: readonly string[];
    excluded_objects: readonly string[];
    adaptations: readonly string[];
  }>[];
  /** Fingerprint of the expected SQLite schema after applying this manifest. */
  readonly schema_fingerprint_sha256: string;
  readonly migrations: readonly Readonly<{
    sequence: number;
    migration_id: string;
    path: string;
    sha256: string;
  }>[];
}

/** Metadata stored in the company DB by the provisioning/migration owner.
 * This module only reads and verifies the marker; it never creates, updates,
 * or promotes it and never changes the GLOBAL_REGISTRY READY status. */
export interface CompanyNativeSchemaMarker {
  readonly company_id: string;
  readonly placement_id: string;
  readonly placement_revision: number;
  readonly schema_version: string;
  readonly manifest_sha256: string;
  readonly schema_fingerprint_sha256: string;
}

/** Fresh, read-only verification result bound to one actual physical store. */
export interface VerifiedCompanyNativeSchemaAttestation extends CompanyNativeSchemaMarker {
  readonly provider: "sqlite";
  readonly manifest_sha256: string;
}

export type CompanyNativeSchemaAttestationErrorCode =
  | "company-native-schema-provider-unsupported"
  | "company-native-schema-store-not-fresh"
  | "company-native-schema-migration-source-mismatch"
  | "company-native-schema-manifest-invalid"
  | "company-native-schema-marker-missing"
  | "company-native-schema-marker-invalid"
  | "company-native-schema-company-mismatch"
  | "company-native-schema-placement-mismatch"
  | "company-native-schema-version-mismatch"
  | "company-native-schema-manifest-mismatch"
  | "company-native-schema-migration-ledger-mismatch"
  | "company-native-schema-fingerprint-mismatch";

export class CompanyNativeSchemaAttestationError extends Error {
  readonly code: CompanyNativeSchemaAttestationErrorCode;

  constructor(code: CompanyNativeSchemaAttestationErrorCode) {
    super(code);
    this.name = "CompanyNativeSchemaAttestationError";
    this.code = code;
  }
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function computeCompanyNativeSchemaManifestDigest(manifest: CompanyNativeSchemaManifest): string {
  validateManifest(manifest);
  const canonical = {
    format: manifest.format,
    owner: manifest.owner,
    profile_id: manifest.profile_id,
    schema_version: manifest.schema_version,
    schema_scope: manifest.schema_scope,
    source_provenance: manifest.source_provenance,
    schema_fingerprint_sha256: manifest.schema_fingerprint_sha256,
    migrations: manifest.migrations.map(entry => ({
      sequence: entry.sequence,
      migration_id: entry.migration_id,
      path: entry.path,
      sha256: entry.sha256,
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function validateManifest(manifest: CompanyNativeSchemaManifest): void {
  if (!manifest || manifest.format !== "titan-company-native-fsm-manifest/v1"
    || manifest.owner !== "COMPANY_NATIVE_FSM" || !validId(manifest.profile_id)
    || !validId(manifest.schema_version) || !Array.isArray(manifest.schema_scope)
    || manifest.schema_scope.length === 0 || manifest.schema_scope.some(item => !validId(item))
    || !Array.isArray(manifest.source_provenance) || manifest.source_provenance.length === 0
    || !digestPattern.test(manifest.schema_fingerprint_sha256)
    || !Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-manifest-invalid");
  }
  const sources = new Set<string>();
  for (const source of manifest.source_provenance) {
    if (!source || !validId(source.path) || sources.has(source.path)
      || !digestPattern.test(source.sha256) || !Array.isArray(source.included_objects)
      || source.included_objects.length === 0 || source.included_objects.some((item: string) => !validId(item))
      || !Array.isArray(source.excluded_objects) || source.excluded_objects.some((item: string) => !validId(item))
      || !Array.isArray(source.adaptations) || source.adaptations.some((item: string) => !validId(item))) {
      throw new CompanyNativeSchemaAttestationError("company-native-schema-manifest-invalid");
    }
    sources.add(source.path);
  }
  const ids = new Set<string>();
  for (let index = 0; index < manifest.migrations.length; index += 1) {
    const entry = manifest.migrations[index];
    if (!entry || entry.sequence !== index + 1 || !validId(entry.migration_id)
      || !validId(entry.path)
      || ids.has(entry.migration_id) || !digestPattern.test(entry.sha256)) {
      throw new CompanyNativeSchemaAttestationError("company-native-schema-manifest-invalid");
    }
    ids.add(entry.migration_id);
  }
}

/**
 * Fingerprint actual SQLite application schema objects. The two attestation
 * metadata tables are excluded to avoid a self-referential hash. SQLite's
 * persisted SQL is used rather than request data or `PRAGMA user_version`.
 */
export async function fingerprintCompanyNativeSchema(storage: StorageClient): Promise<string> {
  if (storage.dialect !== "sqlite") {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-provider-unsupported");
  }
  const objects = (await storage.query<{
    type: string;
    name: string;
    tbl_name: string;
    sql: string | null;
  }>(
    `SELECT type,name,tbl_name,sql FROM sqlite_master
      WHERE name NOT GLOB 'sqlite_*' AND name NOT IN ($1,$2)
      ORDER BY type,name,tbl_name`,
    [attestationTable, migrationTable],
  )).rows;
  return createHash("sha256").update(JSON.stringify(objects), "utf8").digest("hex");
}

/**
 * Verify the native migration marker, exact applied migration ledger, company
 * identity row, and live SQLite schema against the immutable native manifest.
 * Physical path/inode attestation remains the CompanyStoreOpener's job; this
 * function accepts only the already-registered opaque placement descriptor.
 */
export async function verifyCompanyNativeSchemaAttestation(input: {
  storage: StorageClient;
  placement: CompanyDatabasePlacementDescriptor;
  manifest: CompanyNativeSchemaManifest;
}): Promise<VerifiedCompanyNativeSchemaAttestation> {
  const { storage, placement, manifest } = input;
  if (placement.provider !== "sqlite" || storage.dialect !== "sqlite") {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-provider-unsupported");
  }
  validateManifest(manifest);

  let markerRows: Array<{
    company_id: unknown;
    placement_id: unknown;
    placement_revision: unknown;
    schema_version: unknown;
    manifest_sha256: unknown;
    schema_fingerprint_sha256: unknown;
  }>;
  let migrationRows: Array<{ sequence: unknown; migration_id: unknown; sha256: unknown }>;
  try {
    markerRows = (await storage.query<{
      company_id: unknown;
      placement_id: unknown;
      placement_revision: unknown;
      schema_version: unknown;
      manifest_sha256: unknown;
      schema_fingerprint_sha256: unknown;
    }>(
      `SELECT company_id,placement_id,placement_revision,schema_version,manifest_sha256,schema_fingerprint_sha256
         FROM ${attestationTable} WHERE singleton_id='COMPANY_NATIVE_FSM'`,
    )).rows;
    migrationRows = (await storage.query<{ sequence: unknown; migration_id: unknown; sha256: unknown }>(
      `SELECT sequence,migration_id,sha256 FROM ${migrationTable} ORDER BY sequence`,
    )).rows;
  } catch {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-marker-missing");
  }
  if (markerRows.length !== 1) {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-marker-missing");
  }
  const marker = markerRows[0];
  if (!validId(marker.company_id) || !validId(marker.placement_id)
    || !Number.isSafeInteger(marker.placement_revision) || Number(marker.placement_revision) < 1
    || !validId(marker.schema_version) || !digestPattern.test(String(marker.manifest_sha256))
    || !digestPattern.test(String(marker.schema_fingerprint_sha256))) {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-marker-invalid");
  }
  if (marker.company_id !== placement.company_id) {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-company-mismatch");
  }
  if (marker.placement_id !== placement.placement_id
    || marker.placement_revision !== placement.placement_revision) {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-placement-mismatch");
  }
  if (marker.schema_version !== placement.schema_version || marker.schema_version !== manifest.schema_version) {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-version-mismatch");
  }

  const manifestDigest = computeCompanyNativeSchemaManifestDigest(manifest);
  if (marker.manifest_sha256 !== manifestDigest) {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-manifest-mismatch");
  }
  const actualMigrations = migrationRows.map(row => ({
    sequence: row.sequence,
    migration_id: row.migration_id,
    sha256: row.sha256,
  }));
  if (actualMigrations.length !== manifest.migrations.length
    || actualMigrations.some((row, index) => {
      const expected = manifest.migrations[index];
      return !Number.isSafeInteger(row.sequence) || row.sequence !== expected.sequence
        || row.migration_id !== expected.migration_id || row.sha256 !== expected.sha256;
    })) {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-migration-ledger-mismatch");
  }

  let companies: Array<{ id: string }>;
  try {
    companies = (await storage.query<{ id: string }>("SELECT id FROM companies ORDER BY id")).rows;
  } catch {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-company-mismatch");
  }
  if (companies.length !== 1 || companies[0]?.id !== placement.company_id) {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-company-mismatch");
  }

  const physicalFingerprint = await fingerprintCompanyNativeSchema(storage);
  if (physicalFingerprint !== manifest.schema_fingerprint_sha256
    || marker.schema_fingerprint_sha256 !== physicalFingerprint) {
    throw new CompanyNativeSchemaAttestationError("company-native-schema-fingerprint-mismatch");
  }
  return Object.freeze({
    company_id: placement.company_id,
    placement_id: placement.placement_id,
    placement_revision: placement.placement_revision,
    provider: "sqlite",
    schema_version: manifest.schema_version,
    manifest_sha256: manifestDigest,
    schema_fingerprint_sha256: physicalFingerprint,
  });
}
