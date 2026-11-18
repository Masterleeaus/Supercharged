/**
 * Connector SDK contract (#349).
 *
 * One interface every outside system implements: its auth type, what it can do (read, write,
 * inbound and outbound webhooks), the canonical entities it speaks, and a single `execute`
 * entry point for vendor calls. The shared runner (runner.ts) wraps every call with timeouts,
 * retries, idempotency keys, field mapping and an audit record, so a connector never does those
 * itself.
 *
 * Pure: no network, database or environment access.
 */

export const AUTH_TYPES = ['oauth2', 'api_key', 'none'] as const;
export type AuthType = (typeof AUTH_TYPES)[number];

export const CAPABILITIES = ['read', 'write', 'webhook_in', 'webhook_out'] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const ENTITY_TYPES = ['contact', 'booking', 'job', 'quote', 'invoice', 'message'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Error taxonomy. Only the codes in RETRYABLE_CODES are retried by the shared client. */
export const ERROR_CODES = [
  'auth',
  'forbidden',
  'not_found',
  'validation',
  'conflict',
  'rate_limited',
  'timeout',
  'upstream',
  'unknown',
] as const;
export type ConnectorErrorCode = (typeof ERROR_CODES)[number];

const RETRYABLE_CODES: ReadonlySet<ConnectorErrorCode> = new Set(['rate_limited', 'timeout', 'upstream']);

export interface ConnectorErrorOptions {
  retryAfterMs?: number;
  /** Optional vendor status code. Never a response body: bodies can echo tokens. */
  status?: number;
}

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;

  constructor(code: ConnectorErrorCode, message: string, options: ConnectorErrorOptions = {}) {
    super(message);
    this.name = 'ConnectorError';
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.retryAfterMs = options.retryAfterMs;
    this.status = options.status;
  }
}

/** Maps a vendor HTTP status to the taxonomy. Callers pass the status, never the body. */
export function errorFromStatus(status: number, retryAfterMs?: number): ConnectorError {
  if (status === 429) return new ConnectorError('rate_limited', 'Vendor rate limit reached', { status, retryAfterMs });
  if (status === 401) return new ConnectorError('auth', 'Vendor rejected the credentials', { status });
  if (status === 403) return new ConnectorError('forbidden', 'Vendor refused the action', { status });
  if (status === 404) return new ConnectorError('not_found', 'Vendor record not found', { status });
  if (status === 409) return new ConnectorError('conflict', 'Vendor reported a conflict', { status });
  if (status === 400 || status === 422) return new ConnectorError('validation', 'Vendor rejected the payload', { status });
  if (status >= 500) return new ConnectorError('upstream', 'Vendor server error', { status });
  return new ConnectorError('unknown', 'Unexpected vendor response', { status });
}

export interface ActionDefinition {
  kind: 'read' | 'write';
  entity: EntityType;
}

export interface ActionRequest {
  action: string;
  input: unknown;
  /** Present on every write. The runner supplies one when the caller does not. */
  idempotencyKey?: string;
  /** Per-attempt deadline the runner enforces. */
  timeoutMs: number;
}

/** Credentials handed to a connector for one call. Never logged, never placed in a URL. */
export type ConnectorCredentials =
  | { type: 'oauth2'; accessToken: string; tokenType?: string; expiresAt?: number }
  | { type: 'api_key'; apiKey: string }
  | { type: 'none' };

export interface ConnectorDefinition {
  id: string;
  auth: AuthType;
  capabilities: Capability[];
  entities: EntityType[];
  actions: Record<string, ActionDefinition>;
  /** The only vendor call. Throws ConnectorError for every failure it can name. */
  execute(request: ActionRequest, credentials: ConnectorCredentials): Promise<unknown>;
  /** Required when the connector declares webhook_in. Returns false to reject the delivery. */
  verifyWebhook?(rawBody: string, signature: string, secret: string): boolean;
}

/** Validates that a definition is internally consistent. Returns the list of problems (empty when valid). */
export function checkConnectorDefinition(def: ConnectorDefinition): string[] {
  const problems: string[] = [];
  if (typeof def.id !== 'string' || def.id.length === 0) problems.push('id is required');
  if (!(AUTH_TYPES as readonly string[]).includes(def.auth)) problems.push(`auth must be one of ${AUTH_TYPES.join(', ')}`);
  for (const cap of def.capabilities ?? []) {
    if (!(CAPABILITIES as readonly string[]).includes(cap)) problems.push(`unknown capability "${cap}"`);
  }
  for (const entity of def.entities ?? []) {
    if (!(ENTITY_TYPES as readonly string[]).includes(entity)) problems.push(`unknown entity "${entity}"`);
  }
  const caps = new Set(def.capabilities ?? []);
  for (const [name, action] of Object.entries(def.actions ?? {})) {
    if (!caps.has(action.kind)) problems.push(`action "${name}" needs capability "${action.kind}"`);
    if (!(def.entities ?? []).includes(action.entity)) problems.push(`action "${name}" uses an undeclared entity`);
  }
  if (caps.has('webhook_in') && typeof def.verifyWebhook !== 'function') {
    problems.push('webhook_in requires verifyWebhook');
  }
  return problems;
}
