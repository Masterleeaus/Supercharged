/**
 * Embed tokens for the public widget. Implements EmbedTokenIssuer and EmbedTokenVerifier from the contracts.
 *
 * Format: "v1.<base64url(JSON claims)>.<base64url(HMAC-SHA256)>". The signing key is per company and comes from
 * the injected KeySource (it is unsealed through SecretBox by the caller). The key is never logged or returned.
 *
 * Fails closed:
 * - No key for the company: the token is refused as signature_invalid.
 * - No trusted domains for the chatbot: the origin is refused as origin_mismatch.
 * - The check uses the request's Origin header, and the claims must name the same origin.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  EmbedTokenClaims,
  EmbedTokenIssuer,
  EmbedTokenVerification,
  EmbedTokenVerifier,
} from "../contracts/index.ts";
import { isTrustedOrigin, normaliseOrigin } from "./origin.ts";

export const EMBED_TOKEN_VERSION = "v1";
/** Longest lifetime an issued token may have. The widget asks for less. */
export const EMBED_TOKEN_MAX_TTL_SECONDS = 3600;

export interface EmbedKeySource {
  /** Returns the current signing key for a company, or null when none exists or it cannot be opened. */
  signingKeyFor(companyId: string): Promise<string | null>;
}

export interface EmbedTrustSource {
  /** Returns the trusted domains for a chatbot inside a company, or null when the chatbot is absent. */
  trustedDomainsFor(companyId: string, chatbotPublicId: string): Promise<readonly string[] | null>;
}

export interface EmbedTokenDeps {
  keys: EmbedKeySource;
  trust: EmbedTrustSource;
}

export class EmbedTokenIssueError extends Error {
  readonly code: "invalid_ttl" | "origin_not_trusted" | "signing_key_missing" | "invalid_claims";
  constructor(code: EmbedTokenIssueError["code"], message: string) {
    super(message);
    this.name = "EmbedTokenIssueError";
    this.code = code;
  }
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VISITOR_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const SCOPES = ["chat", "history", "voice"] as const;

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");

function sign(key: string, signingInput: string): Buffer {
  return createHmac("sha256", key).update(signingInput).digest();
}

/** Reads claims from parsed JSON. Returns null for any shape problem. */
function parseClaims(value: unknown): EmbedTokenClaims | null {
  if (typeof value !== "object" || value === null) return null;
  const c = value as Record<string, unknown>;
  if (c.v !== 1) return null;
  if (typeof c.companyId !== "string" || !ID_PATTERN.test(c.companyId)) return null;
  if (typeof c.chatbotPublicId !== "string" || !ID_PATTERN.test(c.chatbotPublicId)) return null;
  if (typeof c.visitorId !== "string" || !VISITOR_PATTERN.test(c.visitorId)) return null;
  if (typeof c.origin !== "string") return null;
  if (!Array.isArray(c.scope) || c.scope.length === 0 || !c.scope.every((s) => (SCOPES as readonly unknown[]).includes(s))) return null;
  if (!Number.isInteger(c.issuedAt) || !Number.isInteger(c.expiresAt)) return null;
  return {
    v: 1,
    companyId: c.companyId,
    chatbotPublicId: c.chatbotPublicId,
    visitorId: c.visitorId,
    origin: c.origin,
    scope: c.scope as EmbedTokenClaims["scope"],
    issuedAt: c.issuedAt as number,
    expiresAt: c.expiresAt as number,
  };
}

export function createEmbedTokenIssuer(deps: EmbedTokenDeps, now: () => Date = () => new Date()): EmbedTokenIssuer {
  return {
    async issue(input, ttlSeconds) {
      if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > EMBED_TOKEN_MAX_TTL_SECONDS) {
        throw new EmbedTokenIssueError("invalid_ttl", "ttl out of range");
      }
      const origin = normaliseOrigin(input.origin);
      if (origin === null || !ID_PATTERN.test(input.companyId) || !ID_PATTERN.test(input.chatbotPublicId)) {
        throw new EmbedTokenIssueError("invalid_claims", "claims are not valid");
      }
      if (!VISITOR_PATTERN.test(input.visitorId) || input.scope.length === 0) {
        throw new EmbedTokenIssueError("invalid_claims", "claims are not valid");
      }
      const domains = await deps.trust.trustedDomainsFor(input.companyId, input.chatbotPublicId);
      if (!domains || !isTrustedOrigin(origin, domains)) {
        throw new EmbedTokenIssueError("origin_not_trusted", "origin is not trusted for this chatbot");
      }
      const key = await deps.keys.signingKeyFor(input.companyId);
      if (!key) throw new EmbedTokenIssueError("signing_key_missing", "no signing key for this company");

      const issuedAt = Math.floor(now().getTime() / 1000);
      const claims: EmbedTokenClaims = {
        v: 1,
        companyId: input.companyId,
        chatbotPublicId: input.chatbotPublicId,
        visitorId: input.visitorId,
        origin,
        scope: [...input.scope],
        issuedAt,
        expiresAt: issuedAt + ttlSeconds,
      };
      const payload = b64url(JSON.stringify(claims));
      const signingInput = `${EMBED_TOKEN_VERSION}.${payload}`;
      return `${signingInput}.${b64url(sign(key, signingInput))}`;
    },
  };
}

export function createEmbedTokenVerifier(deps: EmbedTokenDeps): EmbedTokenVerifier {
  return {
    async verify(token, requestOrigin, requiredScope, nowSeconds): Promise<EmbedTokenVerification> {
      if (typeof token !== "string" || token.length > 4096) return { ok: false, reason: "malformed" };
      const parts = token.split(".");
      if (parts.length !== 3 || parts[0] !== EMBED_TOKEN_VERSION || parts[1] === "" || parts[2] === "") {
        return { ok: false, reason: "malformed" };
      }

      let claims: EmbedTokenClaims | null;
      try {
        claims = parseClaims(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
      } catch {
        claims = null;
      }
      if (claims === null) return { ok: false, reason: "malformed" };
      if (claims.expiresAt <= claims.issuedAt || claims.expiresAt - claims.issuedAt > EMBED_TOKEN_MAX_TTL_SECONDS) {
        return { ok: false, reason: "malformed" };
      }

      // Signature first. The company id comes from the unverified payload only to choose the key; a wrong
      // company id fails the signature check.
      const key = await deps.keys.signingKeyFor(claims.companyId);
      if (!key) return { ok: false, reason: "signature_invalid" };
      const expected = sign(key, `${parts[0]}.${parts[1]}`);
      const given = Buffer.from(parts[2], "base64url");
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return { ok: false, reason: "signature_invalid" };
      }

      if (nowSeconds >= claims.expiresAt) return { ok: false, reason: "expired" };
      if (!claims.scope.includes(requiredScope)) return { ok: false, reason: "scope_denied" };

      const origin = normaliseOrigin(requestOrigin);
      if (origin === null || origin !== normaliseOrigin(claims.origin)) return { ok: false, reason: "origin_mismatch" };
      const domains = await deps.trust.trustedDomainsFor(claims.companyId, claims.chatbotPublicId);
      if (!domains || !isTrustedOrigin(origin, domains)) return { ok: false, reason: "origin_mismatch" };

      return { ok: true, claims };
    },
  };
}
