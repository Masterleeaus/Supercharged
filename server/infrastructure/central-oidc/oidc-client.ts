/**
 * Desk sign-in initiation through Central's OIDC (issue #193).
 *
 * What this module does:
 * - Reads the discovery document from the configured Central origin (https only).
 * - Builds the authorization request: authorization code with PKCE (S256), state,
 *   nonce, and the per-app audience sent as the `resource` parameter.
 * - Holds the login transaction and the host-only binding cookie for the round trip.
 *
 * What this module does not do (owner decision 4):
 * - It does not exchange the authorization code and does not verify an ID token.
 *   Central completes the code exchange and hands Supercharged a verified result.
 *   No such handoff contract exists in this repository yet, so the callback half
 *   is not implemented here. See the PR body for the missing contract.
 * - It does not implement global logout. Sign-out is local only.
 *
 * All I/O goes through an injected fetch, so tests use fakes.
 */
import { isSecureEndpoint, type SignInConfig } from './config.ts';
import { createPkce, randomToken, type RandomBytes } from './pkce.ts';

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export const DESK_CALLBACK_PATH = '/auth/titan/desk/callback';
export const SIGN_IN_SCOPES = 'openid profile email';
export const LOGIN_TRANSACTION_TTL_MS = 600_000;
const NETWORK_TIMEOUT_MS = 4000;
const BINDING_COOKIE_NAME = 'titan_desk_oidc_binding';
const BINDING_COOKIE_MAX_AGE = 600;

export type OidcLoginErrorCode = 'discovery_invalid';

export class OidcLoginError extends Error {
  readonly code: OidcLoginErrorCode;
  constructor(code: OidcLoginErrorCode) {
    super(`central sign-in failed: ${code}`);
    this.name = 'OidcLoginError';
    this.code = code;
  }
}

export type Discovery = Readonly<{ issuer: string; authorizationEndpoint: string }>;

export type LoginTransaction = Readonly<{
  id: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  createdAtMs: number;
}>;

/** Reads the discovery document. The authorization endpoint must be https and support S256. */
export async function discover(
  centralOrigin: string,
  fetcher: Fetcher,
  insecureLocalhost = false,
): Promise<Discovery> {
  let doc: Record<string, unknown>;
  try {
    const response = await fetcher(`${centralOrigin}/.well-known/openid-configuration`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error('discovery status');
    doc = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new OidcLoginError('discovery_invalid');
  }
  const methods = doc.code_challenge_methods_supported;
  const endpoints = [doc.issuer, doc.authorization_endpoint];
  if (
    !endpoints.every((v) => typeof v === 'string' && isSecureEndpoint(v, insecureLocalhost)) ||
    !Array.isArray(methods) || !methods.includes('S256')
  ) {
    throw new OidcLoginError('discovery_invalid');
  }
  return Object.freeze({
    issuer: doc.issuer as string,
    authorizationEndpoint: doc.authorization_endpoint as string,
  });
}

/** Builds the authorization request and the server-side transaction that must survive the redirect. */
export function beginSignIn(input: {
  config: SignInConfig;
  discovery: Discovery;
  redirectUri: string;
  nowMs: number;
  random?: RandomBytes;
}): { url: string; transaction: LoginTransaction } {
  const { config, discovery, redirectUri, nowMs, random } = input;
  const redirect = new URL(redirectUri);
  if (redirect.pathname !== DESK_CALLBACK_PATH || redirect.search || redirect.hash || redirect.username) {
    throw new TypeError('redirect URI must be the registered desk callback');
  }
  const pkce = createPkce(random);
  const transaction: LoginTransaction = Object.freeze({
    id: randomToken(random),
    state: randomToken(random),
    nonce: randomToken(random),
    codeVerifier: pkce.codeVerifier,
    redirectUri,
    createdAtMs: nowMs,
  });
  const url = new URL(discovery.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', SIGN_IN_SCOPES);
  // Per-app audience, sent as `resource`. Central's docs do not name this parameter yet;
  // confirm on staging before enabling.
  url.searchParams.set('resource', config.audience);
  url.searchParams.set('state', transaction.state);
  url.searchParams.set('nonce', transaction.nonce);
  url.searchParams.set('code_challenge', pkce.codeChallenge);
  url.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);
  return { url: url.href, transaction };
}

/** True while the login transaction is inside its 10 minute window. */
export function isLoginTransactionLive(transaction: LoginTransaction, nowMs: number): boolean {
  return nowMs >= transaction.createdAtMs && nowMs - transaction.createdAtMs <= LOGIN_TRANSACTION_TTL_MS;
}

/** Host-only, Secure, HttpOnly, SameSite=Lax, Path=/. No Domain attribute. */
export function buildBindingCookie(transactionId: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(transactionId)) throw new TypeError('invalid transaction id');
  return `${BINDING_COOKIE_NAME}=${transactionId}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${BINDING_COOKIE_MAX_AGE}`;
}

export function buildClearBindingCookie(): string {
  return `${BINDING_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export const BINDING_COOKIE = BINDING_COOKIE_NAME;
