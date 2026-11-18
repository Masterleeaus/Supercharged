/**
 * Hosted endpoint for the tzfd-ai/1 connector. Framework-free: it takes a request shape and
 * returns a response shape, so a router can mount it later. Nothing is mounted here.
 *
 * Order of checks: method, body size, contract header, site/timestamp/nonce/signature headers,
 * signature, body JSON and contract, tenant, feature, consent, payload, nonce replay, dispatch.
 * Refusals are unsigned JSON with the right HTTP status and no secret. A valid, signed outcome
 * is always HTTP 200 with a signed body.
 */
import {
  CONTRACT,
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  SIGNATURE_WINDOW_SECONDS,
  signTzfd,
  verifyTzfdSignature,
  type BodyBytes,
} from './signing.ts';
import { createMemoryNonceStore, type NonceStore } from './nonce-store.ts';
import {
  FEATURES,
  defaultFeatureImplementation,
  type FeatureImplementation,
  type FeatureOutcome,
} from './features.ts';

export const CONSENT_VERSION = 'tzfd-ai-consent-1';

const SITE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const NONCE_PATTERN = /^[0-9a-f]{32}$/;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;
const TIMESTAMP_PATTERN = /^[0-9]{1,11}$/;
const RESPONSE_STATUSES = new Set(['ok', 'allowance_exhausted', 'service_error', 'contract_unsupported']);
/** Every scope name any feature uses. An offered scope outside this set is a malformed request. */
const KNOWN_SCOPES: ReadonlySet<string> = new Set([...FEATURES.values()].flatMap((definition) => definition.scopes));

export type RefusalReason =
  | 'method_not_allowed'
  | 'body_too_large'
  | 'contract_unsupported'
  | 'invalid_request'
  | 'stale_timestamp'
  | 'bad_signature'
  | 'tenant_mismatch'
  | 'feature_not_allowed'
  | 'scope_not_granted'
  | 'replay'
  | 'internal_error';

const REFUSAL_STATUS: Record<RefusalReason, number> = {
  method_not_allowed: 405,
  body_too_large: 413,
  contract_unsupported: 426,
  invalid_request: 400,
  stale_timestamp: 401,
  bad_signature: 401,
  tenant_mismatch: 403,
  feature_not_allowed: 400,
  scope_not_granted: 403,
  replay: 409,
  internal_error: 500,
};

export type RequestHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface ConnectorRequest {
  readonly method: string;
  readonly headers: RequestHeaders;
  readonly body: BodyBytes;
}

export interface ConnectorResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface ConnectorDeps {
  /** Site secret for a tenant, or null/undefined when the site is unknown. Never logged or returned. */
  secretForSite(site: string): string | null | undefined | Promise<string | null | undefined>;
  /** Scopes the site administrator has granted for this tenant. */
  grantedScopes(site: string): readonly string[] | Promise<readonly string[]>;
  nonces?: NonceStore;
  feature?: FeatureImplementation;
  /** Epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
}

export function createConnectorHandler(deps: ConnectorDeps): (request: ConnectorRequest) => Promise<ConnectorResponse> {
  const nonces = deps.nonces ?? createMemoryNonceStore();
  const feature = deps.feature ?? defaultFeatureImplementation;
  const now = deps.now ?? Date.now;

  return async (request) => {
    try {
      return await handle(request, { ...deps, nonces, feature, now });
    } catch {
      return refusal('internal_error');
    }
  };
}

interface Resolved extends ConnectorDeps {
  readonly nonces: NonceStore;
  readonly feature: FeatureImplementation;
  readonly now: () => number;
}

async function handle(request: ConnectorRequest, deps: Resolved): Promise<ConnectorResponse> {
  if (request.method.toUpperCase() !== 'POST') return refusal('method_not_allowed');

  const body = typeof request.body === 'string' ? Buffer.from(request.body, 'utf8') : Buffer.from(request.body);
  if (body.length > MAX_REQUEST_BYTES) return refusal('body_too_large');

  const header = headerReader(request.headers);
  if (header('x-tzfd-contract') !== CONTRACT) return refusal('contract_unsupported');

  const site = header('x-tzfd-site');
  if (site === undefined || !SITE_PATTERN.test(site)) return refusal('invalid_request');

  const timestamp = header('x-tzfd-timestamp');
  if (timestamp === undefined || !TIMESTAMP_PATTERN.test(timestamp)) return refusal('invalid_request');

  const nonce = header('x-tzfd-nonce');
  if (nonce === undefined || !NONCE_PATTERN.test(nonce)) return refusal('invalid_request');

  const signature = header('x-tzfd-signature');
  if (signature === undefined || !SIGNATURE_PATTERN.test(signature)) return refusal('bad_signature');

  const nowMs = deps.now();
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_WINDOW_SECONDS) return refusal('stale_timestamp');

  // Unknown site and bad signature give the same answer, so the tenant list is not revealed.
  const secret = await deps.secretForSite(site);
  if (typeof secret !== 'string' || secret === '') return refusal('bad_signature');
  if (!verifyTzfdSignature(secret, timestamp, nonce, body, signature)) return refusal('bad_signature');

  const parsed = parseJsonObject(body);
  if (parsed === undefined) return refusal('invalid_request');
  if (parsed.contract !== CONTRACT) return refusal('contract_unsupported');
  if (parsed.site !== site) return refusal('tenant_mismatch');

  const featureName = typeof parsed.feature === 'string' ? parsed.feature : '';
  const definition = FEATURES.get(featureName);
  if (definition === undefined) return refusal('feature_not_allowed');

  const consent = parsed.consent;
  if (!isPlainObject(consent) || consent.version !== CONSENT_VERSION) return refusal('invalid_request');
  if (!Array.isArray(consent.scopes) || !consent.scopes.every((scope) => typeof scope === 'string')) {
    return refusal('invalid_request');
  }
  const offered = consent.scopes as string[];
  if (!offered.every((scope) => KNOWN_SCOPES.has(scope))) return refusal('invalid_request');
  // The plugin sends every granted scope. Offered scopes this feature does not use are ignored:
  // they are neither refused nor passed on. Only the feature's own scopes that were offered are used.
  const scopes = definition.scopes.filter((scope) => offered.includes(scope));
  if (scopes.length === 0) return refusal('scope_not_granted');
  const granted = await deps.grantedScopes(site);
  if (!scopes.every((scope) => granted.includes(scope))) return refusal('scope_not_granted');

  // The plugin sends an empty PHP array as [], so arrays are accepted alongside objects.
  const payload = parsed.payload;
  if (!isPlainObject(payload) && !Array.isArray(payload)) return refusal('invalid_request');

  const fresh = await deps.nonces.claim(nonce, Number(timestamp) * 1000 + SIGNATURE_WINDOW_SECONDS * 1000, nowMs);
  if (!fresh) return refusal('replay');

  let outcome: FeatureOutcome;
  try {
    outcome = await deps.feature({ site, feature: featureName, payload, scopes });
  } catch {
    outcome = { status: 'service_error' };
  }
  return signedOutcome(site, nonce, outcome, secret, deps.now());
}

function signedOutcome(
  site: string,
  nonce: string,
  outcome: FeatureOutcome,
  secret: string,
  nowMs: number,
): ConnectorResponse {
  const status = typeof outcome?.status === 'string' && RESPONSE_STATUSES.has(outcome.status) ? outcome.status : 'service_error';
  const data = status === 'ok' && isPlainObject(outcome.data) ? outcome.data : {};
  const usage = normaliseUsage(outcome?.usage);

  let body = serialise({ contract: CONTRACT, site, status, data, usage });
  if (body === undefined || Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
    body = serialise({ contract: CONTRACT, site, status: 'service_error', data: {}, usage: normaliseUsage(undefined) }) as string;
  }

  const timestamp = String(Math.floor(nowMs / 1000));
  return {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'X-TZFD-Timestamp': timestamp,
      'X-TZFD-Nonce': nonce,
      'X-TZFD-Signature': signTzfd(secret, timestamp, nonce, body),
    },
    body,
  };
}

function refusal(reason: RefusalReason): ConnectorResponse {
  return {
    status: REFUSAL_STATUS[reason],
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ contract: CONTRACT, refused: true, reason }),
  };
}

/** Case-insensitive header lookup. A repeated header counts as missing, so it cannot be used to smuggle a second value. */
function headerReader(raw: RequestHeaders): (name: string) => string | undefined {
  const values = new Map<string, string[]>();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    const key = name.toLowerCase();
    const list = Array.isArray(value) ? [...value] : [value as string];
    values.set(key, [...(values.get(key) ?? []), ...list]);
  }
  return (name) => {
    const list = values.get(name);
    return list !== undefined && list.length === 1 ? list[0] : undefined;
  };
}

function parseJsonObject(body: Buffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    return isPlainObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function normaliseUsage(value: unknown): { tokens_in: number; tokens_out: number; embedding_tokens: number; cache_hit: boolean } {
  const usage = isPlainObject(value) ? value : {};
  const count = (field: unknown): number => (Number.isSafeInteger(field) && (field as number) >= 0 ? (field as number) : 0);
  return {
    tokens_in: count(usage.tokens_in),
    tokens_out: count(usage.tokens_out),
    embedding_tokens: count(usage.embedding_tokens),
    cache_hit: usage.cache_hit === true,
  };
}

function serialise(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
