/**
 * Per-call stream tokens for live-call WebSocket upgrades.
 *
 * The server puts a short-lived token in each stream URL it hands to a provider
 * (Twilio <Stream>, Plivo <Stream>). The provider connects back with that URL, so the
 * token comes back on the upgrade request. The token is an HMAC over the call id
 * (and agent id, where the route uses one) and an expiry time. Only the server can
 * mint it, because the key is a server secret.
 *
 * Token format: base64url(payloadJson) + "." + base64url(HMAC-SHA256(key, payloadPart))
 * Key: HMAC-SHA256(STREAM_TOKEN_SECRET, KEY_LABEL). The label keeps this key separate
 * from any other use of the same secret. JWT_SECRET is deliberately NOT used.
 *
 * Fails closed: with no STREAM_TOKEN_SECRET, minting throws and verification refuses.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Query parameter name carrying the token, e.g. wss://host/api/plivo/stream/<uuid>?t=<token>. */
export const STREAM_TOKEN_PARAM = "t";

/** Environment variable holding the dedicated stream token secret. */
export const STREAM_TOKEN_SECRET_ENV = "STREAM_TOKEN_SECRET";

/** Token lifetime. Providers open the socket right after the answer XML, so this is generous. */
export const STREAM_TOKEN_TTL_SECONDS = 120;

const KEY_LABEL = "titan:call-stream-token:v1";

export interface StreamTokenBinding {
  /** Call identifier the stream belongs to (Twilio CallSid, Plivo CallUUID, or internal call id). */
  callId: string;
  /** Agent id, when the route binds one (Twilio + ElevenLabs path). Omit otherwise. */
  agentId?: string;
}

export type StreamTokenRefusal =
  | "no_secret"
  | "missing"
  | "malformed"
  | "bad_signature"
  | "bad_payload"
  | "expired"
  | "wrong_call"
  | "wrong_agent";

export type StreamTokenResult = { ok: true } | { ok: false; reason: StreamTokenRefusal };

type OpenedToken =
  | { ok: true; callId: string; agentId?: string }
  | { ok: false; reason: StreamTokenRefusal };

function deriveKey(): Buffer | null {
  const secret = process.env[STREAM_TOKEN_SECRET_ENV];
  if (!secret) return null;
  return createHmac("sha256", secret).update(KEY_LABEL, "utf8").digest();
}

function sign(payloadPart: string, key: Buffer): string {
  return createHmac("sha256", key).update(payloadPart, "utf8").digest("base64url");
}

/**
 * Check the signature, payload shape and expiry of a token, without yet checking which call it
 * belongs to. Shared by the upgrade-time check and the full binding check.
 */
function openToken(token: string | null | undefined, nowSeconds: number): OpenedToken {
  const key = deriveKey();
  if (!key) return { ok: false, reason: "no_secret" };
  if (!token) return { ok: false, reason: "missing" };

  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payloadPart, signaturePart] = parts;

  const givenSig = Buffer.from(signaturePart, "base64url");
  const expectedSig = Buffer.from(sign(payloadPart, key), "base64url");
  if (givenSig.length !== expectedSig.length || !timingSafeEqual(givenSig, expectedSig)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: { cid?: unknown; aid?: unknown; exp?: unknown };
  try {
    claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  if (typeof claims.cid !== "string" || typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    return { ok: false, reason: "bad_payload" };
  }
  if (claims.aid !== undefined && typeof claims.aid !== "string") {
    return { ok: false, reason: "bad_payload" };
  }

  if (nowSeconds >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, callId: claims.cid, agentId: claims.aid as string | undefined };
}

/**
 * Mint a token bound to a call (and agent). Throws when the server secret is not configured,
 * so a stream URL is never produced without a token.
 */
export function mintStreamToken(binding: StreamTokenBinding, nowSeconds: number = Date.now() / 1000): string {
  const key = deriveKey();
  if (!key) {
    throw new Error(`${STREAM_TOKEN_SECRET_ENV} is not configured; refusing to mint a call stream token`);
  }
  const claims: { cid: string; aid?: string; exp: number } = {
    cid: binding.callId,
    exp: Math.floor(nowSeconds) + STREAM_TOKEN_TTL_SECONDS,
  };
  if (binding.agentId !== undefined) claims.aid = binding.agentId;
  const payloadPart = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${payloadPart}.${sign(payloadPart, key)}`;
}

/** Append the token to a stream URL as the STREAM_TOKEN_PARAM query parameter. */
export function withStreamToken(url: string, binding: StreamTokenBinding): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${STREAM_TOKEN_PARAM}=${encodeURIComponent(mintStreamToken(binding))}`;
}

/** Read the token from an upgrade request URL (path plus query). Returns null when absent. */
export function streamTokenFromUrl(requestUrl: string | undefined): string | null {
  if (!requestUrl) return null;
  const queryStart = requestUrl.indexOf("?");
  if (queryStart < 0) return null;
  return new URLSearchParams(requestUrl.slice(queryStart + 1)).get(STREAM_TOKEN_PARAM);
}

/**
 * Upgrade-time check for routes that learn the call id only later (Twilio: from the 'start'
 * event). Refuses before the WebSocket handshake when the token is missing, forged or expired.
 * It does not confirm which call the token is for; the caller must still run verifyStreamToken
 * with the call id once known.
 */
export function checkStreamTokenAtUpgrade(
  token: string | null | undefined,
  nowSeconds: number = Date.now() / 1000,
): StreamTokenResult {
  const opened = openToken(token, nowSeconds);
  return opened.ok === false ? { ok: false, reason: opened.reason } : { ok: true };
}

/**
 * Verify a token for an upgrade that is expected to belong to `expected`.
 * Checks, in order: secret configured, token present, signature (constant time),
 * payload shape, expiry, call id match, and agent id match.
 */
export function verifyStreamToken(
  token: string | null | undefined,
  expected: StreamTokenBinding,
  nowSeconds: number = Date.now() / 1000,
): StreamTokenResult {
  const opened = openToken(token, nowSeconds);
  if (opened.ok === false) return { ok: false, reason: opened.reason };
  if (opened.callId !== expected.callId) return { ok: false, reason: "wrong_call" };
  if (opened.agentId !== expected.agentId) return { ok: false, reason: "wrong_agent" };
  return { ok: true };
}

/** Strip the query string so a stream URL can be logged without its token. */
export function redactStreamToken(text: string): string {
  return text.replace(new RegExp(`([?&]${STREAM_TOKEN_PARAM}=)[^"&<\\s]+`, "g"), "$1[redacted]");
}
