/**
 * Hosted side of the plugin connector, contract tzfd-ai/1 (issue #401, H1).
 *
 * Framework-agnostic: takes the raw method, headers and body, returns status, headers and body.
 *
 * Order of checks (cheap and unauthenticated first, state changes last):
 *   1. method is POST                                  -> 405, unsigned
 *   2. contract header is tzfd-ai/1                    -> 400, unsigned
 *   3. site id, timestamp and nonce formats            -> 401, unsigned
 *   4. timestamp within 300 s of the server clock      -> 401, unsigned
 *   5. site id known to the registry                   -> 401, unsigned
 *   6. raw body within 16 KB                           -> 413, unsigned
 *   7. HMAC over timestamp.nonce.body matches          -> 401, unsigned
 *   8. nonce not seen before for this site (claim)     -> 401, unsigned
 *   9. JSON body, contract, site echo, feature, consent, scopes -> 200, signed body status
 *  10. handler runs with the tenant from the registry  -> 200, signed body status
 *
 * Every response that comes after the site is known (step 9 onward) is signed with the site
 * secret and echoes the request nonce. Steps 1 to 8 return unsigned responses, because there is
 * either no trusted site or no proven request. The plugin treats an unsigned response as
 * invalid and falls back to local behaviour.
 *
 * The tenant comes only from the registry entry for the verified site id. It never comes from
 * the body, a query string, or a browser-supplied value.
 */
import {
  TZFD_CONSENT_VERSION,
  TZFD_CONTRACT,
  TZFD_HEADERS,
  TZFD_LIMITS,
  TZFD_NONCE_PATTERN,
  TZFD_RESPONSE_STATUSES,
  TZFD_SITE_ID_PATTERN,
  isTzfdFeature,
  tzfdBodyBytes,
  tzfdSign,
  tzfdVerify,
  type TzfdResponseStatus,
  TZFD_FEATURES,
} from './contract.ts';

export interface TzfdSite {
  /** Value the plugin sends in X-TZFD-Site. Also the only trusted source of the site id. */
  readonly siteId: string;
  /** Tenant (company) this site is bound to. Resolved server-side, never from the request. */
  readonly tenantId: string;
  /** Per-site HMAC secret, at least TZFD_LIMITS.minSecretChars long. */
  readonly secret: string;
  /** Consent scopes the server has recorded for this site. The request's claim is not enough. */
  readonly grantedScopes: readonly string[];
}

export interface TzfdSiteRegistry {
  lookup(siteId: string): TzfdSite | null;
}

/** Records (site, nonce) pairs until they expire. claim() returns false when already seen. */
export interface TzfdNonceStore {
  claim(siteId: string, nonce: string, expiresAtMs: number, nowMs: number): boolean;
}

export interface TzfdFeatureContext {
  readonly tenantId: string;
  readonly siteId: string;
  readonly feature: string;
  readonly payload: unknown;
}

export interface TzfdFeatureResult {
  readonly status: TzfdResponseStatus;
  readonly data?: unknown;
  readonly usage?: Record<string, unknown>;
}

export type TzfdFeatureHandler = (ctx: TzfdFeatureContext) => Promise<TzfdFeatureResult>;

export interface TzfdEndpointOptions {
  readonly registry: TzfdSiteRegistry;
  readonly nonces: TzfdNonceStore;
  /** Only features with a handler here are served. A feature with no handler is contract_unsupported. */
  readonly handlers: Readonly<Record<string, TzfdFeatureHandler>>;
  readonly now?: () => number;
}

export interface TzfdRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
}

export interface TzfdResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const EMPTY_USAGE = Object.freeze({ tokens_in: 0, tokens_out: 0, embedding_tokens: 0, cache_hit: false });
const JSON_HEADERS = Object.freeze({ 'content-type': 'application/json' });

function header(req: TzfdRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(req.headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
    return value;
  }
  return undefined;
}

function unsigned(status: number, error: string): TzfdResponse {
  return { status, headers: JSON_HEADERS, body: JSON.stringify({ contract: TZFD_CONTRACT, error }) };
}

/** Builds and signs a body-level response. The request nonce is echoed, as the plugin requires. */
function signed(
  secret: string,
  siteId: string,
  nonce: string,
  nowSeconds: number,
  status: TzfdResponseStatus,
  data: unknown,
  usage: Record<string, unknown>,
): TzfdResponse {
  let body = JSON.stringify({ contract: TZFD_CONTRACT, site: siteId, status, data, usage });
  if (tzfdBodyBytes(body) > TZFD_LIMITS.responseBodyBytes) {
    body = JSON.stringify({ contract: TZFD_CONTRACT, site: siteId, status: 'service_error', data: {}, usage: EMPTY_USAGE });
  }
  const timestamp = String(nowSeconds);
  return {
    status: 200,
    headers: {
      ...JSON_HEADERS,
      'X-TZFD-Timestamp': timestamp,
      'X-TZFD-Nonce': nonce,
      'X-TZFD-Signature': tzfdSign(secret, timestamp, nonce, body),
    },
    body,
  };
}

export async function handleTzfdRequest(opts: TzfdEndpointOptions, req: TzfdRequest): Promise<TzfdResponse> {
  const nowMs = (opts.now ?? Date.now)();
  const nowSeconds = Math.floor(nowMs / 1000);

  if (req.method.toUpperCase() !== 'POST') return unsigned(405, 'method_not_allowed');

  if (header(req, TZFD_HEADERS.contract) !== TZFD_CONTRACT) return unsigned(400, 'contract_unsupported');

  const siteId = header(req, TZFD_HEADERS.site);
  if (siteId === undefined || !TZFD_SITE_ID_PATTERN.test(siteId)) return unsigned(401, 'auth_failed');

  const timestamp = header(req, TZFD_HEADERS.timestamp);
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp)) return unsigned(401, 'auth_failed');
  if (Math.abs(nowSeconds - Number(timestamp)) > TZFD_LIMITS.timestampSkewSeconds) {
    return unsigned(401, 'auth_failed');
  }

  const nonce = header(req, TZFD_HEADERS.nonce);
  if (nonce === undefined || !TZFD_NONCE_PATTERN.test(nonce)) return unsigned(401, 'auth_failed');

  const site = opts.registry.lookup(siteId);
  if (site === null || site.secret.length < TZFD_LIMITS.minSecretChars) return unsigned(401, 'auth_failed');

  if (tzfdBodyBytes(req.body) > TZFD_LIMITS.requestBodyBytes) return unsigned(413, 'body_too_large');

  if (!tzfdVerify(site.secret, timestamp, nonce, req.body, header(req, TZFD_HEADERS.signature))) {
    return unsigned(401, 'auth_failed');
  }

  // Claimed only after the signature is proven, so unsigned traffic cannot fill the store.
  const expiresAtMs = Number(timestamp) * 1000 + TZFD_LIMITS.timestampSkewSeconds * 1000;
  if (!opts.nonces.claim(site.siteId, nonce, expiresAtMs, nowMs)) return unsigned(401, 'auth_failed');

  const reply = (status: TzfdResponseStatus, data: unknown = {}, usage: Record<string, unknown> = EMPTY_USAGE) =>
    signed(site.secret, site.siteId, nonce, nowSeconds, status, data, usage);

  let parsed: unknown;
  try {
    parsed = JSON.parse(req.body);
  } catch {
    return reply('contract_unsupported');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return reply('contract_unsupported');
  const envelope = parsed as Record<string, unknown>;

  if (envelope.contract !== TZFD_CONTRACT) return reply('contract_unsupported');
  // A body that names another site is a tenant mismatch. It is refused even though the signature is valid.
  if (envelope.site !== site.siteId) return reply('service_error');
  if (!isTzfdFeature(envelope.feature)) return reply('contract_unsupported');
  const feature = envelope.feature;

  const consent = envelope.consent as { version?: unknown; scopes?: unknown } | undefined;
  if (typeof consent !== 'object' || consent === null || consent.version !== TZFD_CONSENT_VERSION) {
    return reply('contract_unsupported');
  }
  const claimed = Array.isArray(consent.scopes) ? consent.scopes.filter((s): s is string => typeof s === 'string') : [];
  const required = TZFD_FEATURES[feature].scopes;
  const granted = required.every((scope) => claimed.includes(scope) && site.grantedScopes.includes(scope));
  if (!granted) return reply('service_error');

  const handler = Object.prototype.hasOwnProperty.call(opts.handlers, feature) ? opts.handlers[feature] : undefined;
  if (handler === undefined) return reply('contract_unsupported');

  let result: TzfdFeatureResult;
  try {
    result = await handler({ tenantId: site.tenantId, siteId: site.siteId, feature, payload: envelope.payload });
  } catch {
    // The handler error is not returned: it may carry internal detail.
    return reply('service_error');
  }
  if (!(TZFD_RESPONSE_STATUSES as readonly string[]).includes(result.status)) return reply('service_error');
  return reply(result.status, result.data ?? {}, result.usage ?? EMPTY_USAGE);
}

/** In-memory nonce store. Good for one process only; a multi-instance deploy needs a shared store. */
export function createMemoryNonceStore(): TzfdNonceStore {
  const seen = new Map<string, number>();
  return {
    claim(siteId, nonce, expiresAtMs, nowMs) {
      for (const [key, expiry] of seen) if (expiry <= nowMs) seen.delete(key);
      const key = `${siteId}\u0000${nonce}`;
      if (seen.has(key)) return false;
      seen.set(key, expiresAtMs);
      return true;
    },
  };
}
