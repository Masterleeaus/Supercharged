import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, lstat } from "node:fs/promises";
import { join } from "node:path";

export interface CompanyPlacementOperationGate {
  run<T>(operation: () => Promise<T>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
  acquire(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<() => Promise<void>>;
  acquireMaintenance(options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<() => Promise<void>>;
}

interface OperationGateOptions { signal?: AbortSignal; timeoutMs?: number; }

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("company-placement-operation-aborted"));
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); cleanup(); reject(new Error("company-placement-operation-aborted")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Cross-process exclusive gate for one physical company placement. All native
 * DB operations and file object operations use the same gate as maintenance
 * swaps, so an already-admitted effect drains before restore replaces inodes.
 * A crashed holder leaves the gate closed (fail-closed) for operator recovery.
 */
export function createCompanyPlacementOperationGate(lockDirectory: string, placementId: string): CompanyPlacementOperationGate {
  if (!placementId || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(placementId)) {
    throw new Error("company-placement-operation-id-invalid");
  }
  if (!lockDirectory || !lockDirectory.startsWith("/")) throw new Error("company-placement-operation-root-invalid");
  const lockPath = join(lockDirectory, `.titan-placement-${placementId}.operation-lock`);
  const maintenancePath = `${lockPath}.maintenance`;
  const deadlineOf = (options: OperationGateOptions) => Date.now() + (options.timeoutMs ?? 30_000);
  const acquireMutex = async (options: OperationGateOptions, deadline: number, honorMaintenance: boolean) => {
    const token = randomUUID();
    while (true) {
      if (options.signal?.aborted) throw new Error("company-placement-operation-aborted");
      if (honorMaintenance && await lstat(maintenancePath).then(() => true, () => false)) {
        if (Date.now() >= deadline) throw new Error("company-placement-operation-lock-timeout");
        await wait(10, options.signal);
        continue;
      }
      try {
        await mkdir(lockPath, { mode: 0o700 });
        try {
          const owner = await open(join(lockPath, "owner"), "wx", 0o600);
          try { await owner.writeFile(`${process.pid}:${token}`); await owner.sync(); }
          finally { await owner.close(); }
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        const release = async () => {
          const owner = await readFile(join(lockPath, "owner"), "utf8").catch(() => "");
          if (owner === `${process.pid}:${token}`) await rm(lockPath, { recursive: true, force: true });
        };
        // Close the check/create race: once maintenance intent is visible, a
        // normal operation that just acquired the mutex must yield it.
        if (honorMaintenance && await lstat(maintenancePath).then(() => true, () => false)) {
          await release();
          if (Date.now() >= deadline) throw new Error("company-placement-operation-lock-timeout");
          await wait(10, options.signal);
          continue;
        }
        return release;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const lock = await lstat(lockPath).catch(() => null);
        if (!lock || lock.isSymbolicLink() || !lock.isDirectory()) {
          throw new Error("company-placement-operation-lock-invalid");
        }
        if (Date.now() >= deadline) throw new Error("company-placement-operation-lock-timeout");
        await wait(10, options.signal);
      }
    }
  };
  return Object.freeze({
    async acquire(options: OperationGateOptions = {}) {
      return acquireMutex(options, deadlineOf(options), true);
    },
    async acquireMaintenance(options: OperationGateOptions = {}) {
      const deadline = deadlineOf(options);
      const token = randomUUID();
      while (true) {
        if (options.signal?.aborted) throw new Error("company-placement-operation-aborted");
        try {
          const intent = await open(maintenancePath, "wx", 0o600);
          try { await intent.writeFile(`${process.pid}:${token}`); await intent.sync(); }
          finally { await intent.close(); }
          try {
            const releaseMutex = await acquireMutex(options, deadline, false);
            return async () => {
              await releaseMutex();
              const owner = await readFile(maintenancePath, "utf8").catch(() => "");
              if (owner === `${process.pid}:${token}`) await rm(maintenancePath, { force: true });
            };
          } catch (error) {
            const owner = await readFile(maintenancePath, "utf8").catch(() => "");
            if (owner === `${process.pid}:${token}`) await rm(maintenancePath, { force: true }).catch(() => undefined);
            throw error;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (Date.now() >= deadline) throw new Error("company-placement-maintenance-lock-timeout");
          await wait(10, options.signal);
        }
      }
    },
    async run<T>(operation: () => Promise<T>, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T> {
      const release = await this.acquire(options);
      try { return await operation(); }
      finally { await release(); }
    },
  });
}
