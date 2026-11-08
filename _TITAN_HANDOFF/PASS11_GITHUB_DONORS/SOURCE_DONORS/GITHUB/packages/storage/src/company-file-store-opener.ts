import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  isRegisteredCompanyFilePlacement,
  type CompanyFilePlacementRegistry,
  type RegisteredCompanyFilePlacement,
} from "./company-placement-registry.js";
import { CompanyStorageResolutionError } from "./company-storage-resolver.js";
import { createCompanyPlacementOperationGate } from "./company-placement-operation-gate.js";

export interface LocalCompanyFileStoreOpenerOptions {
  /** Absolute, operator-owned root. It must already exist and cannot be a symlink. */
  readonly companyFileStoreRoot: string;
  /** Fresh GLOBAL_REGISTRY reader used to revalidate status before every operation. */
  readonly registry: CompanyFilePlacementRegistry;
}

export interface CompanyFileStore {
  readonly company_id: string;
  readonly file_placement_id: string;
  readonly file_placement_revision: number;
  /** Create a new immutable object at a single opaque key. Existing keys fail. */
  putObject(objectKey: string, contents: Uint8Array): Promise<void>;
  /** Read one immutable object by its opaque, single-segment key. */
  readObject(objectKey: string): Promise<Uint8Array>;
}

export interface CompanyFileStoreOpener {
  open(placement: RegisteredCompanyFilePlacement): Promise<CompanyFileStore>;
}

type DirectoryIdentity = Readonly<{ path: string; device: number; inode: number }>;

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

function validObjectKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== "" && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

async function inspectDirectory(path: string): Promise<DirectoryIdentity> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o022) !== 0) throw invalidStore();
    const canonical = await realpath(path);
    if (canonical !== path) throw invalidStore();
    return Object.freeze({ path: canonical, device: stat.dev, inode: stat.ino });
  } catch (error) {
    if (error instanceof CompanyStorageResolutionError) throw error;
    throw invalidStore();
  }
}

function sameDirectory(a: DirectoryIdentity, b: DirectoryIdentity): boolean {
  return a.path === b.path && a.device === b.device && a.inode === b.inode;
}

function assertPlacement(placement: RegisteredCompanyFilePlacement): void {
  if (!isRegisteredCompanyFilePlacement(placement) || !validId(placement.company_id)
    || !validPlacementId(placement.file_placement_id)
    || !Number.isSafeInteger(placement.file_placement_revision) || placement.file_placement_revision < 1
    || placement.provider !== "localfs" || !validId(placement.schema_version)
    || placement.status !== "READY") {
    throw invalidStore();
  }
}

function assertObjectKey(objectKey: string): void {
  if (!validObjectKey(objectKey)) throw invalidStore();
}

/**
 * Opens only an existing, registry-selected READY file namespace. Object keys
 * are flat opaque identifiers: callers cannot supply paths or create nested
 * directories. Objects are immutable and never followed through symlinks.
 */
export function createLocalCompanyFileStoreOpener(
  options: LocalCompanyFileStoreOpenerOptions,
): CompanyFileStoreOpener {
  try {
    if (typeof options?.companyFileStoreRoot !== "string" || !isAbsolute(options.companyFileStoreRoot)) {
      throw invalidStore();
    }
  } catch (error) {
    if (error instanceof CompanyStorageResolutionError) throw error;
    throw invalidStore();
  }
  const rootPath = resolve(options.companyFileStoreRoot);
  if (!options.registry || typeof options.registry.findFileByCompanyId !== "function") throw invalidStore();
  let rootIdentityPromise: Promise<DirectoryIdentity>;
  const rootIdentity = (): Promise<DirectoryIdentity> => {
    rootIdentityPromise ??= inspectDirectory(rootPath);
    return rootIdentityPromise;
  };

  return Object.freeze({
    async open(placement: RegisteredCompanyFilePlacement): Promise<CompanyFileStore> {
      assertPlacement(placement);
      const assertCurrentPlacement = async (): Promise<void> => {
        const current = await options.registry.findFileByCompanyId(placement.company_id);
        if (!current || current.company_id !== placement.company_id
          || current.file_placement_id !== placement.file_placement_id
          || current.file_placement_revision !== placement.file_placement_revision
          || current.provider !== placement.provider || current.schema_version !== placement.schema_version
          || current.status !== "READY") {
          throw new CompanyStorageResolutionError("placement-stale");
        }
      };
      await assertCurrentPlacement();
      const root = await rootIdentity();
      const namespacePath = join(root.path, placement.file_placement_id);
      if (!isWithinRoot(root.path, namespacePath)) throw invalidStore();
      const namespace = await inspectDirectory(namespacePath);
      if (!isWithinRoot(root.path, namespace.path)) throw invalidStore();
      const operationGate = createCompanyPlacementOperationGate(root.path, placement.file_placement_id);

      const assertCurrentNamespace = async (): Promise<DirectoryIdentity> => {
        const currentRoot = await inspectDirectory(rootPath);
        if (!sameDirectory(root, currentRoot)) throw invalidStore();
        const current = await inspectDirectory(namespacePath);
        if (!sameDirectory(namespace, current) || !isWithinRoot(root.path, current.path)) throw invalidStore();
        return current;
      };

      return Object.freeze({
        company_id: placement.company_id,
        file_placement_id: placement.file_placement_id,
        file_placement_revision: placement.file_placement_revision,
        async putObject(objectKey: string, contents: Uint8Array): Promise<void> {
          assertObjectKey(objectKey);
          if (!(contents instanceof Uint8Array)) throw invalidStore();
          await operationGate.run(async () => {
            await assertCurrentPlacement();
            const directory = await assertCurrentNamespace();
            const path = join(directory.path, objectKey);
            if (!isWithinRoot(directory.path, path) || relative(directory.path, path).includes(sep)) throw invalidStore();
            let handle;
            try {
              handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              const opened = await handle.stat();
              if (!opened.isFile() || opened.nlink !== 1) throw invalidStore();
              await handle.writeFile(contents);
              await handle.sync();
              const current = await lstat(path);
              if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw invalidStore();
              await assertCurrentNamespace();
            } catch (error) {
              if (error instanceof CompanyStorageResolutionError) throw error;
              throw invalidStore();
            } finally {
              await handle?.close().catch(() => undefined);
            }
          });
        },
        async readObject(objectKey: string): Promise<Uint8Array> {
          assertObjectKey(objectKey);
          return operationGate.run(async () => {
            await assertCurrentPlacement();
            const directory = await assertCurrentNamespace();
            const path = join(directory.path, objectKey);
            if (!isWithinRoot(directory.path, path) || relative(directory.path, path).includes(sep)) throw invalidStore();
            let handle;
            try {
              handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
              const opened = await handle.stat();
              if (!opened.isFile() || opened.nlink !== 1) throw invalidStore();
              const contents = await handle.readFile();
              const current = await lstat(path);
              if (current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw invalidStore();
              await assertCurrentNamespace();
              return contents;
            } catch (error) {
              if (error instanceof CompanyStorageResolutionError) throw error;
              throw invalidStore();
            } finally {
              await handle?.close().catch(() => undefined);
            }
          });
        },
      });
    },
  });
}
