import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { QueryResult, StorageClient, StorageTransactionOptions } from "./index.js";

function sqliteSql(sql: string, params: readonly unknown[]): { sql: string; params: unknown[] } {
  const expanded: unknown[] = [];
  const text = sql.replace(/\$(\d+)/g, (_match, rawIndex: string) => {
    const index = Number(rawIndex) - 1;
    if (index < 0 || index >= params.length) throw new Error(`sqlite parameter $${rawIndex} is not bound`);
    expanded.push(params[index]);
    return "?";
  });
  return { sql: text, params: expanded };
}

function ensureSqliteParent(filename: string): void {
  if (filename === ":memory:" || filename.startsWith("file:")) return;
  const parent = dirname(filename);
  if (parent && parent !== ".") mkdirSync(parent, { recursive: true });
}

function wrapSqliteDatabase(db: Database.Database): StorageClient {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  // One connection must not enlist another request in an async transaction.
  let pending: Promise<unknown> = Promise.resolve();
  function serialize<T>(operation: () => Promise<T>, acquireDeadlineMs?: number): Promise<T> {
    let admitted = false;
    let cancelledBeforeAdmission = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const result = pending.then(async () => {
      if (cancelledBeforeAdmission || (acquireDeadlineMs !== undefined && performance.now() >= acquireDeadlineMs)) {
        throw new Error("storage-transaction-acquire-timeout");
      }
      admitted = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      return operation();
    });
    pending = result.then(() => undefined, () => undefined);
    if (acquireDeadlineMs === undefined) return result;

    return new Promise<T>((resolve, reject) => {
      const remaining = acquireDeadlineMs - performance.now();
      if (remaining <= 0) {
        cancelledBeforeAdmission = true;
        reject(new Error("storage-transaction-acquire-timeout"));
      }
      else {
        deadlineTimer = setTimeout(() => {
          if (!admitted) {
            cancelledBeforeAdmission = true;
            reject(new Error("storage-transaction-acquire-timeout"));
          }
        }, remaining);
      }
      result.then(
        value => { if (deadlineTimer) clearTimeout(deadlineTimer); resolve(value); },
        error => { if (deadlineTimer) clearTimeout(deadlineTimer); reject(error); },
      );
    });
  }
  const directQuery = async <T>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> => {
    const rewritten = sqliteSql(sql, params);
    const statement = db.prepare(rewritten.sql);
    if (statement.reader) {
      const rows = statement.all(...rewritten.params) as T[];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: statement.run(...rewritten.params).changes };
  };
  const client: StorageClient = {
    dialect: "sqlite",
    query: <T>(sql: string, params: readonly unknown[] = []) => serialize(() => directQuery<T>(sql, params)),
    transaction: <T>(fn: (tx: StorageClient) => Promise<T>, options?: StorageTransactionOptions) => {
      const deadline = options?.acquireDeadlineMs;
      if (deadline !== undefined && (!Number.isFinite(deadline) || deadline < 0)) {
        return Promise.reject(new Error("storage-transaction-acquire-deadline-invalid"));
      }
      return serialize(async () => {
        const previousBusyTimeout = 5000;
        let began = false;
        if (deadline !== undefined) {
          const remaining = Math.floor(deadline - performance.now());
          if (remaining <= 0) throw new Error("storage-transaction-acquire-timeout");
          db.pragma(`busy_timeout = ${Math.max(1, remaining)}`);
        }
        try { db.exec("BEGIN IMMEDIATE"); began = true; }
        catch (error) {
          if (deadline !== undefined && (performance.now() >= deadline || String(error).includes("SQLITE_BUSY") || String(error).includes("database is locked"))) {
            throw new Error("storage-transaction-acquire-timeout", { cause: error });
          }
          throw error;
        } finally {
          if (deadline !== undefined) db.pragma(`busy_timeout = ${previousBusyTimeout}`);
        }
        if (deadline !== undefined && performance.now() >= deadline) {
          db.exec("ROLLBACK");
          began = false;
          throw new Error("storage-transaction-acquire-timeout");
        }
        let active = true;
        const tx: StorageClient = {
          dialect: "sqlite",
          query: <R>(sql: string, params: readonly unknown[] = []) => {
            if (!active) return Promise.reject(new Error("sqlite-transaction-closed"));
            return directQuery<R>(sql, params);
          },
          transaction: async () => { throw new Error("sqlite-nested-transaction-unsupported"); },
          close: async () => { throw new Error("sqlite-transaction-does-not-own-connection"); },
        };
        try { const result = await fn(tx); db.exec("COMMIT"); return result; }
        catch (error) { if (began) db.exec("ROLLBACK"); throw error; }
        finally { active = false; if (deadline !== undefined) db.pragma(`busy_timeout = ${previousBusyTimeout}`); }
      }, deadline);
    },
    close: () => serialize(async () => { db.close(); }),
  };
  return client;
}

export function createSqliteStorage(filename = process.env.SQLITE_PATH ?? ".titan/data/titan-zero.db"): StorageClient {
  ensureSqliteParent(filename);
  return wrapSqliteDatabase(new Database(filename));
}

/** Open an already provisioned SQLite file without creating its parent or an
 * empty database when the selected placement is missing. Callers that accept a
 * placement ID must resolve and validate its trusted path before calling this. */
export function openExistingSqliteStorage(filename: string): StorageClient {
  return wrapSqliteDatabase(new Database(filename, { fileMustExist: true }));
}
