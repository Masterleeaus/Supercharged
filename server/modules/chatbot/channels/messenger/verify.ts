/**
 * Messenger webhook verification.
 *
 * Two separate checks:
 *  1. Every POST: X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app_secret, raw body). Compared in constant time.
 *  2. The one-time GET subscription challenge: hub.mode=subscribe, hub.verify_token, hub.challenge.
 *
 * The legacy PHP read the query keys hub_verify_token and hub_challenge (underscores). Meta sends hub.verify_token
 * and hub.challenge (dots), so the PHP check never matched a real request. It also echoed the challenge without
 * checking hub.mode. This port checks the dotted keys and requires subscribe. The PHP verifyWebhook on the provider
 * returned true for every request. This port does not.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { constantTimeEqual } from "../framework.ts";
import type { ChannelCredentials, RawWebhook, WebhookVerification } from "../../contracts/index.ts";

export const MESSENGER_SIGNATURE_HEADER = "x-hub-signature-256";

export const MESSENGER_CREDENTIAL_KEYS = {
  pageAccessToken: "access_token",
  appSecret: "app_secret",
  verifyToken: "verify_token",
} as const;

/** Constant-time string comparison. Shared with every provider through the channel framework. */
export const constantTimeEqualString = constantTimeEqual;

/** Checks X-Hub-Signature-256 against the app secret over the exact raw body. Fails closed. */
export function verifyMessengerSignature(raw: RawWebhook, credentials: ChannelCredentials): WebhookVerification {
  const secret = credentials[MESSENGER_CREDENTIAL_KEYS.appSecret];
  if (typeof secret !== "string" || secret.length === 0) {
    return { ok: false, reason: "credentials_missing" };
  }
  const header = raw.headers[MESSENGER_SIGNATURE_HEADER];
  if (typeof header !== "string" || header.length === 0) {
    return { ok: false, reason: "signature_missing" };
  }
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) {
    return { ok: false, reason: "signature_invalid" };
  }
  const expected = createHmac("sha256", secret).update(raw.rawBody, "utf8").digest();
  const provided = Buffer.from(match[1] as string, "hex");
  return timingSafeEqual(expected, provided) ? { ok: true } : { ok: false, reason: "signature_invalid" };
}

export interface ChallengeResponse {
  status: 200;
  contentType: "text/plain; charset=utf-8";
  body: string;
}

/**
 * Answers the subscription challenge. Returns the challenge text only when hub.mode is "subscribe" and the token
 * matches the account's verify_token. Returns null in every other case, and the route layer must then answer 403.
 */
export function answerMessengerChallenge(
  query: Readonly<Record<string, string | undefined>>,
  credentials: ChannelCredentials,
): ChallengeResponse | null {
  const expected = credentials[MESSENGER_CREDENTIAL_KEYS.verifyToken];
  if (typeof expected !== "string" || expected.length === 0) return null;
  if (query["hub.mode"] !== "subscribe") return null;
  const token = query["hub.verify_token"];
  if (typeof token !== "string" || !constantTimeEqualString(token, expected)) return null;
  const challenge = query["hub.challenge"];
  if (typeof challenge !== "string" || challenge.length === 0 || challenge.length > 512) return null;
  return { status: 200, contentType: "text/plain; charset=utf-8", body: challenge };
}
