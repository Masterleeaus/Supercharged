/**
 * HMAC-SHA256 signing for bridge deliveries (#359). Used both ways: Zapier, Make or n8n signs the
 * inbound request, and TitanZero signs outbound event deliveries.
 *
 * Signed string: "<unix seconds>.<raw body>". The header carries the timestamp and the hex digest.
 * Verification checks the timestamp window (replay limit) before the constant-time digest compare.
 *
 * Pure: the clock is passed in. No network, database or environment access.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const MIN_SECRET_LENGTH = 32;

export function signatureFor(secret: string, timestampSeconds: number, rawBody: string): string {
  if (secret.length < MIN_SECRET_LENGTH) throw new RangeError('bridge secret is too short');
  return createHmac('sha256', secret).update(`${timestampSeconds}.${rawBody}`).digest('hex');
}

export type VerifyFailure = 'bad_timestamp' | 'stale_timestamp' | 'bad_signature';

export function verifyDelivery(input: {
  secret: string;
  rawBody: string;
  timestampHeader: string;
  signatureHeader: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): { ok: true } | { ok: false; reason: VerifyFailure } {
  const ts = input.timestampHeader;
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: 'bad_timestamp' };
  const timestamp = Number(ts);
  const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) return { ok: false, reason: 'stale_timestamp' };
  if (!SIGNATURE_PATTERN.test(input.signatureHeader)) return { ok: false, reason: 'bad_signature' };

  const expected = Buffer.from(signatureFor(input.secret, timestamp, input.rawBody), 'hex');
  const given = Buffer.from(input.signatureHeader, 'hex');
  return timingSafeEqual(expected, given) ? { ok: true } : { ok: false, reason: 'bad_signature' };
}
