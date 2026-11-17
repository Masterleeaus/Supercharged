/**
 * OAuth 2.0 connect flow for connectors that support it (#351): connect with PKCE (S256), callback,
 * automatic refresh before expiry, and revoke. Credentials are never in a URL: the authorize URL
 * carries only the state and the PKCE challenge, and the callback is answered with a connection
 * summary, never tokens.
 *
 * The HTTP poster and pending-state store are injected. Default HTTP lives in httpFormPoster.
 */
import { createHash, randomBytes } from 'node:crypto';
import { ConnectorError } from '../sdk/contract.ts';
import { CredentialVault, type StoredCredentials } from './credential-vault.ts';

export interface OAuthProviderConfig {
  connectorId: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  clientId: string;
  /** Read from the environment by the caller. Never sent in a URL and never logged. */
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface FormPostResult {
  status: number;
  body: unknown;
}

export interface FormPoster {
  postForm(url: string, form: Record<string, string>): Promise<FormPostResult>;
}

interface PendingConnect {
  companyId: string;
  connectorId: string;
  verifier: string;
  expiresAt: number;
}

export interface PendingStore {
  put(state: string, row: PendingConnect): Promise<void>;
  take(state: string): Promise<PendingConnect | null>;
}

export function createMemoryPendingStore(): PendingStore {
  const rows = new Map<string, PendingConnect>();
  return {
    async put(state, row) {
      rows.set(state, row);
    },
    async take(state) {
      const row = rows.get(state) ?? null;
      rows.delete(state);
      return row;
    },
  };
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const REFRESH_SKEW_MS = 60 * 1000;
const CODE_PATTERN = /^[\x21-\x7e]{1,2048}$/;

const base64url = (buf: Buffer) => buf.toString('base64url');

export interface OAuthFlowOptions {
  providers: Map<string, OAuthProviderConfig>;
  vault: CredentialVault;
  pending: PendingStore;
  poster: FormPoster;
  now?: () => number;
}

export function createOAuthFlow(options: OAuthFlowOptions) {
  const now = options.now ?? (() => Date.now());
  const inFlightRefresh = new Map<string, Promise<StoredCredentials>>();

  const provider = (connectorId: string): OAuthProviderConfig => {
    const found = options.providers.get(connectorId);
    if (!found) throw new ConnectorError('not_found', 'connector has no OAuth configuration');
    return found;
  };

  const tokenBody = (p: OAuthProviderConfig, extra: Record<string, string>) => ({
    client_id: p.clientId,
    client_secret: p.clientSecret,
    ...extra,
  });

  async function refresh(companyId: string, connectorId: string, current: Extract<StoredCredentials, { type: 'oauth2' }>): Promise<StoredCredentials> {
    const p = provider(connectorId);
    if (!current.refreshToken) throw new ConnectorError('auth', 'reconnect required');
    const res = await options.poster.postForm(p.tokenUrl, tokenBody(p, { grant_type: 'refresh_token', refresh_token: current.refreshToken }));
    if (res.status === 400 || res.status === 401) {
      await options.vault.remove(companyId, connectorId);
      throw new ConnectorError('auth', 'reconnect required');
    }
    if (res.status !== 200) throw new ConnectorError('upstream', 'token refresh failed', { status: res.status });
    const next = toCredentials(res.body, now(), current.refreshToken);
    await options.vault.save(companyId, connectorId, next);
    return next;
  }

  return {
    /** Starts a connect. The returned URL has no tokens or secrets in it. */
    async beginConnect(companyId: string, connectorId: string): Promise<{ url: string }> {
      const p = provider(connectorId);
      const state = base64url(randomBytes(32));
      const verifier = base64url(randomBytes(32));
      const challenge = base64url(createHash('sha256').update(verifier).digest());
      await options.pending.put(state, { companyId, connectorId, verifier, expiresAt: now() + PENDING_TTL_MS });
      const url = new URL(p.authorizeUrl);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: p.clientId,
        redirect_uri: p.redirectUri,
        scope: p.scopes.join(' '),
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      return { url: url.toString() };
    },

    /** Callback. The company comes from the server-side pending record, never from the request. */
    async completeConnect(state: string, code: string): Promise<{ companyId: string; connectorId: string; expiresAt: number | null }> {
      if (typeof state !== 'string' || typeof code !== 'string' || !CODE_PATTERN.test(code)) {
        throw new ConnectorError('validation', 'callback is missing a valid code or state');
      }
      const pending = await options.pending.take(state);
      if (!pending || pending.expiresAt <= now()) throw new ConnectorError('auth', 'connect request is unknown or expired');
      const p = provider(pending.connectorId);
      const res = await options.poster.postForm(
        p.tokenUrl,
        tokenBody(p, { grant_type: 'authorization_code', code, redirect_uri: p.redirectUri, code_verifier: pending.verifier }),
      );
      if (res.status !== 200) throw new ConnectorError('auth', 'token exchange was refused', { status: res.status });
      const creds = toCredentials(res.body, now(), undefined);
      await options.vault.save(pending.companyId, pending.connectorId, creds);
      return {
        companyId: pending.companyId,
        connectorId: pending.connectorId,
        expiresAt: creds.type === 'oauth2' && creds.expiresAt !== undefined ? creds.expiresAt : null,
      };
    },

    /** Returns usable credentials, refreshing an OAuth token that expires within the skew window. */
    async credentialsFor(companyId: string, connectorId: string): Promise<StoredCredentials> {
      const creds = await options.vault.load(companyId, connectorId);
      if (!creds) throw new ConnectorError('auth', 'connector is not connected');
      if (creds.type !== 'oauth2' || creds.expiresAt === undefined || creds.expiresAt - REFRESH_SKEW_MS > now()) return creds;
      const key = `${companyId}\u0000${connectorId}`;
      const existing = inFlightRefresh.get(key);
      if (existing) return existing;
      const job = refresh(companyId, connectorId, creds).finally(() => inFlightRefresh.delete(key));
      inFlightRefresh.set(key, job);
      return job;
    },

    /** Revokes at the provider when it supports that, then always removes the local copy. */
    async revoke(companyId: string, connectorId: string): Promise<{ removed: true; remoteRevoked: boolean }> {
      const p = provider(connectorId);
      const creds = await options.vault.load(companyId, connectorId);
      let remoteRevoked = false;
      if (creds && creds.type === 'oauth2' && p.revokeUrl) {
        try {
          const res = await options.poster.postForm(p.revokeUrl, tokenBody(p, { token: creds.accessToken }));
          remoteRevoked = res.status === 200;
        } catch {
          remoteRevoked = false;
        }
      }
      await options.vault.remove(companyId, connectorId);
      return { removed: true, remoteRevoked };
    },
  };
}

function toCredentials(body: unknown, at: number, keepRefresh: string | undefined): Extract<StoredCredentials, { type: 'oauth2' }> {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (typeof b.access_token !== 'string' || b.access_token.length === 0) {
    throw new ConnectorError('auth', 'token response had no access token');
  }
  const refreshToken = typeof b.refresh_token === 'string' && b.refresh_token.length > 0 ? b.refresh_token : keepRefresh;
  const expiresIn = typeof b.expires_in === 'number' && b.expires_in > 0 ? b.expires_in : undefined;
  return {
    type: 'oauth2',
    accessToken: b.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn !== undefined ? { expiresAt: at + expiresIn * 1000 } : {}),
    ...(typeof b.scope === 'string' ? { scope: b.scope } : {}),
    ...(typeof b.token_type === 'string' ? { tokenType: b.token_type } : {}),
  };
}

/** Default poster: form-encoded POST with a timeout. The response body is parsed, never echoed in errors. */
export const httpFormPoster: FormPoster = {
  async postForm(url, form) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  },
};
