/**
 * Webhook checks for Instagram. Both fail closed:
 * - POST: X-Hub-Signature-256 must equal "sha256=" + HMAC-SHA256(app secret, exact raw body). A missing app secret
 *   rejects the request. The PHP extension skipped the check when no secret was set. That is not allowed here.
 * - GET: the subscription challenge is echoed only when the verify token matches. A missing expected token rejects.
 * Comparisons use timingSafeEqual over digests, so the length of a secret is not leaked either.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { RawWebhook, WebhookVerification } from "../../contracts/index.ts";

const SIGNATURE_HEADER = "x-hub-signature-256";
const SIGNATURE_PREFIX = "sha256=";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Constant-time equality for two strings. Both are hashed first, so unequal lengths compare safely. */
export function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b)) && a.length === b.length;
}

/** Computes the header value Meta sends for a raw body. Exported for tests and for the send-side fixtures. */
export function computeSignatureHeader(appSecret: string, rawBody: string): string {
  return SIGNATURE_PREFIX + createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
}

/** Checks the POST signature. Returns a verification result, never throws on bad input. */
export function verifySignedPost(
  raw: RawWebhook,
  appSecret: string | undefined | null,
): WebhookVerification {
  if (!appSecret) {
    return { ok: false, reason: "credentials_missing" };
  }
  const header = raw.headers[SIGNATURE_HEADER];
  if (!header) {
    return { ok: false, reason: "signature_missing" };
  }
  const expected = computeSignatureHeader(appSecret, raw.rawBody);
  if (!constantTimeEquals(header, expected)) {
    return { ok: false, reason: "signature_invalid" };
  }
  return { ok: true };
}

export type SubscriptionChallenge =
  | { ok: true; body: string }
  | { ok: false; status: 403 };

/**
 * Answers Meta's GET subscription handshake. Only "subscribe" mode with a matching verify token is answered.
 * An absent expected token refuses every request.
 */
export function answerSubscriptionChallenge(
  query: Readonly<Record<string, string | undefined>>,
  expectedVerifyToken: string | undefined | null,
): SubscriptionChallenge {
  if (!expectedVerifyToken) {
    return { ok: false, status: 403 };
  }
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];
  if (mode !== "subscribe" || typeof token !== "string" || typeof challenge !== "string") {
    return { ok: false, status: 403 };
  }
  if (!constantTimeEquals(token, expectedVerifyToken)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, body: challenge };
}
