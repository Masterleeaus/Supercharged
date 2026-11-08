// Meta (Messenger and Instagram) webhook checks: subscription verification and X-Hub-Signature-256.
// Pure functions only: no network, no Meta API calls, no logging. Secrets and tokens are never
// placed in a returned value; reasons are fixed strings.

import { createHmac, timingSafeEqual } from 'node:crypto';

export type WebhookFailureReason = 'verification_failed' | 'not_configured';

export type SubscriptionResult =
  | { ok: true; challenge: string }
  | { ok: false; reason: WebhookFailureReason };

export type SignatureFailureReason =
  | 'missing_signature'
  | 'malformed_signature'
  | 'signature_mismatch'
  | 'not_configured';

export type SignatureResult = { ok: true } | { ok: false; reason: SignatureFailureReason };

export interface VerifySubscriptionInput {
  mode: unknown;
  token: unknown;
  challenge: unknown;
  expectedToken: unknown;
}

export interface VerifySignatureInput {
  rawBody: Buffer | string;
  signatureHeader: unknown;
  appSecret: unknown;
}

const SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;

// Constant-time equality. Unequal lengths are refused before timingSafeEqual is called,
// because timingSafeEqual throws on mismatched buffer lengths.
function safeEqualBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Answers Meta's GET verification handshake (hub.mode, hub.verify_token, hub.challenge).
 * On success the challenge is echoed back so the caller can return it as the response body.
 */
export function verifySubscription(input: VerifySubscriptionInput): SubscriptionResult {
  const { mode, token, challenge, expectedToken } = input;

  if (typeof expectedToken !== 'string' || expectedToken.length === 0) {
    return { ok: false, reason: 'not_configured' };
  }
  if (mode !== 'subscribe') {
    return { ok: false, reason: 'verification_failed' };
  }
  if (typeof token !== 'string' || typeof challenge !== 'string') {
    return { ok: false, reason: 'verification_failed' };
  }
  if (!safeEqualBytes(Buffer.from(token, 'utf8'), Buffer.from(expectedToken, 'utf8'))) {
    return { ok: false, reason: 'verification_failed' };
  }
  return { ok: true, challenge };
}

/**
 * Checks an X-Hub-Signature-256 header ('sha256=<hex>') against HMAC-SHA256 of the raw request body.
 * The raw body must be the exact bytes Meta sent, not re-serialised JSON.
 */
export function verifySignature(input: VerifySignatureInput): SignatureResult {
  const { rawBody, signatureHeader, appSecret } = input;

  if (typeof appSecret !== 'string' || appSecret.length === 0) {
    return { ok: false, reason: 'not_configured' };
  }
  if (signatureHeader === undefined || signatureHeader === null || signatureHeader === '') {
    return { ok: false, reason: 'missing_signature' };
  }
  if (typeof signatureHeader !== 'string') {
    return { ok: false, reason: 'malformed_signature' };
  }
  const match = SIGNATURE_PATTERN.exec(signatureHeader);
  if (!match) {
    return { ok: false, reason: 'malformed_signature' };
  }
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) {
    throw new TypeError('rawBody must be a Buffer or string');
  }

  const provided = Buffer.from(match[1], 'hex');
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  if (!safeEqualBytes(provided, expected)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}
