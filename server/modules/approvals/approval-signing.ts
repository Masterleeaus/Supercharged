/*
 * HMAC-SHA256 signing of an approval decision.
 *
 * The signed payload binds one decision to: the approval id, the hash of the exact
 * action being approved, the decider's id, and the decision timestamp. The
 * approach follows the Interaction Engine's ApprovalSigner (HMAC over a canonical
 * encoding, constant-time comparison). The code here is original and uses no
 * engine text.
 *
 * Secrets: a secret shorter than 32 characters, or one that matches a known
 * placeholder, is refused. Refusal happens on both sign and verify. Errors never
 * include the secret, and nothing here logs.
 *
 * Pure: no database, no environment reads. The caller passes the secret in.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Minimum secret length in characters. The engine's PHP signer uses 16; Desk uses 32. */
export const MIN_APPROVAL_SECRET_LENGTH = 32;

/** Minimum number of distinct characters in a secret. Blocks strings like 'aaaa...'. */
const MIN_DISTINCT_CHARS = 10;

/**
 * Known placeholder or demo secrets, compared after trim and lowercase.
 * 'change-me' and 'change-this-approval-secret' are the fallbacks in the engine's
 * config/interaction.php. The eval fixture secret is public in its repository.
 */
const PLACEHOLDER_SECRETS: ReadonlySet<string> = new Set([
  'change-me',
  'change-this-approval-secret',
  'interaction-policy-eval-secret-2026',
  'changeme',
  'change-this',
  'secret',
  'password',
  'test',
]);

/** Patterns that mark a secret as a placeholder even when it is long enough. */
const PLACEHOLDER_PATTERN = /change[-_ ]?(me|this)|placeholder|your[-_ ]?(secret|key)|example|dummy|default[-_ ]?secret|secret[-_ ]?here/i;

/** Thrown when a secret is refused. The message never contains the secret. */
export class ApprovalSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalSecretError';
  }
}

/** The fields an approval decision is signed over. */
export interface ApprovalDecisionFields {
  /** Id of the approval row (Desk approvals.id). */
  approvalId: string;
  /** Hex SHA-256 of the action, from hashAction(). */
  actionHash: string;
  /** Namespaced decider id, e.g. "dashboard:user-42". Must come from the verified caller. */
  deciderId: string;
  /** Decision time. A Date or an ISO-8601 string. Normalised to UTC ISO before signing. */
  decidedAt: Date | string;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const SIGNING_DOMAIN = 'desk.approval-decision';
const SIGNING_VERSION = 1;

/**
 * Throws ApprovalSecretError unless the secret is usable. Returns the secret
 * unchanged so callers can write `const s = assertApprovalSecret(raw)`.
 */
export function assertApprovalSecret(secret: unknown): string {
  if (typeof secret !== 'string') {
    throw new ApprovalSecretError('Approval signing secret must be a string.');
  }
  if (secret.length < MIN_APPROVAL_SECRET_LENGTH) {
    throw new ApprovalSecretError(`Approval signing secret must be at least ${MIN_APPROVAL_SECRET_LENGTH} characters.`);
  }
  const normalised = secret.trim().toLowerCase();
  if (PLACEHOLDER_SECRETS.has(normalised) || PLACEHOLDER_PATTERN.test(secret)) {
    throw new ApprovalSecretError('Approval signing secret is a placeholder value. Configure a real secret.');
  }
  if (new Set(secret).size < MIN_DISTINCT_CHARS) {
    throw new ApprovalSecretError('Approval signing secret has too few distinct characters.');
  }
  return secret;
}

/**
 * Hex SHA-256 of an action name and its parameters. Object keys are sorted at
 * every depth, so key order does not change the hash. Date values are written as
 * ISO strings. Values with no JSON form (undefined in arrays, NaN, functions,
 * cycles, class instances) throw, so they cannot be hashed by accident.
 */
export function hashAction(action: string, params: unknown): string {
  if (typeof action !== 'string' || action.length === 0) {
    throw new TypeError('hashAction requires a non-empty action name.');
  }
  return createHash('sha256').update(stableStringify({ action, params: params ?? {} }), 'utf8').digest('hex');
}

/** Signs a decision. Throws ApprovalSecretError on a bad secret and TypeError on bad fields. */
export function signApprovalDecision(fields: ApprovalDecisionFields, secret: string): string {
  const key = assertApprovalSecret(secret);
  const payload = canonicalPayload(fields);
  if (payload === null) {
    throw new TypeError('Approval decision fields are malformed.');
  }
  return createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

/**
 * True only when the signature matches the fields under this secret. Uses
 * timingSafeEqual on equal-length buffers. A malformed signature or field set
 * returns false. A bad secret still throws ApprovalSecretError, so a
 * misconfigured verifier cannot pass silently.
 */
export function verifyApprovalDecision(fields: ApprovalDecisionFields, signature: unknown, secret: string): boolean {
  const key = assertApprovalSecret(secret);
  if (typeof signature !== 'string' || !HEX_64.test(signature)) {
    return false;
  }
  const payload = canonicalPayload(fields);
  if (payload === null) {
    return false;
  }
  const expected = createHmac('sha256', key).update(payload, 'utf8').digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Builds the signed bytes as a JSON array. An array has no key order to
 * disagree on, and JSON escaping stops a field containing a separator from
 * being read as two fields. Returns null for malformed fields.
 */
function canonicalPayload(fields: ApprovalDecisionFields): string | null {
  if (fields === null || typeof fields !== 'object') return null;
  const { approvalId, actionHash, deciderId, decidedAt } = fields;
  if (!isNonEmptyString(approvalId) || !isNonEmptyString(deciderId)) return null;
  if (typeof actionHash !== 'string' || !HEX_64.test(actionHash)) return null;
  const when = normaliseTimestamp(decidedAt);
  if (when === null) return null;
  return JSON.stringify([SIGNING_DOMAIN, SIGNING_VERSION, approvalId, actionHash, deciderId, when]);
}

function normaliseTimestamp(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (date === null || Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function stableStringify(value: unknown): string {
  return stableEncode(value, new WeakSet<object>());
}

function stableEncode(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers cannot be hashed.');
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new TypeError(`Values of type ${typeof value} cannot be hashed.`);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError('Invalid Date cannot be hashed.');
    return JSON.stringify(value.toISOString());
  }
  if (seen.has(value)) throw new TypeError('Cyclic values cannot be hashed.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => {
        if (item === undefined) throw new TypeError('undefined inside an array cannot be hashed.');
        return stableEncode(item, seen);
      });
      return `[${items.join(',')}]`;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError('Only plain objects, arrays and primitives can be hashed.');
    }
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const inner = record[key];
      if (inner === undefined) continue; // mirrors JSON.stringify: undefined properties are omitted
      parts.push(`${JSON.stringify(key)}:${stableEncode(inner, seen)}`);
    }
    return `{${parts.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}
