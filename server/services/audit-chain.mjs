/**
 * Pure, database-free helpers for the optional audit hash chain.
 *
 * Kept as a plain .mjs module (no db or config imports) so it can be unit-tested
 * with `node --test` without connecting to anything. audit-log.ts re-exports
 * computeAuditHash from here.
 *
 * Chain definition:
 *   entry_hash = sha256( canonicalJson({ prevHash, entry: <hashed fields> }) )
 * The first entry in a chain uses prevHash = null (genesis).
 *
 * Callers must hash the values that are actually persisted (for example the
 * userAgent after truncation, and the createdAt that is written to the row),
 * otherwise verification will fail for legitimate rows.
 */

import { createHash } from "node:crypto";

export const AUDIT_HASH_FIELDS = Object.freeze([
  "action",
  "userId",
  "targetUserId",
  "resourceType",
  "resourceId",
  "ipAddress",
  "userAgent",
  "metadata",
  "severity",
  "timestamp",
]);

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Deterministic JSON: object keys sorted recursively, undefined dropped, Dates
 * converted via toJSON (same as JSON.stringify), so equal data always yields
 * an identical string.
 */
export function canonicalJson(value) {
  return JSON.stringify(sortKeysDeep(JSON.parse(JSON.stringify(value ?? null))));
}

/**
 * Computes the sha256 hex digest for one audit entry chained to prevHash.
 * Pure: no I/O, no clock reads. Missing optional fields hash as null.
 */
export function computeAuditHash(entry, prevHash = null) {
  if (prevHash !== null && typeof prevHash !== "string") {
    throw new TypeError("computeAuditHash: prevHash must be a string or null");
  }
  const record = {};
  for (const field of AUDIT_HASH_FIELDS) {
    record[field] = entry?.[field] ?? null;
  }
  return createHash("sha256")
    .update(canonicalJson({ prevHash, entry: record }))
    .digest("hex");
}

/**
 * Verifies an ordered list of rows, each shaped as the entry plus
 * `prevHash` and `entryHash`. Returns { valid: true } or
 * { valid: false, index } pointing at the first row that does not verify.
 */
export function verifyAuditChain(rows) {
  let expectedPrev = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if ((row.prevHash ?? null) !== expectedPrev) {
      return { valid: false, index };
    }
    if (computeAuditHash(row, expectedPrev) !== row.entryHash) {
      return { valid: false, index };
    }
    expectedPrev = row.entryHash;
  }
  return { valid: true };
}
