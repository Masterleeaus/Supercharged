/** Central OIDC sign-in: authorization code flow with PKCE (S256), state and nonce.
 * Produces a VerifiedDeskCentralSelection only after the real callback has
 * exchanged the code and verified the ID token. Browser input is never trusted
 * as authority. Disabled unless the config has enabled:true.
 */
import type {CentralSsoConfig} from './config.ts';
import type {FetchLike, OidcMetadata, Jwk} from './discovery.ts';
import {verifyIdToken, type IdTokenFailure} from './id-token.ts';
import {createPkce, randomToken, safeEqual, type RandomBytes} from './pkce.ts';
import {isCompanyId} from '../database/tenant-context.ts';
import type {VerifiedDeskCentralSelection} from './selection-contract.ts';

export const TXN_COOKIE = '__Host-central_sso_txn';
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PARAM = 2048;

export type PendingLogin = {codeVerifier: string; nonce: string};

export interface PendingStore {
 /** Returns false when the record could not be stored (store full). The caller must not redirect then. */
 put(state: string, record: PendingLogin, ttlMs: number): boolean | Promise<boolean>;
 /** Single use: returns the record once, then nothing for that state. */
 take(state: string): PendingLogin | null | Promise<PendingLogin | null>;
}

/** In-memory store. Single process only. Multi-instance deploys use createDatabasePendingStore (pending-store-db.ts). */
export function createMemoryPendingStore({clock = Date.now, maxEntries = 1000}: {clock?: () => number; maxEntries?: number} = {}): PendingStore {
 const map = new Map<string, {record: PendingLogin; expiresAt: number}>();
 return {
  put(state, record, ttlMs) {
   const now = clock();
   for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k);
   if (map.size >= maxEntries) return false;
   map.set(state, {record, expiresAt: now + ttlMs});
   return true;
  },
  take(state) {
   const entry = map.get(state);
   map.delete(state);
   if (!entry || entry.expiresAt <= clock()) return null;
   return entry.record;
  },
 };
}

export type FlowFailure =
 | 'disabled' | 'provider_error' | 'bad_request' | 'state_mismatch' | 'unknown_state'
 | 'metadata' | 'token_exchange' | 'id_token' | 'company_claim' | 'session_unavailable';

export type FlowStart = {ok: true; redirectUrl: string; state: string} | {ok: false; reason: FlowFailure};
export type FlowComplete = {ok: true; selection: VerifiedDeskCentralSelection} | {ok: false; reason: FlowFailure | IdTokenFailure};

export function createCentralOidcFlow({config, discovery, jwksKeys, pending, fetchImpl = fetch as FetchLike, clock = Date.now, random}: {
 config: CentralSsoConfig;
 discovery: () => Promise<OidcMetadata>;
 jwksKeys: (kid: string) => Promise<Jwk | null>;
 pending: PendingStore;
 fetchImpl?: FetchLike;
 clock?: () => number;
 random?: RandomBytes;
}) {
 return {
  async start(): Promise<FlowStart> {
   if (!config.enabled) return {ok: false, reason: 'disabled'};
   let meta: OidcMetadata;
   try {
    meta = await discovery();
   } catch {
    return {ok: false, reason: 'metadata'};
   }
   const pkce = createPkce(random);
   const state = randomToken(random);
   const nonce = randomToken(random);
   const stored = await pending.put(state, {codeVerifier: pkce.codeVerifier, nonce}, PENDING_TTL_MS);
   if (stored === false) return {ok: false, reason: 'session_unavailable'};
   const url = new URL(meta.authorizationEndpoint);
   url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid',
    state,
    nonce,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: pkce.codeChallengeMethod,
   }).toString();
   return {ok: true, redirectUrl: url.href, state};
  },

  async complete(input: {query: Record<string, unknown>; cookieState: unknown}): Promise<FlowComplete> {
   if (!config.enabled) return {ok: false, reason: 'disabled'};
   const {query, cookieState} = input;
   // Provider errors are not echoed back; only a fixed reason is returned.
   if (query.error !== undefined) return {ok: false, reason: 'provider_error'};
   const {code, state} = query;
   if (typeof code !== 'string' || typeof state !== 'string' || code.length > MAX_PARAM || state.length > MAX_PARAM || code === '')
    return {ok: false, reason: 'bad_request'};
   // Browser binding: the state must match the host-only transaction cookie.
   if (!safeEqual(cookieState, state)) return {ok: false, reason: 'state_mismatch'};
   const record = await pending.take(state);
   if (!record) return {ok: false, reason: 'unknown_state'};

   let meta: OidcMetadata;
   try {
    meta = await discovery();
   } catch {
    return {ok: false, reason: 'metadata'};
   }

   let idToken: unknown;
   try {
    const res = await fetchImpl(meta.tokenEndpoint, {
     method: 'POST',
     headers: {'content-type': 'application/x-www-form-urlencoded', accept: 'application/json'},
     body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: record.codeVerifier,
     }),
     redirect: 'error',
     signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return {ok: false, reason: 'token_exchange'};
    const body = (await res.json()) as {id_token?: unknown};
    idToken = body.id_token;
   } catch {
    return {ok: false, reason: 'token_exchange'};
   }
   if (typeof idToken !== 'string') return {ok: false, reason: 'token_exchange'};

   const now = clock();
   const verified = await verifyIdToken(idToken, {
    issuer: config.issuer,
    audience: config.audience,
    clientId: config.clientId,
    nonce: record.nonce,
    getKey: jwksKeys,
    now,
   });
   if (verified.ok === false) return {ok: false, reason: verified.reason};

   // The company must come from a verified claim, never from email or the query string.
   const companyId = verified.claims[config.companyClaim];
   if (!isCompanyId(companyId)) return {ok: false, reason: 'company_claim'};

   return {
    ok: true,
    selection: {
     issuer: config.issuer,
     subject: verified.claims.sub as string,
     companyId,
     audience: 'supercharged',
     authority: 'central-verified',
     verifiedAt: new Date(now).toISOString(),
    },
   };
  },
 };
}

/** Host-only, HttpOnly, Secure, SameSite=Lax transaction cookie. No Domain attribute. */
export function txnCookieHeader(state: string): string {
 return `${TXN_COOKIE}=${state}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`;
}

export function clearTxnCookieHeader(): string {
 return `${TXN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/** Global logout target from config only. Central's logout parameters are not in the repo contract. */
export function globalLogoutUrl(config: CentralSsoConfig): string | null {
 return config.enabled && config.globalLogoutUrl ? config.globalLogoutUrl : null;
}
