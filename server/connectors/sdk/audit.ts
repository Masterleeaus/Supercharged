/**
 * Audit records for connector actions (#349, and the "no credentials in audit" rule of #351).
 * Every action writes one record: company, connector, action, idempotency key, outcome and a redacted
 * payload. Pure: the sink is injected.
 */

export interface ConnectorAuditRecord {
  companyId: string;
  connector: string;
  action: string;
  idempotencyKey: string | null;
  outcome: 'success' | 'failure';
  errorCode: string | null;
  attempts: number;
  durationMs: number;
  payload: unknown;
  at: string;
}

export type AuditSink = (record: ConnectorAuditRecord) => Promise<void>;

const SENSITIVE_KEY = /token|secret|passw|api[_-]?key|authorization|cookie|credential|signature|private|session|code_verifier/i;
const SENSITIVE_VALUE = /^(bearer|basic)\s+\S+/i;
const SENSITIVE_QUERY = /(access_token|refresh_token|code|client_secret|api_key)=/i;
const MAX_STRING = 500;
const MAX_DEPTH = 6;
export const REDACTED = '[redacted]';

/** Returns a copy of value with secrets replaced. Never throws on odd input. */
export function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[truncated]';
  if (typeof value === 'string') {
    if (SENSITIVE_VALUE.test(value) || SENSITIVE_QUERY.test(value)) return REDACTED;
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}...` : value;
  }
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, depth + 1));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactPayload(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export function buildAuditRecord(input: {
  companyId: string;
  connector: string;
  action: string;
  idempotencyKey?: string;
  outcome: 'success' | 'failure';
  errorCode?: string;
  attempts: number;
  durationMs: number;
  payload: unknown;
  now: Date;
}): ConnectorAuditRecord {
  return {
    companyId: input.companyId,
    connector: input.connector,
    action: input.action,
    idempotencyKey: input.idempotencyKey ?? null,
    outcome: input.outcome,
    errorCode: input.errorCode ?? null,
    attempts: input.attempts,
    durationMs: input.durationMs,
    payload: redactPayload(input.payload),
    at: input.now.toISOString(),
  };
}
