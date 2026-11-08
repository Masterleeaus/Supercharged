/**
 * Webhook signature helpers.
 *
 * verifyWebhookSignature is a PLACEHOLDER and FAILS CLOSED: it returns valid = false for every
 * input until a provider replaces the body with a real check. Providers must:
 *   1. read their signature header (lower-case name) from input.headers,
 *   2. compute the HMAC over input.rawBody with the secret (hmacSha256Hex),
 *   3. compare with safeEqual, never with ===,
 *   4. reject timestamps outside the provider's replay window, if the provider sends one.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SignatureInput {
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
  secret: string | null;
}

export interface SignatureResult {
  valid: boolean;
  reason: string;
}

export function verifyWebhookSignature(input: SignatureInput): SignatureResult {
  if (!input.secret) {
    return { valid: false, reason: 'missing_secret' };
  }
  // Placeholder: no provider check is implemented yet, so nothing is accepted.
  return { valid: false, reason: 'signature_verification_not_implemented' };
}

export function hmacSha256Hex(secret: string, payload: Buffer | string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Constant-time string comparison. Unequal lengths return false without comparing bytes. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
