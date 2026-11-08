import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { openExistingSqliteStorage } from "./sqlite-client.js";
import type { StorageClient, StorageTransactionOptions } from "./index.js";
import { createCompanyPlacementOperationGate } from "./company-placement-operation-gate.js";
import {
  CompanyStorageResolutionError,
  type CompanyDatabasePlacementDescriptor,
  type CompanyStoreOpenResult,
  type CompanyStoreOpener,
  type CompanyStorageResolverOptions,
} from "./company-storage-resolver.js";

export interface SqliteCompanyStoreOpenerOptions {
  /** Absolute, operator-owned root. It must already exist and cannot be a symlink. */
  readonly companyStoreRoot: string;
}

type FileIdentity = Readonly<{ path: string; device: number; inode: number }>;

function invalidStore(): CompanyStorageResolutionError {
  return new CompanyStorageResolutionError("company-store-invalid");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validPlacementId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== "" && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

function trustedRoot(configuredRoot: string): string {
  try {
    if (typeof configuredRoot !== "string" || !isAbsolute(configuredRoot)) throw invalidStore();
    const normalized = resolve(configuredRoot);
    const stat = lstatSync(normalized);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o022) !== 0) throw invalidStore();
    const canonical = realpathSync.native(normalized);
    if (canonical !== normalized) throw invalidStore();
    return canonical;
  } catch (error) {
    if (error instanceof CompanyStorageResolutionError) throw error;
    throw invalidStore();
  }
}

function inspectPlacementFile(root: string, placementId: string): FileIdentity {
  try {
    if (!validPlacementId(placementId)) throw invalidStore();
    const expectedPath = join(root, `${placementId}.sqlite`);
    if (dirname(expectedPath) !== root) throw invalidStore();
    const stat = lstatSync(expectedPath);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o022) !== 0) throw invalidStore();
    const canonical = realpathSync.native(expectedPath);
    if (canonical !== expectedPath || !isWithinRoot(root, canonical)) throw invalidStore();
    return Object.freeze({ path: canonical, device: stat.dev, inode: stat.ino });
  } catch (error) {
    if (error instanceof CompanyStorageResolutionError) throw error;
    throw invalidStore();
  }
}

function assertDescriptor(placement: CompanyDatabasePlacementDescriptor): void {
  if (!placement || typeof placement !== "object" || placement.provider !== "sqlite"
    || !validId(placement.company_id) || !validPlacementId(placement.placement_id)
    || !Number.isSafeInteger(placement.placement_revision) || placement.placement_revision < 1
    || !validId(placement.schema_version)) {
    throw invalidStore();
  }
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.path === b.path && a.device === b.device && a.inode === b.inode;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CompanyStorageResolutionError("resolution-aborted");
}

async function mainDatabasePath(client: StorageClient): Promise<string> {
  const rows = (await client.query<{ name: string; file: string }>("PRAGMA database_list")).rows;
  const main = rows.filter(row => row.name === "main");
  if (main.length !== 1 || typeof main[0].file !== "string" || !isAbsolute(main[0].file)) throw invalidStore();
  let canonical: string;
  try { canonical = realpathSync.native(main[0].file); }
  catch { throw invalidStore(); }
  return canonical;
}

/**
 * SQLite v1 opener for registry-selected opaque placement IDs. It opens only an
 * existing regular file under a trusted root; it never creates directories or
 * databases and does not accept caller paths, URLs, or credentials.
 */
export function createSqliteCompanyStoreOpener(
  options: SqliteCompanyStoreOpenerOptions,
): CompanyStoreOpener<StorageClient> {
  const root = trustedRoot(options?.companyStoreRoot);
  return Object.freeze({
    async open(
      placement: CompanyDatabasePlacementDescriptor,
      openOptions?: CompanyStorageResolverOptions,
    ): Promise<CompanyStoreOpenResult<StorageClient>> {
      throwIfAborted(openOptions?.signal);
      assertDescriptor(placement);
      const operationGate = createCompanyPlacementOperationGate(root, placement.placement_id);
      const releaseOperation = await operationGate.acquire({ signal: openOptions?.signal });
      let client: StorageClient | undefined;
      try {
        const beforeOpen = inspectPlacementFile(root, placement.placement_id);
        client = openExistingSqliteStorage(beforeOpen.path);
        throwIfAborted(openOptions?.signal);

        const connectedPath = await mainDatabasePath(client);
        throwIfAborted(openOptions?.signal);
        const afterOpen = inspectPlacementFile(root, placement.placement_id);
        if (!sameFile(beforeOpen, afterOpen) || connectedPath !== beforeOpen.path) throw invalidStore();

        const assertPlacementBound = async (): Promise<void> => {
          try {
            const current = inspectPlacementFile(root, placement.placement_id);
            const mountedPath = await mainDatabasePath(client!);
            const afterCheck = inspectPlacementFile(root, placement.placement_id);
            if (!sameFile(beforeOpen, current) || !sameFile(beforeOpen, afterCheck)
              || mountedPath !== beforeOpen.path) {
              throw new CompanyStorageResolutionError("company-store-binding-mismatch");
            }
          } catch (error) {
            if (error instanceof CompanyStorageResolutionError
              && error.code === "company-store-binding-mismatch") throw error;
            throw new CompanyStorageResolutionError("company-store-binding-mismatch");
          }
        };

        const guardedClient: StorageClient = Object.freeze({
          dialect: client.dialect,
          query: <T>(sql: string, params: readonly unknown[] = []) => operationGate.run(async () => {
            await openOptions?.assertCurrent?.();
            await assertPlacementBound();
            return client!.query<T>(sql, params);
          }, { signal: openOptions?.signal }),
          transaction: <T>(fn: (tx: StorageClient) => Promise<T>, transactionOptions?: StorageTransactionOptions): Promise<T> =>
            operationGate.run(async () => {
              await openOptions?.assertCurrent?.();
              await assertPlacementBound();
              return client!.transaction(fn, transactionOptions);
            }, { signal: openOptions?.signal }),
          close: () => operationGate.run(() => client!.close()),
        });

        return Object.freeze({
          company_id: placement.company_id,
          placement_id: placement.placement_id,
          placement_revision: placement.placement_revision,
          provider: "sqlite",
          schema_version: placement.schema_version,
          client: guardedClient,
          assertPlacementBound,
        });
      } catch (error) {
        if (client) await client.close().catch(() => undefined);
        if (error instanceof CompanyStorageResolutionError) throw error;
        throw invalidStore();
      } finally { await releaseOperation(); }
    },
  });
}
