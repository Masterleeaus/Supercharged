/** Supercharged to Central service calls using the client-credentials grant (Central #194).
 * - Token endpoint comes from discovery.
 * - Audience is fixed to CENTRAL_SERVICE_AUDIENCE. A token for another audience is refused.
 * - Tenant identity is never sent in query or body; the tenant comes from the verified token.
 * - Tokens are cached in memory and refreshed before expiry. Token values are never logged.
 */
import {CENTRAL_SERVICE_AUDIENCE, isHttpsUrl, type CentralSsoConfig} from './config.ts';
import type {FetchLike, OidcMetadata} from './discovery.ts';

const REFRESH_LEEWAY_MS = 60_000;
const TIMEOUT_MS = 5000;
const FORBIDDEN_KEY = /organi[sz]ation|tenant|cohort/i;

export class CentralServiceError extends Error {
 constructor(readonly code: string) {
  super(`central-service: ${code}`);
  this.name = 'CentralServiceError';
 }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
 const parts = token.split('.');
 if (parts.length !== 3) return null;
 try {
  const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  return p && typeof p === 'object' ? (p as Record<string, unknown>) : null;
 } catch {
  return null;
 }
}

/** Walks keys recursively and rejects tenant-selecting names. */
export function assertNoTenantParams(value: unknown, depth = 0): void {
 if (value === null || typeof value !== 'object') return;
 // Fail closed: a payload nested this deep is refused rather than only partly scanned.
 if (depth > 8) throw new CentralServiceError('payload_too_deep');
 for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
  if (FORBIDDEN_KEY.test(k)) throw new CentralServiceError('tenant_param_forbidden');
  assertNoTenantParams(v, depth + 1);
 }
}

export function createCentralServiceClient({config, discovery, fetchImpl = fetch as FetchLike, clock = Date.now}: {
 config: CentralSsoConfig;
 discovery: () => Promise<OidcMetadata>;
 fetchImpl?: FetchLike;
 clock?: () => number;
}) {
 if (!config.enabled) throw new TypeError('central-service: enable Central SSO first');
 if (!config.serviceClientId || !config.serviceClientSecret) throw new TypeError('central-service: service credentials required');
 if (!config.apiBaseUrl || !isHttpsUrl(config.apiBaseUrl)) throw new TypeError('central-service: https API base URL required');
 const serviceClientId = config.serviceClientId;
 const serviceClientSecret = config.serviceClientSecret;
 const apiBaseUrl = config.apiBaseUrl;

 let cached: {token: string; expiresAt: number} | null = null;
 let inflight: Promise<string> | null = null;

 async function fetchToken(): Promise<string> {
  const meta = await discovery();
  const res = await fetchImpl(meta.tokenEndpoint, {
   method: 'POST',
   headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json'},
   body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: serviceClientId,
    client_secret: serviceClientSecret,
    audience: CENTRAL_SERVICE_AUDIENCE,
   }),
   redirect: 'error',
   signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new CentralServiceError('token_request_failed');
  const body = (await res.json()) as {access_token?: unknown; expires_in?: unknown; token_type?: unknown};
  const token = body.access_token;
  if (typeof token !== 'string' || token.length < 16 || token.length > 8192 || /\s/.test(token))
   throw new CentralServiceError('token_malformed');
  if (typeof body.token_type !== 'string' || body.token_type.toLowerCase() !== 'bearer')
   throw new CentralServiceError('token_type');
  if (typeof body.expires_in !== 'number' || !(body.expires_in > 0 && body.expires_in <= 86400))
   throw new CentralServiceError('token_expiry');

  // The token came straight from the token endpoint over TLS, so signature checks are not
  // repeated here. The audience and expiry are checked locally before the token is used.
  const payload = decodeJwtPayload(token);
  if (!payload) throw new CentralServiceError('token_not_checkable');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(CENTRAL_SERVICE_AUDIENCE)) throw new CentralServiceError('audience_mismatch');
  const now = clock();
  const expMs = typeof payload.exp === 'number' ? payload.exp * 1000 : NaN;
  const expiresAt = Math.min(now + body.expires_in * 1000, Number.isFinite(expMs) ? expMs : Infinity);
  if (expiresAt - now <= REFRESH_LEEWAY_MS) throw new CentralServiceError('token_expiry');
  cached = {token, expiresAt};
  return token;
 }

 async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt - clock() > REFRESH_LEEWAY_MS) return cached.token;
  if (!inflight) {
   inflight = fetchToken().finally(() => {
    inflight = null;
   });
  }
  return inflight;
 }

 return {
  getAccessToken,
  /** path is relative to the configured API base. Nothing about the tenant goes in query or body. */
  async request(path: string, opts: {method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; query?: Record<string, string>; body?: unknown} = {}): Promise<Response> {
   if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('..'))
    throw new CentralServiceError('bad_path');
   if (opts.query) assertNoTenantParams(opts.query);
   if (opts.body !== undefined) assertNoTenantParams(opts.body);
   const url = new URL(apiBaseUrl.replace(/\/+$/, '') + path);
   if (url.origin !== new URL(apiBaseUrl).origin) throw new CentralServiceError('bad_path');
   if (opts.query) for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
   const token = await getAccessToken();
   const hasBody = opts.body !== undefined;
   return fetchImpl(url.href, {
    method: opts.method ?? (hasBody ? 'POST' : 'GET'),
    headers: {
     authorization: `Bearer ${token}`,
     accept: 'application/json',
     ...(hasBody ? {'content-type': 'application/json'} : {}),
    },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
   });
  },
 };
}
