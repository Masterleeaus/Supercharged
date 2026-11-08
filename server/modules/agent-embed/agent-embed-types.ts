// Types for an embeddable workforce agent.
//
// An agent is embeddable only when it has a companyId, an explicit list of
// allowed origins, and at least one capability. Access to the embed surface is
// granted by a short-lived token minted per (agentId, companyId, origin); the
// host page never holds a provider key or a long-lived credential.

export const EMBED_CAPABILITIES = ['chat', 'booking', 'knowledge'] as const;

export type EmbedCapability = (typeof EMBED_CAPABILITIES)[number];

export type EmbedPosition = 'bottom-left' | 'bottom-right';

export interface EmbedTheme {
  /** Launcher colour, validated as #RRGGBB. */
  primaryColor: string;
  /** Launcher text/icon colour, validated as #RRGGBB when present. */
  textColor?: string;
  position: EmbedPosition;
}

export interface EmbeddableAgent {
  agentId: string;
  /** Required. Tokens are bound to this company; requests for another company are refused. */
  companyId: string;
  displayName: string;
  enabled: boolean;
  /** Explicit origins such as https://client.example. No wildcards. Empty means nothing can embed. */
  allowedOrigins: string[];
  capabilities: EmbedCapability[];
  theme: EmbedTheme;
}

/** Claims carried inside a signed embed token. */
export interface EmbedTokenClaims {
  v: 1;
  agentId: string;
  companyId: string;
  /** Normalised origin of the host page the token was minted for. */
  origin: string;
  capabilities: EmbedCapability[];
  /** Issued-at, seconds since epoch. */
  iat: number;
  /** Expiry, seconds since epoch. */
  exp: number;
  /** Random token id, for audit logs. */
  jti: string;
}

/** The access model this module implements. Documented here so routes can reference it. */
export interface EmbedAccessModel {
  tokenFormat: 'base64url(payload).base64url(hmac-sha256)';
  tokenTtlSeconds: number;
  maxTokenTtlSeconds: number;
  mintedBy: 'POST /embed/:agentId/session';
  mintRequiresOriginMatch: true;
  chatRequiresBearerToken: true;
  secretMinLength: number;
}

export const DEFAULT_THEME: EmbedTheme = {
  primaryColor: '#2563eb',
  position: 'bottom-right',
};

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const COMPANY_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_DISPLAY_NAME = 120;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export function isValidAgentId(value: unknown): value is string {
  return typeof value === 'string' && AGENT_ID_RE.test(value);
}

export function isValidCompanyId(value: unknown): value is string {
  return typeof value === 'string' && COMPANY_ID_RE.test(value);
}

export function isValidCapability(value: unknown): value is EmbedCapability {
  return typeof value === 'string' && (EMBED_CAPABILITIES as readonly string[]).includes(value);
}

/**
 * Checks the shape of an agent record before it is exposed to the embed layer.
 * It does not normalise origins; origin-policy.ts owns that.
 */
export function validateEmbeddableAgent(input: unknown): ValidationResult<EmbeddableAgent> {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['agent must be an object'] };
  }
  const a = input as Record<string, unknown>;

  if (!isValidAgentId(a.agentId)) errors.push('agentId is missing or malformed');
  if (!isValidCompanyId(a.companyId)) errors.push('companyId is required and must be a plain identifier');
  if (typeof a.displayName !== 'string' || a.displayName.trim() === '' || a.displayName.length > MAX_DISPLAY_NAME) {
    errors.push(`displayName must be 1-${MAX_DISPLAY_NAME} characters`);
  }
  if (typeof a.enabled !== 'boolean') errors.push('enabled must be a boolean');

  if (!Array.isArray(a.capabilities) || a.capabilities.length === 0) {
    errors.push('capabilities must be a non-empty array');
  } else if (!a.capabilities.every(isValidCapability)) {
    errors.push(`capabilities may only contain: ${EMBED_CAPABILITIES.join(', ')}`);
  }

  const theme = validateTheme(a.theme ?? DEFAULT_THEME);
  if (!theme.ok) errors.push(...theme.errors);

  if (errors.length > 0 || !theme.ok) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      agentId: a.agentId as string,
      companyId: a.companyId as string,
      displayName: (a.displayName as string).trim(),
      enabled: a.enabled as boolean,
      allowedOrigins: Array.isArray(a.allowedOrigins) ? (a.allowedOrigins as string[]) : [],
      capabilities: [...new Set(a.capabilities as EmbedCapability[])],
      theme: theme.value,
    },
  };
}

export function validateTheme(input: unknown): ValidationResult<EmbedTheme> {
  if (!input || typeof input !== 'object') return { ok: false, errors: ['theme must be an object'] };
  const t = input as Record<string, unknown>;
  const errors: string[] = [];
  if (typeof t.primaryColor !== 'string' || !HEX_COLOR_RE.test(t.primaryColor)) {
    errors.push('theme.primaryColor must be #RRGGBB');
  }
  if (t.textColor !== undefined && (typeof t.textColor !== 'string' || !HEX_COLOR_RE.test(t.textColor))) {
    errors.push('theme.textColor must be #RRGGBB when set');
  }
  if (t.position !== 'bottom-left' && t.position !== 'bottom-right') {
    errors.push('theme.position must be bottom-left or bottom-right');
  }
  if (errors.length > 0) return { ok: false, errors };
  const value: EmbedTheme = {
    primaryColor: t.primaryColor as string,
    position: t.position as EmbedPosition,
  };
  if (typeof t.textColor === 'string') value.textColor = t.textColor;
  return { ok: true, value };
}
