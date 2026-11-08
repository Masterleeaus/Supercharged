/**
 * Pure helpers for the Desk -> Titan workforce runtime adapter (no I/O, no globals).
 *
 * Signing follows the conventions of the existing Desk <-> Field local-link protocol
 * (server/integrations/titan-field/local-link-wire.mjs): HMAC-SHA256 over a schema-prefixed
 * canonical string, a `sha256=<hex>` header value, a 10-digit seconds timestamp, a 32+ byte
 * secret with no surrounding whitespace, a 180 second skew window, and timingSafeEqual.
 * It is NOT the same canonical string. local-link-wire.mjs only signs GET requests to two
 * fixed capability paths, and protocol.mjs does not bind method or path and caps bodies at
 * 8 KiB. The canonical string here binds purpose, method, path, timestamp and a SHA-256
 * digest of the body. Both sides of the runtime must agree on this exact construction,
 * which is ASSUMED until checked against services/workforce.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// Purpose label for domain separation. Distinct from the local-link schema on purpose.
export const WORKFORCE_SIGNING_SCHEMA = 'titan.zero.workforce-runtime.v1';
// ASSUMED: header names mirror the local-link headers. Verify against services/workforce.
export const TIMESTAMP_HEADER = 'x-titan-local-timestamp';
export const SIGNATURE_HEADER = 'x-titan-local-signature';
export const MAX_SKEW_SECONDS = 180;
export const MIN_SECRET_BYTES = 32;
export const MAX_REQUEST_BYTES = 65536;
export const MAX_RESPONSE_BYTES = 262144;
export const DEFAULT_TIMEOUT_MS = 5000;

// ASSUMED endpoints. None of these has been checked against services/workforce, which is not
// available in this workspace. Do not enable TITAN_WORKFORCE_URL until they are confirmed.
export const ENDPOINTS = Object.freeze({
  submitTask: Object.freeze({ method: 'POST', path: '/v1/tasks' }),
  getTask: Object.freeze({ method: 'GET', path: '/v1/tasks/:id' }),
  cancelTask: Object.freeze({ method: 'POST', path: '/v1/tasks/:id/cancel' }),
  health: Object.freeze({ method: 'GET', path: '/v1/health' }),
});

export const TASK_STATUSES = Object.freeze([
  'pending', 'running', 'awaiting_approval', 'completed', 'failed', 'cancelled',
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/;
const WORKFLOW_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const KIND_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const SIGNATURE_PATTERN = /^sha256=([a-f0-9]{64})$/;
const TIMESTAMP_PATTERN = /^[0-9]{10}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const SUBMIT_KEYS = Object.freeze(['idempotency_key', 'company_id', 'workflow', 'requested_by', 'resource', 'payload']);

/**
 * Error carrying a stable code only. The message is the code, never a URL, body, header or
 * secret, so it is safe to log or return to a caller.
 */
export class WorkforceRuntimeError extends Error {
  constructor(code, { status = null, retryable = false } = {}) {
    super(code);
    this.name = 'WorkforceRuntimeError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function invalidInput() {
  return new WorkforceRuntimeError('runtime_invalid_input');
}

function badResponse() {
  return new WorkforceRuntimeError('runtime_bad_response');
}

/** Secret must be 32+ bytes and must not have leading or trailing whitespace. */
export function isSecretAcceptable(secret) {
  return typeof secret === 'string'
    && Buffer.byteLength(secret, 'utf8') >= MIN_SECRET_BYTES
    && secret.trim() === secret;
}

export function requireSecret(secret) {
  if (!isSecretAcceptable(secret)) throw new WorkforceRuntimeError('runtime_secret_invalid');
  return secret;
}

/**
 * Accepts https origins, or http origins on 127.0.0.1 or localhost only. Rejects credentials,
 * paths, queries and fragments so that the adapter always targets the documented /v1 paths.
 * Returns the origin string.
 */
export function parseRuntimeUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') throw new WorkforceRuntimeError('runtime_url_invalid');
  let url;
  try { url = new URL(raw); } catch { throw new WorkforceRuntimeError('runtime_url_invalid'); }
  if (url.username || url.password) throw new WorkforceRuntimeError('runtime_url_invalid');
  const loopbackHttp = url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) throw new WorkforceRuntimeError('runtime_url_insecure');
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
    throw new WorkforceRuntimeError('runtime_url_not_origin');
  return url.origin;
}

/**
 * Pure config resolution. Returns { ok: true, baseUrl, secret } or { ok: false, reason }.
 * `reason` is a fixed code and never contains the secret or the URL.
 */
export function resolveRuntimeConfig(env = {}) {
  const rawUrl = env?.TITAN_WORKFORCE_URL;
  const secret = env?.TITAN_WORKFORCE_SECRET;
  if (rawUrl === undefined || rawUrl === '') return { ok: false, reason: 'runtime_url_missing' };
  if (secret === undefined || secret === '') return { ok: false, reason: 'runtime_secret_missing' };
  if (!isSecretAcceptable(secret)) return { ok: false, reason: 'runtime_secret_invalid' };
  try {
    return { ok: true, baseUrl: parseRuntimeUrl(rawUrl), secret };
  } catch (error) {
    return { ok: false, reason: error?.code ?? 'runtime_url_invalid' };
  }
}

export function validateTaskId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw invalidInput();
  return id;
}

export function bodyDigest(body) {
  return createHash('sha256').update(body).digest('hex');
}

function canonicalString({ method, path, timestamp, body }) {
  return [WORKFORCE_SIGNING_SCHEMA, method, path, timestamp, bodyDigest(body)].join('\n');
}

function checkSigningInputs({ method, path, timestamp }) {
  if (method !== 'GET' && method !== 'POST') throw invalidInput();
  if (typeof path !== 'string' || !/^\/v1\/[A-Za-z0-9/:_.-]{1,200}$/.test(path)) throw invalidInput();
  if (!TIMESTAMP_PATTERN.test(String(timestamp))) throw invalidInput();
}

/** Returns the `sha256=<hex>` header value for one request. */
export function signWorkforceRequest({ secret, method, path, timestamp, body = '' }) {
  requireSecret(secret);
  checkSigningInputs({ method, path, timestamp });
  if (typeof body !== 'string') throw invalidInput();
  const digest = createHmac('sha256', secret)
    .update(canonicalString({ method, path, timestamp: String(timestamp), body }))
    .digest('hex');
  return `sha256=${digest}`;
}

/** Verifies a signature. Throws WorkforceRuntimeError('runtime_signature_rejected') on failure. */
export function verifyWorkforceRequest({ secret, method, path, timestamp, body = '', signature, now = Date.now() }) {
  requireSecret(secret);
  checkSigningInputs({ method, path, timestamp });
  const reject = () => new WorkforceRuntimeError('runtime_signature_rejected', { status: 401 });
  if (!Number.isFinite(now)) throw reject();
  const skew = Math.abs(now / 1000 - Number(timestamp));
  if (!(skew <= MAX_SKEW_SECONDS)) throw reject();
  const match = typeof signature === 'string' ? SIGNATURE_PATTERN.exec(signature) : null;
  if (!match) throw reject();
  const expected = signWorkforceRequest({ secret, method, path, timestamp, body });
  const expectedHex = expected.slice('sha256='.length);
  if (!timingSafeEqual(Buffer.from(match[1], 'hex'), Buffer.from(expectedHex, 'hex'))) throw reject();
  return true;
}

/** Validates the submit input and returns a sanitized copy. Unknown keys are rejected. */
export function validateSubmitTask(input) {
  if (!isPlainObject(input)) throw invalidInput();
  const allowed = new Set(SUBMIT_KEYS);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw invalidInput();
  if (typeof input.idempotency_key !== 'string' || !ID_PATTERN.test(input.idempotency_key)) throw invalidInput();
  if (typeof input.company_id !== 'string' || !ID_PATTERN.test(input.company_id)) throw invalidInput();
  if (typeof input.requested_by !== 'string' || !ID_PATTERN.test(input.requested_by)) throw invalidInput();
  if (typeof input.workflow !== 'string' || !WORKFLOW_PATTERN.test(input.workflow)) throw invalidInput();
  if (!isPlainObject(input.payload)) throw invalidInput();
  const out = {
    idempotency_key: input.idempotency_key,
    company_id: input.company_id,
    workflow: input.workflow,
    requested_by: input.requested_by,
    payload: input.payload,
  };
  if (input.resource !== undefined) {
    const resource = input.resource;
    if (!isPlainObject(resource) || Object.keys(resource).some((k) => k !== 'kind' && k !== 'reference')) throw invalidInput();
    if (typeof resource.kind !== 'string' || !KIND_PATTERN.test(resource.kind)) throw invalidInput();
    if (typeof resource.reference !== 'string' || !ID_PATTERN.test(resource.reference)) throw invalidInput();
    out.resource = { kind: resource.kind, reference: resource.reference };
  }
  if (Buffer.byteLength(JSON.stringify(out), 'utf8') > MAX_REQUEST_BYTES) throw invalidInput();
  return out;
}

/**
 * Validates a task record from the runtime. Unknown fields are dropped. An unknown status or
 * a mismatched id is treated as a bad response, so the adapter fails closed.
 */
export function parseTaskRecord(value, expectedId) {
  if (!isPlainObject(value)) throw badResponse();
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id)) throw badResponse();
  if (expectedId !== undefined && value.id !== expectedId) throw badResponse();
  if (!TASK_STATUSES.includes(value.status)) throw badResponse();
  if (typeof value.workflow !== 'string' || !WORKFLOW_PATTERN.test(value.workflow)) throw badResponse();
  if (typeof value.company_id !== 'string' || !ID_PATTERN.test(value.company_id)) throw badResponse();
  let result = null;
  if (value.result !== undefined && value.result !== null) {
    if (!isPlainObject(value.result)) throw badResponse();
    result = value.result;
  }
  let errorCode = null;
  if (value.error_code !== undefined && value.error_code !== null) {
    if (typeof value.error_code !== 'string' || !KIND_PATTERN.test(value.error_code)) throw badResponse();
    errorCode = value.error_code;
  }
  let approvalReference = null;
  if (value.approval_reference !== undefined && value.approval_reference !== null) {
    if (typeof value.approval_reference !== 'string' || !ID_PATTERN.test(value.approval_reference)) throw badResponse();
    approvalReference = value.approval_reference;
  }
  return Object.freeze({
    id: value.id,
    status: value.status,
    workflow: value.workflow,
    company_id: value.company_id,
    result,
    error_code: errorCode,
    approval_reference: approvalReference,
  });
}

export function parseHealthRecord(value) {
  if (!isPlainObject(value) || value.ok !== true) throw badResponse();
  return Object.freeze({ ok: true });
}

/**
 * Builds the concrete path for an endpoint template such as /v1/tasks/:id. The id is validated
 * against a character allowlist with no '/', '?' or '%', so it needs no percent-encoding.
 */
export function taskPath(template, id) {
  return template.replace(':id', validateTaskId(id));
}
