/**
 * Instagram sign-in through OAuth only. There is no password flow.
 * - startInstagramOAuth stores a hash of a random state with a short expiry and returns the authorise URL.
 * - completeInstagramOAuth consumes that state exactly once. A missing, unknown, expired or reused state is refused
 *   before any code is exchanged. The PHP callback had no state check at all.
 * - Token exchange and account lookup go through the injected HttpClient. Tokens go to the sealed store only.
 * - refreshInstagramAccountToken exchanges the stored long-lived token again, through the same client.
 * Every failure returns a reason code. No Meta response body and no token is put in a result.
 */
import { createHash, randomBytes } from "node:crypto";
import { requireCompanyId } from "../../chatbot-scope.ts";
import type { ChannelCredentials, HttpClient, SecretBox } from "../../contracts/index.ts";
import {
  INSTAGRAM_API_VERSION,
  INSTAGRAM_DIALOG_HOST,
  INSTAGRAM_GRAPH_HOST,
  INSTAGRAM_SCOPES,
  OAUTH_STATE_TTL_MS,
} from "./config.ts";
import { graphRequest } from "./http.ts";
import {
  type InstagramAccountStorage,
  normaliseCredentials,
  openCredentials,
  publicAccountView,
  sealCredentials,
} from "./accounts.ts";

export interface InstagramAppSettings {
  appId: string;
  appSecret: string;
  verifyToken: string;
  redirectUri: string;
}

export interface OAuthStateStorage {
  /** Stores a state hash. Returns false if the hash already exists for this company. */
  insert(companyId: string, stateHash: string, expiresAt: Date): Promise<boolean>;
  /** Deletes the hash if it exists and has not expired. Returns true only for the one caller that deleted it. */
  consume(companyId: string, stateHash: string, now: Date): Promise<boolean>;
}

export interface InstagramOAuthDeps {
  accounts: InstagramAccountStorage;
  states: OAuthStateStorage;
  box: SecretBox;
  http: HttpClient;
  now: () => Date;
  /** Random bytes source. Injected so tests are deterministic. */
  randomBytes?: (size: number) => Uint8Array;
}

export type InstagramOAuthFailure =
  | "app_not_configured"
  | "state_mismatch"
  | "code_missing"
  | "exchange_failed"
  | "account_not_found"
  | "lookup_failed"
  | "account_not_connected";

export type InstagramOAuthResult =
  | { ok: true; account: ReturnType<typeof publicAccountView> }
  | { ok: false; reason: InstagramOAuthFailure };

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export function buildAuthorizeUrl(app: InstagramAppSettings, state: string): string {
  const params = new URLSearchParams({
    client_id: app.appId,
    redirect_uri: app.redirectUri,
    response_type: "code",
    scope: INSTAGRAM_SCOPES.join(","),
    state,
  });
  return `${INSTAGRAM_DIALOG_HOST}/${INSTAGRAM_API_VERSION}/dialog/oauth?${params.toString()}`;
}

function isConfigured(app: InstagramAppSettings): boolean {
  return app.appId.length > 0 && app.appSecret.length > 0 && app.redirectUri.length > 0;
}

function newState(random: (size: number) => Uint8Array): string {
  return Buffer.from(random(32)).toString("base64url");
}

/** Creates a single-use state and returns the URL the user is sent to. */
export async function startInstagramOAuth(
  deps: InstagramOAuthDeps,
  companyId: string,
  app: InstagramAppSettings,
): Promise<{ ok: true; authorizeUrl: string; expiresAt: Date } | { ok: false; reason: "app_not_configured" }> {
  requireCompanyId(companyId);
  if (!isConfigured(app)) return { ok: false, reason: "app_not_configured" };

  const random = deps.randomBytes ?? ((size: number) => randomBytes(size));
  const state = newState(random);
  const expiresAt = new Date(deps.now().getTime() + OAUTH_STATE_TTL_MS);
  const stored = await deps.states.insert(companyId, hashOAuthState(state), expiresAt);
  if (!stored) throw new Error("OAuth state collision; retry the request");
  return { ok: true, authorizeUrl: buildAuthorizeUrl(app, state), expiresAt };
}

interface TokenResponse {
  accessToken: string;
  expiresInSeconds: number | null;
}

function readToken(json: Record<string, unknown>): TokenResponse | null {
  const accessToken = typeof json.access_token === "string" && json.access_token.length > 0 ? json.access_token : null;
  if (!accessToken) return null;
  const expiresInSeconds = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : null;
  return { accessToken, expiresInSeconds };
}

/** Exchanges a short-lived user token for a long-lived one. Used at sign-in and by the refresh job. */
async function exchangeLongLived(
  http: HttpClient,
  app: { appId: string; appSecret: string },
  token: string,
): Promise<TokenResponse | null> {
  const result = await graphRequest(http, {
    method: "POST",
    url: `${INSTAGRAM_GRAPH_HOST}/${INSTAGRAM_API_VERSION}/oauth/access_token`,
    form: {
      client_id: app.appId,
      client_secret: app.appSecret,
      grant_type: "fb_exchange_token",
      fb_exchange_token: token,
    },
  });
  return result.ok ? readToken(result.json) : null;
}

/**
 * Finishes sign-in. Consumes the state first, then exchanges the code, then finds the first page with a connected
 * Instagram account. The stored access token is the page token, because Instagram messaging is called with it.
 */
export async function completeInstagramOAuth(
  deps: InstagramOAuthDeps,
  companyId: string,
  app: InstagramAppSettings,
  input: { code: string | undefined; state: string | undefined },
): Promise<InstagramOAuthResult> {
  requireCompanyId(companyId);
  if (!isConfigured(app)) return { ok: false, reason: "app_not_configured" };

  if (typeof input.state !== "string" || input.state.length === 0) {
    return { ok: false, reason: "state_mismatch" };
  }
  const consumed = await deps.states.consume(companyId, hashOAuthState(input.state), deps.now());
  if (!consumed) return { ok: false, reason: "state_mismatch" };

  if (typeof input.code !== "string" || input.code.length === 0) {
    return { ok: false, reason: "code_missing" };
  }

  const short = await graphRequest(deps.http, {
    method: "POST",
    url: `${INSTAGRAM_GRAPH_HOST}/${INSTAGRAM_API_VERSION}/oauth/access_token`,
    form: {
      client_id: app.appId,
      client_secret: app.appSecret,
      redirect_uri: app.redirectUri,
      code: input.code,
    },
  });
  const shortToken = short.ok ? readToken(short.json) : null;
  if (!shortToken) return { ok: false, reason: "exchange_failed" };

  const long = await exchangeLongLived(deps.http, app, shortToken.accessToken);
  if (!long) return { ok: false, reason: "exchange_failed" };

  const pages = await graphRequest(deps.http, {
    method: "GET",
    url: `${INSTAGRAM_GRAPH_HOST}/${INSTAGRAM_API_VERSION}/me/accounts?fields=${encodeURIComponent("connected_instagram_account,name,access_token")}`,
    bearer: long.accessToken,
  });
  if (!pages.ok) return { ok: false, reason: "lookup_failed" };

  const data = Array.isArray(pages.json.data) ? pages.json.data : [];
  const page = data.find((item): item is Record<string, unknown> => {
    if (item === null || typeof item !== "object") return false;
    const linked = (item as { connected_instagram_account?: { id?: unknown } }).connected_instagram_account;
    return typeof linked?.id === "string" && linked.id.length > 0;
  });
  if (!page) return { ok: false, reason: "account_not_found" };

  const igId = (page.connected_instagram_account as { id: string }).id;
  const pageToken = typeof page.access_token === "string" ? page.access_token : "";
  if (!pageToken) return { ok: false, reason: "account_not_found" };

  const profile = await graphRequest(deps.http, {
    method: "GET",
    url: `${INSTAGRAM_GRAPH_HOST}/${INSTAGRAM_API_VERSION}/${encodeURIComponent(igId)}?fields=${encodeURIComponent("id,name,username,profile_picture_url")}`,
    bearer: pageToken,
  });
  if (!profile.ok) return { ok: false, reason: "lookup_failed" };

  const now = deps.now();
  const credentials = normaliseCredentials({
    app_id: app.appId,
    page_id: typeof page.id === "string" ? page.id : "",
    page_name: typeof page.name === "string" ? page.name : "",
    instagram_id: igId,
    username: profile.json.username,
    name: profile.json.name,
    picture: profile.json.profile_picture_url,
    access_token: pageToken,
    app_secret: app.appSecret,
    verify_token: app.verifyToken,
    token_expires_at: long.expiresInSeconds !== null ? new Date(now.getTime() + long.expiresInSeconds * 1000).toISOString() : "",
  });
  await persistAccount(deps, companyId, igId, credentials, now);
  return { ok: true, account: publicAccountView(credentials) };
}

async function persistAccount(
  deps: InstagramOAuthDeps,
  companyId: string,
  igId: string,
  credentials: ChannelCredentials,
  now: Date,
): Promise<void> {
  const sealed = await sealCredentials(deps.box, companyId, credentials);
  const expiry = credentials.token_expires_at ? new Date(credentials.token_expires_at) : null;
  await deps.accounts.upsert(companyId, {
    companyId,
    id: igId,
    pageId: credentials.page_id ?? "",
    username: credentials.username ?? null,
    sealedCredentials: sealed,
    tokenExpiresAt: expiry,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Re-exchanges the stored long-lived token for a new one and re-seals the credentials.
 * Returns only the new expiry, never the token.
 */
export async function refreshInstagramAccountToken(
  deps: InstagramOAuthDeps,
  companyId: string,
  accountId: string,
): Promise<{ ok: true; tokenExpiresAt: Date | null } | { ok: false; reason: "account_not_connected" | "exchange_failed" }> {
  requireCompanyId(companyId);
  const record = await deps.accounts.get(companyId, accountId);
  if (!record) return { ok: false, reason: "account_not_connected" };
  const current = await openCredentials(deps.box, companyId, record.sealedCredentials);
  if (!current || !current.access_token || !current.app_id || !current.app_secret) {
    return { ok: false, reason: "account_not_connected" };
  }

  const refreshed = await exchangeLongLived(deps.http, { appId: current.app_id, appSecret: current.app_secret }, current.access_token);
  if (!refreshed) return { ok: false, reason: "exchange_failed" };

  const now = deps.now();
  const next = normaliseCredentials({
    ...current,
    access_token: refreshed.accessToken,
    token_expires_at:
      refreshed.expiresInSeconds !== null ? new Date(now.getTime() + refreshed.expiresInSeconds * 1000).toISOString() : "",
  });
  await persistAccount(deps, companyId, accountId, next, now);
  const expiry = next.token_expires_at ? new Date(next.token_expires_at) : null;
  return { ok: true, tokenExpiresAt: expiry };
}
