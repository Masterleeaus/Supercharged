import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, rename, rm, lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createSqliteCompanyFilePlacementRegistry, createSqliteCompanyPlacementRegistry, createSqliteCompanyPlacementRegistryWriter, type GlobalRegistryStorageInput } from "./company-placement-registry.js";
import { createSqliteCompanyStoreOpener } from "./company-store-opener.js";
import { verifyCompanyNativeSchemaAttestation } from "./company-native-schema-attestation.js";
import { getCompanyNativeSchemaManifest } from "./company-native-schema-manifest.js";
import { CompanyStorageResolutionError, type CompanyDatabasePlacementDescriptor } from "./company-storage-resolver.js";
import { openExistingSqliteStorage } from "./sqlite-client.js";
import { createCompanyPlacementOperationGate } from "./company-placement-operation-gate.js";

const backupFormat = "titan-company-placement-backup/v1" as const;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const digestPattern = /^[a-f0-9]{64}$/;

export interface CompanyPlacementBackupManifest {
  readonly format: typeof backupFormat;
  readonly company_id: string;
  readonly placement_id: string;
  readonly placement_revision: number;
  readonly schema_version: string;
  readonly file_placement_id: string;
  readonly file_placement_revision: number;
  readonly created_at: string;
  readonly database_sha256: string;
  readonly files: Readonly<Record<string, string>>;
  readonly manifest_sha256: string;
}

export interface CompanyPlacementBackupOptions extends GlobalRegistryStorageInput {
  readonly companyStoreRoot: string;
  readonly companyFileStoreRoot: string;
  readonly backupRoot: string;
}

function fail(code: string): never {
  throw new Error(`company-placement-backup-${code}`);
}

function nativeManifest(schemaVersion: string) {
  const manifest = getCompanyNativeSchemaManifest(schemaVersion);
  if (!manifest) fail("schema-version-unsupported");
  return manifest;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalManifest(manifest: Omit<CompanyPlacementBackupManifest, "manifest_sha256">): string {
  return JSON.stringify({
    format: manifest.format,
    company_id: manifest.company_id,
    placement_id: manifest.placement_id,
    placement_revision: manifest.placement_revision,
    schema_version: manifest.schema_version,
    file_placement_id: manifest.file_placement_id,
    file_placement_revision: manifest.file_placement_revision,
    created_at: manifest.created_at,
    database_sha256: manifest.database_sha256,
    files: Object.fromEntries(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b))),
  });
}

async function trustedDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) fail("root-invalid");
  const normalized = resolve(path);
  const stat = await lstat(normalized).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o022) !== 0
    || await realpath(normalized) !== normalized) fail("root-invalid");
  return normalized;
}

function validManifest(raw: unknown): raw is CompanyPlacementBackupManifest {
  if (!raw || typeof raw !== "object") return false;
  const value = raw as Partial<CompanyPlacementBackupManifest>;
  if (value.format !== backupFormat || !idPattern.test(value.company_id ?? "")
    || !idPattern.test(value.placement_id ?? "") || !idPattern.test(value.schema_version ?? "")
    || !idPattern.test(value.file_placement_id ?? "")
    || !Number.isSafeInteger(value.placement_revision) || (value.placement_revision ?? 0) < 1
    || !Number.isSafeInteger(value.file_placement_revision) || (value.file_placement_revision ?? 0) < 1
    || typeof value.created_at !== "string" || !Number.isFinite(Date.parse(value.created_at))
    || !digestPattern.test(value.database_sha256 ?? "") || !digestPattern.test(value.manifest_sha256 ?? "")
    || !value.files || typeof value.files !== "object" || Array.isArray(value.files)) return false;
  return Object.entries(value.files).every(([key, digest]) => idPattern.test(key) && typeof digest === "string" && digestPattern.test(digest));
}

async function readRegularFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) fail("artifact-invalid");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || (opened.mode & 0o022) !== 0) fail("artifact-invalid");
    const bytes = await handle.readFile();
    const afterRead = await handle.stat();
    const current = await lstat(path);
    if (bytes.byteLength !== opened.size || afterRead.size !== opened.size
      || afterRead.mtimeMs !== opened.mtimeMs || afterRead.ctimeMs !== opened.ctimeMs
      || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino
      || current.size !== opened.size || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs) fail("artifact-changed");
    return bytes;
  } finally { await handle.close(); }
}

async function writeExclusive(path: string, contents: Uint8Array): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(contents); await handle.sync(); }
  finally { await handle.close(); }
}

async function currentPlacement(options: CompanyPlacementBackupOptions, companyId: string) {
  const registryInput = { storage: options.storage, storage_role: "GLOBAL_REGISTRY" as const };
  const [dbRegistry, fileRegistry] = await Promise.all([
    createSqliteCompanyPlacementRegistry(registryInput),
    createSqliteCompanyFilePlacementRegistry(registryInput),
  ]);
  const [database, files] = await Promise.all([
    dbRegistry.findByCompanyId(companyId), fileRegistry.findFileByCompanyId(companyId),
  ]);
  if (!database || !files || database.company_id !== companyId || files.company_id !== companyId
    || database.status !== "READY" || files.status !== "READY"
    || database.provider !== "sqlite" || files.provider !== "localfs") fail("placement-not-ready");
  return { database, files };
}

async function readBundle(options: Pick<CompanyPlacementBackupOptions, "backupRoot">, bundleId: string) {
  if (!idPattern.test(bundleId)) fail("bundle-invalid");
  const root = await trustedDirectory(options.backupRoot);
  const directory = join(root, bundleId);
  const directoryStat = await lstat(directory).catch(() => null);
  if (!directoryStat || directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
    || await realpath(directory) !== directory) fail("bundle-invalid");
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(["database.sqlite", "files", "manifest.json"])) fail("bundle-invalid");
  const manifestBytes = await readRegularFile(join(directory, "manifest.json"));
  if (manifestBytes.byteLength > 1_000_000) fail("manifest-invalid");
  let raw: unknown;
  try { raw = JSON.parse(manifestBytes.toString("utf8")); } catch { return fail("manifest-invalid"); }
  if (!validManifest(raw)) fail("manifest-invalid");
  const manifest = raw;
  const { manifest_sha256: recordedDigest, ...payload } = manifest;
  if (sha256(Buffer.from(canonicalManifest(payload), "utf8")) !== recordedDigest) fail("manifest-checksum-mismatch");
  const database = await readRegularFile(join(directory, "database.sqlite"));
  if (sha256(database) !== manifest.database_sha256) fail("database-checksum-mismatch");
  const fileDirectory = join(directory, "files");
  const fileStat = await lstat(fileDirectory).catch(() => null);
  if (!fileStat || fileStat.isSymbolicLink() || !fileStat.isDirectory() || (fileStat.mode & 0o022) !== 0
    || await realpath(fileDirectory) !== fileDirectory) fail("files-invalid");
  const fileNames = (await readdir(fileDirectory)).sort();
  if (JSON.stringify(fileNames) !== JSON.stringify(Object.keys(manifest.files).sort())) fail("files-mismatch");
  const fileBytes = new Map<string, Buffer>();
  for (const key of fileNames) {
    const bytes = await readRegularFile(join(fileDirectory, key));
    if (sha256(bytes) !== manifest.files[key]) fail("file-checksum-mismatch");
    fileBytes.set(key, bytes);
  }
  return { directory, manifest, database, fileBytes };
}

/** Create a checksummed snapshot bound to the current canonical DB and file placement rows. */
export async function createCompanyPlacementBackup(input: CompanyPlacementBackupOptions & {
  readonly company_id: string;
  readonly now?: () => Date;
}): Promise<{ bundle_id: string; manifest: CompanyPlacementBackupManifest }> {
  const dbRoot = await trustedDirectory(input.companyStoreRoot);
  const fileRoot = await trustedDirectory(input.companyFileStoreRoot);
  const backupRoot = await trustedDirectory(input.backupRoot);
  const { database, files } = await currentPlacement(input, input.company_id);
  const placement: CompanyDatabasePlacementDescriptor = Object.freeze({
    company_id: database.company_id, placement_id: database.placement_id,
    placement_revision: database.placement_revision, provider: "sqlite", schema_version: database.schema_version,
  });
  const schemaManifest = nativeManifest(placement.schema_version);
  const companyPath = join(dbRoot, `${placement.placement_id}.sqlite`);
  const filePath = join(fileRoot, files.file_placement_id);
  const id = randomUUID();
  const temporary = await mkdtemp(join(backupRoot, `.partial-${id}-`));
  let releaseDatabaseGate: (() => Promise<void>) | undefined;
  let releaseFileGate: (() => Promise<void>) | undefined;
  let companyStorage: import("./index.js").StorageClient | undefined;
  try {
    const preflight = await createSqliteCompanyStoreOpener({ companyStoreRoot: dbRoot }).open(placement);
    try { await preflight.assertPlacementBound(); }
    finally { await preflight.client.close(); }
    // Hold both physical gates during the database snapshot and file copy so a
    // backup cannot capture a moving DB inode or a partially written object.
    releaseDatabaseGate = await createCompanyPlacementOperationGate(dbRoot, placement.placement_id).acquireMaintenance();
    releaseFileGate = await createCompanyPlacementOperationGate(fileRoot, files.file_placement_id).acquireMaintenance();
    const current = await currentPlacement(input, input.company_id);
    if (current.database.placement_id !== placement.placement_id
      || current.database.placement_revision !== placement.placement_revision
      || current.files.file_placement_id !== files.file_placement_id
      || current.files.file_placement_revision !== files.file_placement_revision) fail("placement-stale");
    const databaseStat = await lstat(companyPath).catch(() => null);
    if (!databaseStat || databaseStat.isSymbolicLink() || !databaseStat.isFile()
      || (databaseStat.mode & 0o022) !== 0 || await realpath(companyPath) !== companyPath) fail("database-placement-invalid");
    const namespaceStat = await lstat(filePath).catch(() => null);
    if (!namespaceStat || namespaceStat.isSymbolicLink() || !namespaceStat.isDirectory()
      || (namespaceStat.mode & 0o022) !== 0 || await realpath(filePath) !== filePath) fail("file-placement-invalid");
    const namespaceIdentity = { dev: namespaceStat.dev, ino: namespaceStat.ino };
    companyStorage = openExistingSqliteStorage(companyPath);
    const main = (await companyStorage.query<{ name: string; file: string }>("PRAGMA database_list")).rows
      .filter(row => row.name === "main");
    if (main.length !== 1 || await realpath(main[0].file) !== companyPath) fail("database-placement-invalid");
    await verifyCompanyNativeSchemaAttestation({ storage: companyStorage, placement, manifest: schemaManifest });
    const integrity = (await companyStorage.query<{ integrity_check: string }>("PRAGMA integrity_check")).rows;
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") fail("database-unhealthy");
    const databaseSnapshotPath = join(temporary, "database.sqlite");
    await companyStorage.query(`VACUUM INTO '${databaseSnapshotPath.replaceAll("'", "''")}'`);
    await companyStorage.close();
    companyStorage = undefined;
    const databaseBytes = await readRegularFile(databaseSnapshotPath);
    await mkdir(join(temporary, "files"), { mode: 0o700 });
    const hashes: Record<string, string> = {};
    const sourceNames = (await readdir(filePath)).sort();
    for (const key of sourceNames) {
      if (!idPattern.test(key)) fail("file-object-invalid");
      const bytes = await readRegularFile(join(filePath, key));
      hashes[key] = sha256(bytes);
      await writeExclusive(join(temporary, "files", key), bytes);
    }
    const afterNames = (await readdir(filePath)).sort();
    const afterNamespace = await lstat(filePath);
    if (JSON.stringify(afterNames) !== JSON.stringify(sourceNames)
      || afterNamespace.isSymbolicLink() || afterNamespace.dev !== namespaceIdentity.dev
      || afterNamespace.ino !== namespaceIdentity.ino || await realpath(filePath) !== filePath) fail("file-placement-changed");
    const afterDatabase = await lstat(companyPath);
    if (afterDatabase.isSymbolicLink() || afterDatabase.dev !== databaseStat.dev || afterDatabase.ino !== databaseStat.ino
      || await realpath(companyPath) !== companyPath) fail("database-placement-changed");
    const latest = await currentPlacement(input, input.company_id);
    if (latest.database.placement_id !== database.placement_id
      || latest.database.placement_revision !== database.placement_revision
      || latest.files.file_placement_id !== files.file_placement_id
      || latest.files.file_placement_revision !== files.file_placement_revision) fail("placement-stale");
    const values: Omit<CompanyPlacementBackupManifest, "manifest_sha256"> = {
      format: backupFormat,
      company_id: placement.company_id,
      placement_id: placement.placement_id,
      placement_revision: placement.placement_revision,
      schema_version: placement.schema_version,
      file_placement_id: files.file_placement_id,
      file_placement_revision: files.file_placement_revision,
      created_at: (input.now?.() ?? new Date()).toISOString(),
      database_sha256: sha256(databaseBytes),
      files: Object.freeze(hashes),
    };
    const manifest = Object.freeze({ ...values, manifest_sha256: sha256(Buffer.from(canonicalManifest(values), "utf8")) });
    await writeExclusive(join(temporary, "manifest.json"), Buffer.from(JSON.stringify(manifest), "utf8"));
    const bundleId = id;
    await rename(temporary, join(backupRoot, bundleId));
    return { bundle_id: bundleId, manifest };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await companyStorage?.close().catch(() => undefined);
    await releaseFileGate?.().catch(() => undefined);
    await releaseDatabaseGate?.().catch(() => undefined);
  }
}

/** Validate all bytes and current registry identity before any restore mutation. */
export async function validateCompanyPlacementBackup(input: CompanyPlacementBackupOptions & {
  readonly company_id: string;
  readonly bundle_id: string;
}): Promise<CompanyPlacementBackupManifest> {
  const bundle = await readBundle(input, input.bundle_id);
  if (bundle.manifest.company_id !== input.company_id) fail("company-mismatch");
  const { database, files } = await currentPlacement(input, input.company_id);
  if (bundle.manifest.placement_id !== database.placement_id
    || bundle.manifest.placement_revision !== database.placement_revision
    || bundle.manifest.schema_version !== database.schema_version
    || bundle.manifest.file_placement_id !== files.file_placement_id
    || bundle.manifest.file_placement_revision !== files.file_placement_revision) fail("placement-stale");
  return bundle.manifest;
}

/**
 * Restore a validated snapshot to its exact current company placement. Registry
 * status gates consumers during the swap; preexisting store handles become
 * physically stale when the DB inode and file directory are replaced.
 */
export async function restoreCompanyPlacementBackup(input: CompanyPlacementBackupOptions & {
  readonly company_id: string;
  readonly bundle_id: string;
}): Promise<void> {
  const dbRoot = await trustedDirectory(input.companyStoreRoot);
  const fileRoot = await trustedDirectory(input.companyFileStoreRoot);
  const bundle = await readBundle(input, input.bundle_id);
  if (bundle.manifest.company_id !== input.company_id) fail("company-mismatch");
  const { database, files } = await currentPlacement(input, input.company_id);
  const placement: CompanyDatabasePlacementDescriptor = Object.freeze({
    company_id: database.company_id, placement_id: database.placement_id,
    placement_revision: database.placement_revision, provider: "sqlite", schema_version: database.schema_version,
  });
  const schemaManifest = nativeManifest(placement.schema_version);
  if (bundle.manifest.placement_id !== placement.placement_id
    || bundle.manifest.placement_revision !== placement.placement_revision
    || bundle.manifest.schema_version !== placement.schema_version
    || bundle.manifest.file_placement_id !== files.file_placement_id
    || bundle.manifest.file_placement_revision !== files.file_placement_revision) fail("placement-stale");

  const databasePath = join(dbRoot, `${placement.placement_id}.sqlite`);
  const filePath = join(fileRoot, files.file_placement_id);
  const restoreId = randomUUID();
  const stagedDatabase = join(dbRoot, `.restore-${restoreId}.sqlite`);
  const stagedFiles = join(fileRoot, `.restore-${restoreId}`);
  const priorDatabase = join(dbRoot, `.prior-${restoreId}.sqlite`);
  const priorFiles = join(fileRoot, `.prior-${restoreId}`);
  let registryMigrating = false;
  let databaseMoved = false;
  let filesMoved = false;
  let releaseDatabaseGate: (() => Promise<void>) | undefined;
  let releaseFileGate: (() => Promise<void>) | undefined;
  const registryInput = { storage: input.storage, storage_role: "GLOBAL_REGISTRY" as const };
  try {
    // Install maintenance intent before draining active operations. Queued
    // pre-admitted operations yield to this intent and recheck inode binding
    // when they resume after the restore.
    releaseDatabaseGate = await createCompanyPlacementOperationGate(dbRoot, placement.placement_id).acquireMaintenance();
    releaseFileGate = await createCompanyPlacementOperationGate(fileRoot, files.file_placement_id).acquireMaintenance();
    const latest = await currentPlacement(input, input.company_id);
    if (latest.database.placement_id !== placement.placement_id
      || latest.database.placement_revision !== placement.placement_revision
      || latest.files.file_placement_id !== files.file_placement_id
      || latest.files.file_placement_revision !== files.file_placement_revision) fail("placement-stale");
    const currentDatabase = await lstat(databasePath).catch(() => null);
    if (!currentDatabase || currentDatabase.isSymbolicLink() || !currentDatabase.isFile()
      || (currentDatabase.mode & 0o022) !== 0 || await realpath(databasePath) !== databasePath) fail("database-placement-invalid");
    const currentFileDirectory = await lstat(filePath).catch(() => null);
    if (!currentFileDirectory || currentFileDirectory.isSymbolicLink() || !currentFileDirectory.isDirectory()
      || (currentFileDirectory.mode & 0o022) !== 0 || await realpath(filePath) !== filePath) fail("file-placement-invalid");
    await writeExclusive(stagedDatabase, bundle.database);
    await mkdir(stagedFiles, { mode: 0o700 });
    for (const [key, contents] of bundle.fileBytes) await writeExclusive(join(stagedFiles, key), contents);
    const stagedClient = openExistingSqliteStorage(stagedDatabase);
    try {
      await verifyCompanyNativeSchemaAttestation({ storage: stagedClient, placement, manifest: schemaManifest });
      const integrity = (await stagedClient.query<{ integrity_check: string }>("PRAGMA integrity_check")).rows;
      const foreignKeys = (await stagedClient.query("PRAGMA foreign_key_check")).rows;
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" || foreignKeys.length !== 0) fail("database-unhealthy");
    } finally { await stagedClient.close(); }

    await input.storage.transaction(async tx => {
      const db = await tx.query(
        `UPDATE titan_company_storage_placements SET status='MIGRATING'
          WHERE company_id=$1 AND placement_id=$2 AND placement_revision=$3 AND status='READY'`,
        [placement.company_id, placement.placement_id, placement.placement_revision],
      );
      const file = await tx.query(
        `UPDATE titan_company_file_placements SET status='MIGRATING'
          WHERE company_id=$1 AND file_placement_id=$2 AND file_placement_revision=$3 AND status='READY'`,
        [files.company_id, files.file_placement_id, files.file_placement_revision],
      );
      if (db.rowCount !== 1 || file.rowCount !== 1) throw new CompanyStorageResolutionError("placement-stale");
    });
    registryMigrating = true;

    // A successful truncate checkpoint is required before replacing a WAL-mode DB.
    const active = openExistingSqliteStorage(databasePath);
    try {
      const checkpoints = (await active.query<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)")).rows;
      if (checkpoints.length !== 1 || checkpoints[0].busy !== 0) fail("database-busy");
    } finally { await active.close(); }
    await rename(databasePath, priorDatabase); databaseMoved = true;
    await rename(stagedDatabase, databasePath);
    await rename(filePath, priorFiles); filesMoved = true;
    await rename(stagedFiles, filePath);

    const restored = openExistingSqliteStorage(databasePath);
    try {
      await verifyCompanyNativeSchemaAttestation({ storage: restored, placement, manifest: schemaManifest });
      const integrity = (await restored.query<{ integrity_check: string }>("PRAGMA integrity_check")).rows;
      if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") fail("database-unhealthy");
    } finally { await restored.close(); }
    const restoredDbStat = await lstat(databasePath);
    const restoredFilesStat = await lstat(filePath);
    if (!restoredDbStat.isFile() || restoredDbStat.isSymbolicLink() || !restoredFilesStat.isDirectory()
      || restoredFilesStat.isSymbolicLink() || await realpath(databasePath) !== databasePath
      || await realpath(filePath) !== filePath) fail("restore-placement-invalid");
    const restoredNames = (await readdir(filePath)).sort();
    if (JSON.stringify(restoredNames) !== JSON.stringify(Object.keys(bundle.manifest.files).sort())) fail("files-mismatch");
    for (const key of restoredNames) {
      if (sha256(await readRegularFile(join(filePath, key))) !== bundle.manifest.files[key]) fail("file-checksum-mismatch");
    }
    await input.storage.transaction(async tx => {
      const db = await tx.query(
        `UPDATE titan_company_storage_placements SET status='READY'
          WHERE company_id=$1 AND placement_id=$2 AND placement_revision=$3 AND status='MIGRATING'`,
        [placement.company_id, placement.placement_id, placement.placement_revision],
      );
      const file = await tx.query(
        `UPDATE titan_company_file_placements SET status='READY'
          WHERE company_id=$1 AND file_placement_id=$2 AND file_placement_revision=$3 AND status='MIGRATING'`,
        [files.company_id, files.file_placement_id, files.file_placement_revision],
      );
      if (db.rowCount !== 1 || file.rowCount !== 1) throw new CompanyStorageResolutionError("placement-stale");
    });
    registryMigrating = false;
    await rm(priorDatabase, { force: true }).catch(() => undefined);
    await rm(priorFiles, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    let rollbackSafe = true;
    if (filesMoved) {
      try {
        await rm(filePath, { recursive: true, force: true });
        await rename(priorFiles, filePath);
      } catch { rollbackSafe = false; }
    }
    if (databaseMoved) {
      try {
        await rm(databasePath, { force: true });
        await rename(priorDatabase, databasePath);
      } catch { rollbackSafe = false; }
    }
    if (registryMigrating) {
      if (rollbackSafe) {
        try {
          const db = await lstat(databasePath);
          const file = await lstat(filePath);
          rollbackSafe = db.isFile() && !db.isSymbolicLink() && file.isDirectory() && !file.isSymbolicLink()
            && await realpath(databasePath) === databasePath && await realpath(filePath) === filePath;
        } catch { rollbackSafe = false; }
      }
      if (rollbackSafe) {
        try {
          await input.storage.transaction(async tx => {
            const db = await tx.query(
              `UPDATE titan_company_storage_placements SET status='READY'
                WHERE company_id=$1 AND placement_id=$2 AND placement_revision=$3 AND status='MIGRATING'`,
              [placement.company_id, placement.placement_id, placement.placement_revision],
            );
            const file = await tx.query(
              `UPDATE titan_company_file_placements SET status='READY'
                WHERE company_id=$1 AND file_placement_id=$2 AND file_placement_revision=$3 AND status='MIGRATING'`,
              [files.company_id, files.file_placement_id, files.file_placement_revision],
            );
            if (db.rowCount !== 1 || file.rowCount !== 1) throw new CompanyStorageResolutionError("placement-stale");
          });
          registryMigrating = false;
        } catch { rollbackSafe = false; }
      }
      if (!rollbackSafe) {
        const writer = await createSqliteCompanyPlacementRegistryWriter(registryInput);
        await writer.setUnavailable({ company_id: placement.company_id, placement_id: placement.placement_id,
          placement_revision: placement.placement_revision, expected_status: "MIGRATING", status: "FAILED" }).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await releaseFileGate?.().catch(() => undefined);
    await releaseDatabaseGate?.().catch(() => undefined);
    await rm(stagedDatabase, { force: true }).catch(() => undefined);
    await rm(stagedFiles, { recursive: true, force: true }).catch(() => undefined);
    // Only remove retained old copies after both placement rows reached READY.
    if (!registryMigrating) {
      await rm(priorDatabase, { force: true }).catch(() => undefined);
      await rm(priorFiles, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
