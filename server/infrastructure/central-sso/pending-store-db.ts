/** Database-backed Central SSO pending-login store. Shared by every app process.
 * Rows are keyed by SHA-256 of the state, so the state value itself is not stored.
 * take() is one DELETE ... RETURNING, so a pending login is consumed exactly once
 * across all processes, and an expired row is never returned.
 * The table is created by migrations/0019_central_sso_pending_logins.sql.
 */
import {createHash} from 'node:crypto';
import type {PendingLogin, PendingStore} from './oidc-flow.ts';

/** Minimal pg-compatible query surface (a pg Pool or Client satisfies it). */
export interface PendingQueryable {
 query(text: string, values?: unknown[]): Promise<{rows: any[]; rowCount?: number | null}>;
}

export const PENDING_TABLE = 'central_sso_pending_logins';
export const PENDING_MAX_ENTRIES = 1000;
const MAX_TTL_MS = 10 * 60 * 1000;

export function pendingStateHash(state: string): string {
 return createHash('sha256').update(state).digest('hex');
}

export function createDatabasePendingStore({db, maxEntries = PENDING_MAX_ENTRIES}: {db: PendingQueryable; maxEntries?: number}): PendingStore {
 return {
  async put(state: string, record: PendingLogin, ttlMs: number): Promise<boolean> {
   const ttl = Math.min(Math.max(1, Math.trunc(ttlMs)), MAX_TTL_MS);
   // Expiry uses the database clock, so every process agrees on when a row is dead.
   await db.query(`DELETE FROM ${PENDING_TABLE} WHERE expires_at <= now()`);
   // Cap the table size. The count and insert are not one lock, so the cap is approximate under heavy concurrency.
   const inserted = await db.query(
    `INSERT INTO ${PENDING_TABLE} (state_hash, code_verifier, nonce, expires_at)
     SELECT $1, $2, $3, now() + ($4::int * interval '1 millisecond')
     WHERE (SELECT count(*) FROM ${PENDING_TABLE}) < $5
     ON CONFLICT (state_hash) DO NOTHING
     RETURNING state_hash`,
    [pendingStateHash(state), record.codeVerifier, record.nonce, ttl, maxEntries],
   );
   return inserted.rows.length === 1;
  },
  async take(state: string): Promise<PendingLogin | null> {
   const res = await db.query(
    `DELETE FROM ${PENDING_TABLE} WHERE state_hash = $1
     RETURNING code_verifier, nonce, (expires_at > now()) AS live`,
    [pendingStateHash(state)],
   );
   const row = res.rows[0];
   if (!row || row.live !== true) return null;
   return {codeVerifier: row.code_verifier, nonce: row.nonce};
  },
 };
}
