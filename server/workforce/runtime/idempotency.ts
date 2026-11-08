/**
 * Idempotency for workforce tool calls. A retried or timed-out call must not send a second message, create a
 * second booking, take a second charge or apply a second update.
 *
 * - idempotencyKey(): a stable sha256 over the canonical JSON (sorted keys) of companyId, runId, callIndex, tool
 *   and params. Same inputs give the same key; changing any field changes it.
 * - createIdempotencyStore(): an in-memory claim/complete store. claim() grants the first caller the key and
 *   refuses repeats until the ttl passes. complete() records the outcome, and only the company that claimed the
 *   key may complete it.
 * - idempotencyInsertSql(): parameterised INSERT ... ON CONFLICT DO NOTHING text for a database store. It is
 *   returned as text only and never executed here.
 *
 * Pure: no timers, no database, no network. Time is always passed in as `now` (epoch milliseconds).
 */

import { createHash } from 'node:crypto';

export interface IdempotencyKeyInput {
  companyId: string;
  runId: string;
  callIndex: number;
  tool: string;
  params: unknown;
}

export type IdempotencyOutcome = unknown;

export interface IdempotencyEntry {
  companyId: string;
  claimedAt: number;
  expiresAt: number;
  completed: boolean;
  outcome?: IdempotencyOutcome;
}

export type ClaimResult = { claimed: true } | { claimed: false; previous: IdempotencyEntry };

export type IdempotencyErrorCode = 'not_claimed' | 'company_mismatch' | 'already_completed';

export class IdempotencyError extends Error {
  code: IdempotencyErrorCode;

  constructor(code: IdempotencyErrorCode, message: string) {
    super(message);
    this.name = 'IdempotencyError';
    this.code = code;
  }
}

export interface IdempotencyStore {
  claim(key: string, options: { now: number; ttlMs: number; companyId: string }): ClaimResult;
  complete(key: string, outcome: IdempotencyOutcome, options: { companyId: string }): void;
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function canonicalize(value: unknown, path: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`${path} must be a finite number`);
      return JSON.stringify(value);
    case 'undefined':
      throw new TypeError(`${path} must not be undefined`);
    case 'object': {
      if (Array.isArray(value)) {
        return '[' + value.map((item, i) => canonicalize(item, `${path}[${i}]`)).join(',') + ']';
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`${path} must be a plain object, array or JSON scalar`);
      }
      const record = value as Record<string, unknown>;
      const parts: string[] = [];
      for (const k of Object.keys(record).sort()) {
        // Matches JSON semantics: an undefined property is the same as an absent one.
        if (record[k] === undefined) continue;
        parts.push(JSON.stringify(k) + ':' + canonicalize(record[k], `${path}.${k}`));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new TypeError(`${path} has an unsupported type: ${typeof value}`);
  }
}

/** Canonical JSON with sorted object keys. Exported for callers that need the same normal form. */
export function canonicalJson(value: unknown): string {
  return canonicalize(value, '$');
}

export function idempotencyKey(input: IdempotencyKeyInput): string {
  const companyId = requireNonEmptyString(input.companyId, 'companyId');
  const runId = requireNonEmptyString(input.runId, 'runId');
  const tool = requireNonEmptyString(input.tool, 'tool');
  if (!Number.isSafeInteger(input.callIndex) || input.callIndex < 0) {
    throw new TypeError('callIndex must be a non-negative safe integer');
  }
  if (input.params === undefined) throw new TypeError('params must be provided');

  const canonical = canonicalJson({ companyId, runId, callIndex: input.callIndex, tool, params: input.params });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function createIdempotencyStore(): IdempotencyStore {
  const entries = new Map<string, IdempotencyEntry>();

  return {
    claim(key, options) {
      requireNonEmptyString(key, 'key');
      const companyId = requireNonEmptyString(options.companyId, 'companyId');
      if (!Number.isFinite(options.now)) throw new TypeError('now must be a finite number');
      if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) throw new TypeError('ttlMs must be a positive number');

      const existing = entries.get(key);
      if (existing && options.now < existing.expiresAt) {
        return { claimed: false, previous: { ...existing } };
      }

      entries.set(key, {
        companyId,
        claimedAt: options.now,
        expiresAt: options.now + options.ttlMs,
        completed: false,
      });
      return { claimed: true };
    },

    complete(key, outcome, options) {
      requireNonEmptyString(key, 'key');
      const companyId = requireNonEmptyString(options.companyId, 'companyId');
      const entry = entries.get(key);
      if (!entry) {
        throw new IdempotencyError('not_claimed', 'key has not been claimed');
      }
      if (entry.companyId !== companyId) {
        throw new IdempotencyError('company_mismatch', 'key was claimed by a different company');
      }
      if (entry.completed) {
        throw new IdempotencyError('already_completed', 'key already has a recorded outcome');
      }
      entry.completed = true;
      entry.outcome = outcome;
    },
  };
}

export const IDEMPOTENCY_TABLE = 'idempotency_keys';

const IDEMPOTENCY_PARAM_ORDER = Object.freeze([
  'idempotency_key',
  'company_id',
  'run_id',
  'call_index',
  'tool',
  'created_at',
  'expires_at',
] as const);

/**
 * Parameterised insert for a database-backed store. Parameters are bound in the order given by paramOrder.
 * ON CONFLICT DO NOTHING means a second insert of the same key writes no row; the caller reads the existing row
 * to find the previous outcome. Returned as text only; nothing here executes it.
 */
export function idempotencyInsertSql(): { text: string; paramOrder: readonly string[] } {
  const placeholders = IDEMPOTENCY_PARAM_ORDER.map((_, i) => `$${i + 1}`).join(', ');
  const text =
    `INSERT INTO ${IDEMPOTENCY_TABLE} (${IDEMPOTENCY_PARAM_ORDER.join(', ')})\n` +
    `VALUES (${placeholders})\n` +
    `ON CONFLICT DO NOTHING`;
  return { text, paramOrder: IDEMPOTENCY_PARAM_ORDER };
}
