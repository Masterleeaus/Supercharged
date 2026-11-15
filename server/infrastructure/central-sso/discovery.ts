/** OIDC discovery and JWKS retrieval. Endpoints are taken from the issuer's discovery document, never hard-coded. */
import {isHttpsUrl} from './config.ts';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type OidcMetadata = {
 issuer: string;
 authorizationEndpoint: string;
 tokenEndpoint: string;
 jwksUri: string;
};

export type Jwk = Record<string, unknown> & {kty?: string; kid?: string; alg?: string; use?: string};

const TIMEOUT_MS = 5000;

async function fetchJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
 const res = await fetchImpl(url, {
  method: 'GET',
  headers: {accept: 'application/json'},
  redirect: 'error',
  signal: AbortSignal.timeout(TIMEOUT_MS),
 });
 if (!res.ok) throw new Error(`central-sso: metadata request failed with status ${res.status}`);
 return res.json();
}

export function createDiscoveryClient({issuer, fetchImpl = fetch as FetchLike, clock = Date.now, ttlMs = 3_600_000}: {
 issuer: string;
 fetchImpl?: FetchLike;
 clock?: () => number;
 ttlMs?: number;
}) {
 if (!isHttpsUrl(issuer)) throw new TypeError('central-sso: https issuer required');
 let cached: {at: number; value: OidcMetadata} | null = null;

 return async function getMetadata(): Promise<OidcMetadata> {
  const now = clock();
  if (cached && now - cached.at < ttlMs) return cached.value;
  const doc = (await fetchJson(fetchImpl, `${issuer}/.well-known/openid-configuration`)) as Record<string, unknown>;
  if (!doc || typeof doc !== 'object') throw new Error('central-sso: discovery document is not an object');
  // The discovery issuer must match the configured issuer exactly (OIDC Discovery section 4.3).
  if (doc.issuer !== issuer) throw new Error('central-sso: discovery issuer mismatch');
  const endpoints = {
   authorizationEndpoint: doc.authorization_endpoint,
   tokenEndpoint: doc.token_endpoint,
   jwksUri: doc.jwks_uri,
  };
  for (const v of Object.values(endpoints)) {
   if (!isHttpsUrl(v)) throw new Error('central-sso: discovery endpoint is not https');
  }
  const value: OidcMetadata = {issuer, ...(endpoints as Omit<OidcMetadata, 'issuer'>)};
  cached = {at: now, value};
  return value;
 };
}

/** JWKS cache. Refetches on an unknown kid at most once per minute. */
export function createJwksClient({jwksUri, fetchImpl = fetch as FetchLike, clock = Date.now, ttlMs = 600_000}: {
 jwksUri: string;
 fetchImpl?: FetchLike;
 clock?: () => number;
 ttlMs?: number;
}) {
 let keys: Jwk[] = [];
 let fetchedAt = -Infinity;
 let lastMissRefetch = -Infinity;

 async function refresh(): Promise<void> {
  const doc = (await fetchJson(fetchImpl, jwksUri)) as {keys?: unknown};
  if (!doc || !Array.isArray(doc.keys)) throw new Error('central-sso: JWKS malformed');
  keys = doc.keys.filter((k): k is Jwk => !!k && typeof k === 'object' && typeof (k as Jwk).kid === 'string');
  fetchedAt = clock();
 }

 return async function getKey(kid: string): Promise<Jwk | null> {
  const now = clock();
  if (now - fetchedAt >= ttlMs) await refresh();
  let key = keys.find(k => k.kid === kid);
  if (!key && now - lastMissRefetch >= 60_000) {
   lastMissRefetch = now;
   await refresh();
   key = keys.find(k => k.kid === kid);
  }
  return key ?? null;
 };
}
