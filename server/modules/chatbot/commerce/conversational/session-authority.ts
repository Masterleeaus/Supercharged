/**
 * Commerce session authority: a signed, short-lived token that binds a storefront shopper's session to one
 * chatbot and a fixed set of capabilities. Port of CommerceSessionAuthority.php (HMAC-SHA256, base64url) and the
 * checks in RequireCommerceSessionAuthority.php. Tokens are verified with a constant-time compare.
 */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CommerceError } from "./errors.ts";

export const SESSION_CAPABILITIES = [
  "catalogue:read", "cart:read", "cart:write", "inventory:read", "inventory:reserve", "shipping:read",
  "checkout:read", "checkout:prepare", "payment:read", "payment:prepare", "orders:read", "order:materialize",
  "returns:prepare", "context:read", "context:write", "support:read", "support:write", "marketplace:read",
] as const;
export type SessionCapability = (typeof SESSION_CAPABILITIES)[number];

export interface SessionClaims {
  v: 1;
  chatbot_id: number;
  chatbot_uuid: string;
  session_id: string;
  capabilities: string[];
  iat: number;
  exp: number;
  jti: string;
  origin?: string;
  customer_id?: number;
}

const MIN_SECRET_LENGTH = 32;

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new CommerceError("validation", "Commerce session authority secret is not configured.");
  }
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(body: string, secret: string): string {
  return b64url(createHmac("sha256", secret).update(body).digest());
}

/** Issues a token. ttlSeconds is clamped to 60..86400. The jti is random per token. */
export function issueSessionToken(
  claims: Omit<SessionClaims, "v" | "iat" | "exp" | "jti">,
  secret: string,
  options: { ttlSeconds?: number; nowSeconds?: number } = {},
): { token: string; expiresIn: number } {
  assertSecret(secret);
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.min(options.ttlSeconds ?? 1800, 86400));
  if (claims.chatbot_id <= 0 || claims.chatbot_uuid.trim() === "") {
    throw new CommerceError("validation", "Invalid chatbot authority claims.");
  }
  if (claims.session_id.length < 16 || claims.session_id.length > 191) {
    throw new CommerceError("validation", "Session identifiers must contain between 16 and 191 characters.");
  }
  if (claims.capabilities.length === 0) {
    throw new CommerceError("validation", "At least one session capability is required.");
  }
  const payload: SessionClaims = { ...claims, v: 1, iat: now, exp: now + ttl, jti: randomBytes(16).toString("hex") };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return { token: `${body}.${sign(body, secret)}`, expiresIn: ttl };
}

/** Verifies signature, expiry and issue time. Throws invalid_token with one generic message for every failure. */
export function verifySessionToken(token: string, secret: string, nowSeconds?: number): SessionClaims {
  assertSecret(secret);
  const invalid = () => new CommerceError("invalid_token", "The commerce session authority token is invalid or expired.");
  const parts = token.trim().split(".");
  if (parts.length !== 2) throw invalid();
  const [body, signature] = parts as [string, string];
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw invalid();

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const claims = decoded as SessionClaims;
  if (typeof claims !== "object" || claims === null || typeof claims.exp !== "number" || typeof claims.iat !== "number") {
    throw invalid();
  }
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (claims.exp < now) throw invalid();
  if (claims.iat > now + 60) throw invalid();
  return claims;
}

export function sessionAllows(claims: Pick<SessionClaims, "capabilities">, capability: string): boolean {
  return claims.capabilities.includes(capability);
}

export interface SessionRequest {
  chatbotId: number;
  chatbotUuid: string;
  sessionId: string;
  /** Host of the Origin or Referer header, lower-cased. Empty when absent. */
  origin: string;
  capability: string;
}

/** Port of the checks in RequireCommerceSessionAuthority::handle. Throws forbidden on any mismatch. */
export function assertSessionRequest(claims: SessionClaims, request: SessionRequest): void {
  const forbidden = (message: string) => new CommerceError("forbidden", message);
  if (claims.chatbot_id !== request.chatbotId || claims.chatbot_uuid !== request.chatbotUuid || claims.session_id !== request.sessionId) {
    throw forbidden("The commerce session authority does not cover this chatbot session.");
  }
  const claimOrigin = (claims.origin ?? "").toLowerCase();
  if (request.origin !== "" && claimOrigin !== "" && claimOrigin !== request.origin.toLowerCase()) {
    throw forbidden("The commerce session authority was issued for a different storefront origin.");
  }
  if (!sessionAllows(claims, request.capability)) {
    throw forbidden("The commerce session authority does not allow this action.");
  }
}

/** Port of RequireCommerceSessionAuthority::requiredCapability. Route names are matched by fragment, in order. */
export function requiredCapability(routeName: string, method: string): SessionCapability {
  const name = routeName.toLowerCase();
  const get = method.toUpperCase() === "GET";
  if (name.includes("support.")) return get ? "support:read" : "support:write";
  if (name.includes("orders.materialize")) return "order:materialize";
  if (name.includes("orders.returns")) return "returns:prepare";
  if (name.includes("orders.")) return "orders:read";
  if (name.includes("payments.") || name.includes("bnpl.")) return get ? "payment:read" : "payment:prepare";
  if (name.includes("checkout.")) return get ? "checkout:read" : "checkout:prepare";
  if (name.includes("marketplaces.")) return "marketplace:read";
  if (name.includes("inventory.")) return get ? "inventory:read" : "inventory:reserve";
  if (name.includes("shipping.")) return "shipping:read";
  if (name.includes("conversation.")) return get ? "context:read" : "context:write";
  if (name.includes("cart.")) return get ? "cart:read" : "cart:write";
  return get ? "catalogue:read" : "cart:write";
}

/** Fresh random session id that satisfies the 16 to 191 character rule. */
export function newSessionId(): string {
  return randomUUID();
}
