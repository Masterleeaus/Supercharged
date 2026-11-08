// Short-lived embed tokens, signed with HMAC-SHA256 (node:crypto).
//
// Token format: base64url(JSON claims) + "." + base64url(HMAC-SHA256(claimsSegment)).
// The claims bind agentId, companyId, the normalised host origin, capabilities,
// issue and expiry times, and a random jti.
//
// The secret is passed in by the caller from configuration. These functions never
// log it and never echo it in error messages. A missing or short secret throws
// before any token is produced or checked.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EmbedCapability, EmbedTokenClaims } from './agent-embed-types.ts';
import { EMBED_CAPABILITIES, isValidAgentId, isValidCompanyId } from './agent-embed-types.ts';
import { normalizeOrigin } from './origin-policy.ts';

export const EMBED_SECRET_MIN_LENGTH = 32;
export const DEFAULT_EMBED_TOKEN_TTL_SECONDS = 300;
export const MAX_EMBED_TOKEN_TTL_SECONDS = 900;
/** Tolerance for a token issued slightly in the future because of clock drift. */
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 4096;

export interface IssueOptions {
  ttlSeconds?: number;
  /** Clock in milliseconds. Defaults to Date.now. Injected in tests. */
  now?: () => number;
}

export interface IssueInput {
  agentId: string;
  companyId: string;
  origin: string;
  capabilities: readonly EmbedCapability[];
}

export interface IssuedEmbedToken {
  token: string;
  claims: EmbedTokenClaims;
  expiresAt: string;
}

export interface VerifyExpectation {
  agentId: string;
  companyId: string;
  origin: string;
  /** Optional. When set, the token must grant this capability. */
  capability?: EmbedCapability;
}

export type VerifyFailure =
  | 'malformed'
  | 'bad_signature'
  | 'bad_claims'
  | 'not_yet_valid'
  | 'expired'
  | 'ttl_too_long'
  | 'wrong_agent'
  | 'wrong_company'
  | 'wrong_origin'
  | 'missing_capability';

export type VerifyResult =
  | { ok: true; claims: EmbedTokenClaims }
  | { ok: false; reason: VerifyFailure };

/**
 * Throws unless the secret is a string of at least EMBED_SECRET_MIN_LENGTH characters.
 * The error text names the requirement but never the value.
 */
export function assertEmbedSecret(secret: unknown): string {
  if (typeof secret !== 'string' || secret.length < EMBED_SECRET_MIN_LENGTH) {
    throw new Error(
      `agent-embed: token secret is missing or shorter than ${EMBED_SECRET_MIN_LENGTH} characters; refusing to run`,
    );
  }
  return secret;
}

/** Reads the secret from configuration. Returns undefined when unset. Never logs it. */
export function readEmbedSecret(env: Record<string, string | undefined> = process.env): string | undefined {
  const value = env.AGENT_EMBED_TOKEN_SECRET;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function issueEmbedToken(input: IssueInput, secret: unknown, options: IssueOptions = {}): IssuedEmbedToken {
  const key = assertEmbedSecret(secret);

  if (!isValidAgentId(input.agentId)) throw new Error('agent-embed: invalid agentId');
  if (!isValidCompanyId(input.companyId)) throw new Error('agent-embed: companyId is required');

  const origin = normalizeOrigin(input.origin);
  if (origin === null) throw new Error('agent-embed: origin must be an explicit https origin');

  const capabilities = uniqueCapabilities(input.capabilities);
  if (capabilities === null) throw new Error('agent-embed: capabilities must be a non-empty list of known capabilities');

  const ttl = options.ttlSeconds ?? DEFAULT_EMBED_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_EMBED_TOKEN_TTL_SECONDS) {
    throw new Error(`agent-embed: ttlSeconds must be an integer from 1 to ${MAX_EMBED_TOKEN_TTL_SECONDS}`);
  }

  const iat = Math.floor((options.now ?? Date.now)() / 1000);
  const claims: EmbedTokenClaims = {
    v: 1,
    agentId: input.agentId,
    companyId: input.companyId,
    origin,
    capabilities,
    iat,
    exp: iat + ttl,
    jti: randomBytes(16).toString('base64url'),
  };

  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = sign(payload, key);
  return {
    token: `${payload}.${signature}`,
    claims,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

/**
 * Checks signature first, then parses and checks claims. Returns a reason code rather
 * than throwing, so callers can log the reason without the token or secret.
 */
export function verifyEmbedToken(
  token: unknown,
  secret: unknown,
  expected: VerifyExpectation,
  options: IssueOptions = {},
): VerifyResult {
  const key = assertEmbedSecret(secret);

  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    return { ok: false, reason: 'malformed' };
  }
  const [payload, signature] = parts;

  const expectedSig = Buffer.from(sign(payload, key), 'utf8');
  const givenSig = Buffer.from(signature, 'utf8');
  if (expectedSig.length !== givenSig.length || !timingSafeEqual(expectedSig, givenSig)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'bad_claims' };
  }
  if (!isClaimsShape(claims)) return { ok: false, reason: 'bad_claims' };

  const now = Math.floor((options.now ?? Date.now)() / 1000);
  if (claims.iat > now + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'not_yet_valid' };
  if (claims.exp <= now) return { ok: false, reason: 'expired' };
  if (claims.exp - claims.iat > MAX_EMBED_TOKEN_TTL_SECONDS) return { ok: false, reason: 'ttl_too_long' };

  if (claims.agentId !== expected.agentId) return { ok: false, reason: 'wrong_agent' };
  if (claims.companyId !== expected.companyId) return { ok: false, reason: 'wrong_company' };

  const expectedOrigin = normalizeOrigin(expected.origin);
  if (expectedOrigin === null || claims.origin !== expectedOrigin) {
    return { ok: false, reason: 'wrong_origin' };
  }
  if (expected.capability !== undefined && !claims.capabilities.includes(expected.capability)) {
    return { ok: false, reason: 'missing_capability' };
  }

  return { ok: true, claims };
}

function sign(payloadSegment: string, key: string): string {
  return createHmac('sha256', key).update(payloadSegment, 'utf8').digest('base64url');
}

function uniqueCapabilities(list: readonly unknown[]): EmbedCapability[] | null {
  if (!Array.isArray(list) || list.length === 0) return null;
  const known = new Set<string>(EMBED_CAPABILITIES);
  const out: EmbedCapability[] = [];
  for (const item of list) {
    if (typeof item !== 'string' || !known.has(item)) return null;
    if (!out.includes(item as EmbedCapability)) out.push(item as EmbedCapability);
  }
  return out;
}

function isClaimsShape(value: unknown): value is EmbedTokenClaims {
  if (!value || typeof value !== 'object') return false;
  const c = value as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.agentId === 'string' &&
    typeof c.companyId === 'string' &&
    typeof c.origin === 'string' &&
    Array.isArray(c.capabilities) &&
    c.capabilities.every((x) => typeof x === 'string') &&
    Number.isInteger(c.iat) &&
    Number.isInteger(c.exp) &&
    typeof c.jti === 'string'
  );
}
