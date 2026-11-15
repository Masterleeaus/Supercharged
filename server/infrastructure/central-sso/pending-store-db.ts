/** Database-backed Central SSO pending-login store. Shared by every app process.
 * Rows are keyed by SHA-256 of the state, so the state value itself is not stored.
 * The PKCE code_verifier is sealed at rest with AES-256-GCM: a fresh 12-byte IV per row,
 * and the state hash bound as associated data, so a sealed value cannot be moved to another row.
 * take() is one DELETE ... RETURNING, so a pending login is consumed exactly once
 * across all processes, and an expired row is never returned.
 * The table is created by migrations/0019_central_sso_pending_logins.sql, and the
 * sealed-verifier column width is set by migrations/0021_central_sso_pending_seal.sql.
 */
import {createCipheriv, createDecipheriv, createHash, randomBytes} from 'node:crypto';
import type {PendingLogin, PendingStore} from './oidc-flow.ts';

/** Minimal pg-compatible query surface (a pg Pool or Client satisfies it). */
export interface PendingQueryable {
 query(text: string, values?: unknown[]): Promise<{rows: any[]; rowCount?: number | null}>;
}

export const PENDING_TABLE = 'central_sso_pending_logins';
export const PENDING_MAX_ENTRIES = 1000;
const MAX_TTL_MS = 10 * 60 * 1000;
const SEAL_VERSION = 'v1';
const IV_BYTES = 12;
const KEY_BYTES = 32;

export function pendingStateHash(state: string): string {
 return createHash('sha256').update(state).digest('hex');
}

/** Seals the verifier as "v1:<iv>:<tag>:<ciphertext>" (base64 parts). The state hash is the AAD. */
function sealVerifier(key: Buffer, stateHash: string, verifier: string): string {
 const iv = randomBytes(IV_BYTES);
 const cipher = createCipheriv('aes-256-gcm', key, iv);
 cipher.setAAD(Buffer.from(stateHash, 'utf8'));
 const ciphertext = Buffer.concat([cipher.update(verifier, 'utf8'), cipher.final()]);
 const tag = cipher.getAuthTag();
 return [SEAL_VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
}

/** Opens a sealed verifier. Returns null for any malformed or unauthenticated value. Never throws or logs the value. */
function openVerifier(key: Buffer, stateHash: string, sealed: unknown): string | null {
 if (typeof sealed !== 'string') return null;
 const parts = sealed.split(':');
 if (parts.length !== 4 || parts[0] !== SEAL_VERSION) return null;
 try {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'base64'));
  decipher.setAAD(Buffer.from(stateHash, 'utf8'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
 } catch {
  return null;
 }
}

export function createDatabasePendingStore({db, sealKey, maxEntries = PENDING_MAX_ENTRIES}: {db: PendingQueryable; sealKey: Buffer; maxEntries?: number}): PendingStore {
 // No plaintext fallback: a missing or wrong-length key refuses to build the store.
 if (!Buffer.isBuffer(sealKey) || sealKey.length !== KEY_BYTES) throw new TypeError('pending store seal key must be 32 bytes');
 const key = Buffer.from(sealKey);
 return {
  async put(state: string, record: PendingLogin, ttlMs: number): Promise<boolean> {
   const ttl = Math.min(Math.max(1, Math.trunc(ttlMs)), MAX_TTL_MS);
   const stateHash = pendingStateHash(state);
   // Expiry uses the database clock, so every process agrees on when a row is dead.
   await db.query(`DELETE FROM ${PENDING_TABLE} WHERE expires_at <= now()`);
   // Cap the table size. The count and insert are not one lock, so the cap is approximate under heavy concurrency.
   const inserted = await db.query(
    `INSERT INTO ${PENDING_TABLE} (state_hash, code_verifier, nonce, expires_at)
     SELECT $1, $2, $3, now() + ($4::int * interval '1 millisecond')
     WHERE (SELECT count(*) FROM ${PENDING_TABLE}) < $5
     ON CONFLICT (state_hash) DO NOTHING
     RETURNING state_hash`,
    [stateHash, sealVerifier(key, stateHash, record.codeVerifier), record.nonce, ttl, maxEntries],
   );
   return inserted.rows.length === 1;
  },
  async take(state: string): Promise<PendingLogin | null> {
   const stateHash = pendingStateHash(state);
   const res = await db.query(
    `DELETE FROM ${PENDING_TABLE} WHERE state_hash = $1
     RETURNING code_verifier, nonce, (expires_at > now()) AS live`,
    [stateHash],
   );
   const row = res.rows[0];
   if (!row || row.live !== true) return null;
   const codeVerifier = openVerifier(key, stateHash, row.code_verifier);
   if (codeVerifier === null) return null;
   return {codeVerifier, nonce: row.nonce};
  },
 };
}
