import type { StorageClient } from "./index.js";
import { randomUUID } from "node:crypto";
import {
  CompanyStorageResolutionError,
  type CompanyPlacementRecord,
  type CompanyPlacementRegistry,
  type CompanyPlacementStatus,
  type CompanyStorageResolverOptions,
} from "./company-storage-resolver.js";

const migrationTable = "titan_company_storage_migrations";
const placementTable = "titan_company_storage_placements";
const filePlacementTable = "titan_company_file_placements";
const schemaVersion = 2;
const placementStatuses = ["READY", "PROVISIONING", "MIGRATING", "FAILED", "DISABLED"] as const;

export interface GlobalRegistryStorageInput {
  readonly storage: StorageClient;
  readonly storage_role: "GLOBAL_REGISTRY";
}

export interface CompanyPlacementRegistryWriter {
  /** Atomically reserve database and file placements before provisioning. */
  beginProvisioning(input: { company_id: string; schema_version: string }): Promise<{
    database: CompanyPlacementRecord;
    files: CompanyFilePlacementRecord;
  }>;
  /** Record a failed or disabled placement without changing its physical identity. */
  setUnavailable(input: {
    company_id: string;
    placement_id: string;
    placement_revision: number;
    expected_status: "PROVISIONING" | "MIGRATING" | "READY";
    status: "FAILED" | "DISABLED";
  }): Promise<{ database: CompanyPlacementRecord; files: CompanyFilePlacementRecord | null }>;
}

export interface CompanyFilePlacementRecord {
  readonly company_id: string;
  readonly file_placement_id: string;
  readonly file_placement_revision: number;
  readonly provider: "localfs";
  readonly schema_version: string;
  readonly status: CompanyPlacementStatus;
}

declare const registeredCompanyFilePlacementBrand: unique symbol;
export type RegisteredCompanyFilePlacement = Readonly<CompanyFilePlacementRecord & {
  readonly [registeredCompanyFilePlacementBrand]: true;
}>;

const registeredFilePlacements = new WeakSet<object>();

/** True only for a file placement reference returned by the trusted registry adapter. */
export function isRegisteredCompanyFilePlacement(value: unknown): value is RegisteredCompanyFilePlacement {
  return typeof value === "object" && value !== null && registeredFilePlacements.has(value);
}

export interface CompanyFilePlacementRegistry {
  findFileByCompanyId(companyId: string, options?: CompanyStorageResolverOptions): Promise<RegisteredCompanyFilePlacement | null>;
}

function requireGlobalRegistry(input: GlobalRegistryStorageInput): StorageClient {
  if (!input || input.storage_role !== "GLOBAL_REGISTRY") {
    throw new Error("company-placement-registry-storage-role-required");
  }
  if (input.storage?.dialect !== "sqlite") {
    throw new Error("company-placement-registry-storage-dialect-unsupported");
  }
  return input.storage;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validPlacementId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

/**
 * Explicit additive GLOBAL_REGISTRY schema setup. This is never called by the
 * read adapter or storage opener; deployment/migration owners must decide when
 * to apply it. Tests call it only against disposable registry files.
 */
export async function initializeSqliteCompanyPlacementRegistry(
  input: GlobalRegistryStorageInput,
): Promise<void> {
  const storage = requireGlobalRegistry(input);
  await storage.transaction(async tx => {
    await tx.query(`CREATE TABLE IF NOT EXISTS ${migrationTable} (version INTEGER PRIMARY KEY)`);
    const versions = (await tx.query<{ version: number }>(
      `SELECT version FROM ${migrationTable} ORDER BY version`,
    )).rows;
    if (versions.length === 0) {
      const existing = await tx.query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1",
        [placementTable],
      );
      if (existing.rows.length !== 0) throw new Error("company-placement-registry-schema-version-missing");
      await tx.query(`CREATE TABLE ${placementTable} (
        company_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(company_id)) > 0),
        placement_id TEXT NOT NULL UNIQUE CHECK (length(placement_id) BETWEEN 1 AND 128),
        placement_revision INTEGER NOT NULL CHECK (placement_revision > 0),
        provider TEXT NOT NULL CHECK (provider = 'sqlite'),
        schema_version TEXT NOT NULL CHECK (length(trim(schema_version)) > 0),
        status TEXT NOT NULL CHECK (status IN ('READY', 'PROVISIONING', 'MIGRATING', 'FAILED', 'DISABLED'))
      )`);
      await tx.query(`INSERT INTO ${migrationTable} (version) VALUES (1)`);
    } else if (!(versions.length === 1 && versions[0].version === 1)
      && !(versions.length === 2 && versions[0].version === 1 && versions[1].version === 2)) {
      throw new Error("company-placement-registry-schema-unsupported");
    }
    if (versions.length === 2 && versions[1].version === schemaVersion) {
      await tx.query(`SELECT company_id, placement_id, placement_revision, provider, schema_version, status FROM ${placementTable} LIMIT 0`);
      await tx.query(`SELECT company_id, file_placement_id, file_placement_revision, provider, schema_version, status FROM ${filePlacementTable} LIMIT 0`);
      return;
    }
    const existingFileTable = await tx.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = $1", [filePlacementTable],
    );
    if (existingFileTable.rows.length !== 0) throw new Error("company-file-placement-schema-version-missing");
    await tx.query(`CREATE TABLE ${filePlacementTable} (
      company_id TEXT PRIMARY KEY NOT NULL CHECK (length(trim(company_id)) > 0),
      file_placement_id TEXT NOT NULL UNIQUE CHECK (length(file_placement_id) BETWEEN 1 AND 128),
      file_placement_revision INTEGER NOT NULL CHECK (file_placement_revision > 0),
      provider TEXT NOT NULL CHECK (provider = 'localfs'),
      schema_version TEXT NOT NULL CHECK (length(trim(schema_version)) > 0),
      status TEXT NOT NULL CHECK (status IN ('READY', 'PROVISIONING', 'MIGRATING', 'FAILED', 'DISABLED'))
    )`);
    // Existing database placements deliberately receive no READY file mapping.
    // A provisioning owner must create and verify the file namespace first.
    await tx.query(`INSERT INTO ${migrationTable} (version) VALUES ($1)`, [schemaVersion]);
  });
}

type PlacementRow = {
  company_id: unknown;
  placement_id: unknown;
  placement_revision: unknown;
  provider: unknown;
  schema_version: unknown;
  status: unknown;
};

type FilePlacementRow = {
  company_id: unknown;
  file_placement_id: unknown;
  file_placement_revision: unknown;
  provider: unknown;
  schema_version: unknown;
  status: unknown;
};

function placementFromRow(row: PlacementRow): CompanyPlacementRecord {
  if (!validId(row.company_id) || !validPlacementId(row.placement_id)
    || !Number.isSafeInteger(row.placement_revision) || Number(row.placement_revision) < 1
    || row.provider !== "sqlite" || !validId(row.schema_version)
    || typeof row.status !== "string" || !placementStatuses.includes(row.status as CompanyPlacementStatus)) {
    throw new CompanyStorageResolutionError("placement-invalid");
  }
  return Object.freeze({
    company_id: row.company_id,
    placement_id: row.placement_id,
    placement_revision: row.placement_revision as number,
    provider: "sqlite",
    schema_version: row.schema_version,
    status: row.status as CompanyPlacementStatus,
  });
}

function filePlacementFromRow(row: FilePlacementRow): RegisteredCompanyFilePlacement {
  if (!validId(row.company_id) || !validPlacementId(row.file_placement_id)
    || !Number.isSafeInteger(row.file_placement_revision) || Number(row.file_placement_revision) < 1
    || row.provider !== "localfs" || !validId(row.schema_version)
    || typeof row.status !== "string" || !placementStatuses.includes(row.status as CompanyPlacementStatus)) {
    throw new CompanyStorageResolutionError("placement-invalid");
  }
  const record = Object.freeze({
    company_id: row.company_id,
    file_placement_id: row.file_placement_id,
    file_placement_revision: row.file_placement_revision as number,
    provider: "localfs",
    schema_version: row.schema_version,
    status: row.status as CompanyPlacementStatus,
  });
  registeredFilePlacements.add(record);
  return record as RegisteredCompanyFilePlacement;
}

/** Create a read-only adapter over the existing, separately supplied registry. */
export async function createSqliteCompanyPlacementRegistry(
  input: GlobalRegistryStorageInput,
): Promise<CompanyPlacementRegistry> {
  const storage = requireGlobalRegistry(input);
  let versions: Array<{ version: number }>;
  try {
    versions = (await storage.query<{ version: number }>(
      `SELECT version FROM ${migrationTable} ORDER BY version`,
    )).rows;
  } catch {
    throw new Error("company-placement-registry-schema-unavailable");
  }
  if (!(versions.length === 1 && versions[0].version === 1)
    && !(versions.length === 2 && versions[0].version === 1 && versions[1].version === schemaVersion)) {
    throw new Error("company-placement-registry-schema-unavailable");
  }
  // Verify the expected table/columns now so missing or incompatible schema
  // fails during trusted composition rather than on the first business request.
  await storage.query(`SELECT company_id, placement_id, placement_revision, provider, schema_version, status FROM ${placementTable} LIMIT 0`);
  if (versions.length === 2) {
    await storage.query(`SELECT company_id, file_placement_id, file_placement_revision, provider, schema_version, status FROM ${filePlacementTable} LIMIT 0`);
  }

  return Object.freeze({
    async findByCompanyId(companyId: string, options?: CompanyStorageResolverOptions) {
      if (options?.signal?.aborted) throw new CompanyStorageResolutionError("resolution-aborted");
      if (!validId(companyId)) throw new CompanyStorageResolutionError("placement-invalid");
      const rows = (await storage.query<PlacementRow>(
        `SELECT company_id, placement_id, placement_revision, provider, schema_version, status
           FROM ${placementTable}
          WHERE company_id = $1`,
        [companyId],
      )).rows;
      if (options?.signal?.aborted) throw new CompanyStorageResolutionError("resolution-aborted");
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw new CompanyStorageResolutionError("placement-invalid");
      return placementFromRow(rows[0]);
    },
  });
}

export async function createSqliteCompanyFilePlacementRegistry(
  input: GlobalRegistryStorageInput,
): Promise<CompanyFilePlacementRegistry> {
  const storage = requireGlobalRegistry(input);
  const versions = (await storage.query<{ version: number }>(
    `SELECT version FROM ${migrationTable} ORDER BY version`,
  )).rows;
  if (versions.length !== 2 || versions[0].version !== 1 || versions[1].version !== schemaVersion) {
    throw new Error("company-file-placement-registry-schema-unavailable");
  }
  await storage.query(`SELECT company_id, file_placement_id, file_placement_revision, provider, schema_version, status FROM ${filePlacementTable} LIMIT 0`);
  return Object.freeze({
    async findFileByCompanyId(companyId: string, options?: CompanyStorageResolverOptions) {
      if (options?.signal?.aborted) throw new CompanyStorageResolutionError("resolution-aborted");
      if (!validId(companyId)) throw new CompanyStorageResolutionError("placement-invalid");
      const rows = (await storage.query<FilePlacementRow>(
        `SELECT company_id, file_placement_id, file_placement_revision, provider, schema_version, status
           FROM ${filePlacementTable} WHERE company_id = $1`, [companyId],
      )).rows;
      if (options?.signal?.aborted) throw new CompanyStorageResolutionError("resolution-aborted");
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw new CompanyStorageResolutionError("placement-invalid");
      return filePlacementFromRow(rows[0]);
    },
  });
}

/**
 * Create the narrowly scoped GLOBAL_REGISTRY mutation port used by a trusted
 * provisioning owner. It can reserve placements and fail/disable them, but it
 * deliberately cannot mark a placement READY: only an owner that performs the
 * physical database, schema and file health checks may do that transition.
 */
export async function createSqliteCompanyPlacementRegistryWriter(
  input: GlobalRegistryStorageInput,
): Promise<CompanyPlacementRegistryWriter> {
  const storage = requireGlobalRegistry(input);
  // Reuse the reader's schema validation before exposing any mutation API.
  await createSqliteCompanyPlacementRegistry(input);
  await createSqliteCompanyFilePlacementRegistry(input);
  return Object.freeze({
    async beginProvisioning({ company_id, schema_version }: { company_id: string; schema_version: string }) {
      if (!validId(company_id) || !validId(schema_version)) {
        throw new CompanyStorageResolutionError("placement-invalid");
      }
      const record = Object.freeze({
        company_id,
        placement_id: randomUUID(),
        placement_revision: 1,
        provider: "sqlite" as const,
        schema_version,
        status: "PROVISIONING" as const,
      });
      const files = Object.freeze({
        company_id,
        file_placement_id: randomUUID(),
        file_placement_revision: 1,
        provider: "localfs" as const,
        schema_version: "localfs/1",
        status: "PROVISIONING" as const,
      });
      return storage.transaction(async tx => {
        const existing = await tx.query<PlacementRow>(
          `SELECT company_id, placement_id, placement_revision, provider, schema_version, status
             FROM ${placementTable} WHERE company_id = $1`, [company_id],
        );
        const existingFiles = await tx.query<FilePlacementRow>(
          `SELECT company_id, file_placement_id, file_placement_revision, provider, schema_version, status
             FROM ${filePlacementTable} WHERE company_id = $1`, [company_id],
        );
        if (existing.rowCount === 0 && existingFiles.rowCount === 0) {
          await tx.query(
            `INSERT INTO ${placementTable}
              (company_id, placement_id, placement_revision, provider, schema_version, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [record.company_id, record.placement_id, record.placement_revision, record.provider,
              record.schema_version, record.status],
          );
          await tx.query(
            `INSERT INTO ${filePlacementTable}
              (company_id, file_placement_id, file_placement_revision, provider, schema_version, status)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [files.company_id, files.file_placement_id, files.file_placement_revision, files.provider,
              files.schema_version, files.status],
          );
          return Object.freeze({ database: record, files });
        }
        if (existing.rowCount !== 1 || existingFiles.rowCount !== 1
          || existing.rows[0].status !== "FAILED" || existingFiles.rows[0].status !== "FAILED"
          || !Number.isSafeInteger(existing.rows[0].placement_revision)
          || !Number.isSafeInteger(existingFiles.rows[0].file_placement_revision)) {
          throw new Error("company-placement-already-registered");
        }
        const dbRevision = Number(existing.rows[0].placement_revision) + 1;
        const fileRevision = Number(existingFiles.rows[0].file_placement_revision) + 1;
        if (!Number.isSafeInteger(dbRevision) || !Number.isSafeInteger(fileRevision)) {
          throw new Error("company-placement-revision-exhausted");
        }
        const nextDatabase = Object.freeze({ ...record, placement_revision: dbRevision });
        const nextFiles = Object.freeze({ ...files, file_placement_revision: fileRevision });
        const dbChanged = await tx.query(
          `UPDATE ${placementTable} SET placement_id=$1, placement_revision=$2,
              schema_version=$3, status='PROVISIONING'
            WHERE company_id=$4 AND placement_revision=$5 AND status='FAILED'`,
          [nextDatabase.placement_id, dbRevision, nextDatabase.schema_version, company_id,
            existing.rows[0].placement_revision],
        );
        const filesChanged = await tx.query(
          `UPDATE ${filePlacementTable} SET file_placement_id=$1, file_placement_revision=$2,
              schema_version=$3, status='PROVISIONING'
            WHERE company_id=$4 AND file_placement_revision=$5 AND status='FAILED'`,
          [nextFiles.file_placement_id, fileRevision, nextFiles.schema_version, company_id,
            existingFiles.rows[0].file_placement_revision],
        );
        if (dbChanged.rowCount !== 1 || filesChanged.rowCount !== 1) {
          throw new CompanyStorageResolutionError("placement-stale");
        }
        return Object.freeze({ database: nextDatabase, files: nextFiles });
      });
    },
    async setUnavailable(input: Parameters<CompanyPlacementRegistryWriter["setUnavailable"]>[0]) {
      if (!validId(input.company_id) || !validPlacementId(input.placement_id)
        || !Number.isSafeInteger(input.placement_revision) || input.placement_revision < 1
        || !["PROVISIONING", "MIGRATING", "READY"].includes(input.expected_status)
        || !["FAILED", "DISABLED"].includes(input.status)) {
        throw new CompanyStorageResolutionError("placement-invalid");
      }
      return storage.transaction(async tx => {
        const changed = await tx.query(
          `UPDATE ${placementTable} SET status = $1
            WHERE company_id = $2 AND placement_id = $3 AND placement_revision = $4 AND status = $5`,
          [input.status, input.company_id, input.placement_id, input.placement_revision, input.expected_status],
        );
        if (changed.rowCount !== 1) throw new CompanyStorageResolutionError("placement-stale");
        const currentFiles = await tx.query<FilePlacementRow>(
          `SELECT company_id, file_placement_id, file_placement_revision, provider, schema_version, status
             FROM ${filePlacementTable} WHERE company_id = $1`, [input.company_id],
        );
        if (currentFiles.rows.length > 1 || currentFiles.rows.some(row => row.status !== input.expected_status)) {
          throw new CompanyStorageResolutionError("placement-stale");
        }
        if (currentFiles.rows.length === 1) {
          const fileChanged = await tx.query(
            `UPDATE ${filePlacementTable} SET status = $1
              WHERE company_id = $2 AND file_placement_id = $3
                AND file_placement_revision = $4 AND status = $5`,
            [input.status, input.company_id, currentFiles.rows[0].file_placement_id,
              currentFiles.rows[0].file_placement_revision, input.expected_status],
          );
          if (fileChanged.rowCount !== 1) throw new CompanyStorageResolutionError("placement-stale");
        }
        const database = await tx.query<PlacementRow>(
          `SELECT company_id, placement_id, placement_revision, provider, schema_version, status
             FROM ${placementTable} WHERE company_id = $1`, [input.company_id],
        );
        const file = await tx.query<FilePlacementRow>(
          `SELECT company_id, file_placement_id, file_placement_revision, provider, schema_version, status
             FROM ${filePlacementTable} WHERE company_id = $1`, [input.company_id],
        );
        if (database.rows.length !== 1) throw new CompanyStorageResolutionError("placement-missing");
        return Object.freeze({
          database: placementFromRow(database.rows[0]),
          files: file.rows.length === 1 ? filePlacementFromRow(file.rows[0]) : null,
        });
      });
    },
  });
}
