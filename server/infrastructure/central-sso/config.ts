/** Central sign-in and service configuration.
 * Read from environment variables only. Nothing is enabled unless
 * CENTRAL_SSO_ENABLED is exactly 'true'. Secrets are never logged or returned
 * in error messages.
 */

/** Audience for Supercharged's client-credentials service tokens (Central #194). */
export const CENTRAL_SERVICE_AUDIENCE = 'urn:titan-central:product:supercharged';

export type CentralSsoConfig =
 | {enabled: false}
 | {
   enabled: true;
   issuer: string;
   clientId: string;
   clientSecret: string;
   redirectUri: string;
   /** Supercharged's per-app audience (TITAN_DESK_AUDIENCE). Value comes from the Central operator. */
   audience: string;
   /** Name of the verified ID-token claim that carries the Supercharged company id. Required; no default. */
   companyClaim: string;
   serviceClientId?: string;
   serviceClientSecret?: string;
   apiBaseUrl?: string;
   globalLogoutUrl?: string;
 };

type Env = Record<string, string | undefined>;

export function isHttpsUrl(value: unknown): value is string {
 if (typeof value !== 'string' || value.length > 2048) return false;
 try {
  const u = new URL(value);
  return u.protocol === 'https:' && !u.username && !u.password && !u.hash;
 } catch {
  return false;
 }
}

function isLocalDevRedirect(value: string): boolean {
 try {
  const u = new URL(value);
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') && !u.hash;
 } catch {
  return false;
 }
}

function text(env: Env, name: string): string | undefined {
 const v = env[name];
 return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** Returns {enabled:false} unless the flag is on. Throws a config error (without values) when enabled but incomplete. */
export function loadCentralSsoConfig(env: Env = process.env): CentralSsoConfig {
 if (env.CENTRAL_SSO_ENABLED !== 'true') return {enabled: false};

 const issuer = text(env, 'CENTRAL_OIDC_ISSUER');
 const clientId = text(env, 'CENTRAL_OIDC_CLIENT_ID');
 const clientSecret = text(env, 'CENTRAL_OIDC_CLIENT_SECRET');
 const redirectUri = text(env, 'CENTRAL_OIDC_REDIRECT_URI');
 const audience = text(env, 'TITAN_DESK_AUDIENCE');
 const companyClaim = text(env, 'CENTRAL_COMPANY_CLAIM');
 const apiBaseUrl = text(env, 'CENTRAL_API_BASE_URL');
 const globalLogoutUrl = text(env, 'CENTRAL_GLOBAL_LOGOUT_URL');
 const serviceClientId = text(env, 'CENTRAL_SERVICE_CLIENT_ID');
 const serviceClientSecret = text(env, 'CENTRAL_SERVICE_CLIENT_SECRET');

 if (!isHttpsUrl(issuer)) throw new Error('central-sso: CENTRAL_OIDC_ISSUER must be an https URL');
 if (!clientId || !clientSecret) throw new Error('central-sso: OIDC client id and secret are required');
 if (!redirectUri || !(isHttpsUrl(redirectUri) || isLocalDevRedirect(redirectUri)))
  throw new Error('central-sso: CENTRAL_OIDC_REDIRECT_URI must be https (http allowed for localhost only)');
 if (!audience) throw new Error('central-sso: TITAN_DESK_AUDIENCE is required');
 if (!companyClaim) throw new Error('central-sso: CENTRAL_COMPANY_CLAIM is required; the company must come from a verified claim');
 if (apiBaseUrl !== undefined && !isHttpsUrl(apiBaseUrl)) throw new Error('central-sso: CENTRAL_API_BASE_URL must be https');
 if (globalLogoutUrl !== undefined && !isHttpsUrl(globalLogoutUrl)) throw new Error('central-sso: CENTRAL_GLOBAL_LOGOUT_URL must be https');
 if ((serviceClientId === undefined) !== (serviceClientSecret === undefined))
  throw new Error('central-sso: service client id and secret must be set together');

 return {
  enabled: true,
  issuer,
  clientId,
  clientSecret,
  redirectUri,
  audience,
  companyClaim,
  serviceClientId,
  serviceClientSecret,
  apiBaseUrl,
  globalLogoutUrl,
 };
}
