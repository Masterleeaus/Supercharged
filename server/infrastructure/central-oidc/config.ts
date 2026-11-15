/**
 * Central sign-in and flag configuration. Every value comes from the environment.
 * Nothing here has a real default: an unset or malformed variable throws a
 * CentralConfigError that names the variable and never prints its value.
 *
 * Central origin and client-credentials values are read by central-link/config.ts
 * (CENTRAL_ORIGIN, CENTRAL_SERVICE_*). This module only adds the sign-in client and
 * the event route secret. Placeholder names only; the owner supplies the values in
 * the secret store. This module makes no network calls.
 */

export class CentralConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, reason: string) {
    super(`central config ${variable}: ${reason}`);
    this.name = 'CentralConfigError';
    this.variable = variable;
  }
}

export type Env = Readonly<Record<string, string | undefined>>;

export const ENV = Object.freeze({
  centralOrigin: 'CENTRAL_ORIGIN',
  deskAudience: 'TITAN_DESK_AUDIENCE',
  deskClientId: 'TITAN_DESK_OIDC_CLIENT_ID',
  deskClientSecret: 'TITAN_DESK_OIDC_CLIENT_SECRET',
  configEnvironment: 'TITAN_CONFIG_ENVIRONMENT',
  eventSecret: 'TITAN_CENTRAL_EVENT_SECRET',
  allowInsecureLocalhost: 'TITAN_ALLOW_INSECURE_LOCALHOST',
});

export const CONFIG_ENVIRONMENTS = Object.freeze(['development', 'staging', 'production'] as const);
export type ConfigEnvironment = (typeof CONFIG_ENVIRONMENTS)[number];

export function allowInsecureLocalhost(env: Env = process.env): boolean {
  return env[ENV.allowInsecureLocalhost] === '1';
}

function required(env: Env, variable: string): string {
  const value = env[variable];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CentralConfigError(variable, 'is not set');
  }
  return value.trim();
}

/** True when the URL is https, or http on localhost with the explicit dev switch. */
export function isSecureEndpoint(raw: string, insecureLocalhost: boolean): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash || url.search) return false;
  if (url.protocol === 'https:') return true;
  return insecureLocalhost && url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/** An origin: scheme, host and optional port. No path other than "/", no query or credentials. */
export function readOrigin(env: Env, variable: string): string {
  const raw = required(env, variable);
  if (!isSecureEndpoint(raw, allowInsecureLocalhost(env))) {
    throw new CentralConfigError(variable, 'must be an https origin');
  }
  const url = new URL(raw);
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new CentralConfigError(variable, 'must be an origin without a path');
  }
  return url.origin;
}

export type SignInConfig = Readonly<{
  centralOrigin: string;
  audience: string;
  clientId: string;
  clientSecret: string;
}>;

/** Desk sign-in through Central (issue #193). The audience is sent as `resource` on the authorize request. */
export function readSignInConfig(env: Env = process.env): SignInConfig {
  return Object.freeze({
    centralOrigin: readOrigin(env, ENV.centralOrigin),
    audience: required(env, ENV.deskAudience),
    clientId: required(env, ENV.deskClientId),
    clientSecret: required(env, ENV.deskClientSecret),
  });
}

export const CONFIG_ENVIRONMENT_RULE = 'must be development, staging or production';

/** The Central environment that flag reads address (issue #196). */
export function readConfigEnvironment(env: Env = process.env): ConfigEnvironment {
  const environment = required(env, ENV.configEnvironment);
  if (!(CONFIG_ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new CentralConfigError(ENV.configEnvironment, CONFIG_ENVIRONMENT_RULE);
  }
  return environment as ConfigEnvironment;
}

/** Route secret for signed outbox events. At least 32 characters (Central MIN_SECRET_LENGTH). */
export function readEventSecret(env: Env = process.env): string {
  const secret = required(env, ENV.eventSecret);
  if (secret.length < 32) throw new CentralConfigError(ENV.eventSecret, 'must be at least 32 characters');
  return secret;
}
