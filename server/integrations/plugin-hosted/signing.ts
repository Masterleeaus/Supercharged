/**
 * tzfd-ai/1 signing. Mirrors TZFD_AI_Connector::sign() in the Scheduling & Enquiries Manager
 * plugin: HMAC-SHA256 over "<timestamp>.<nonce>.<body>", formatted as "sha256=<hex>".
 * The body is hashed as raw bytes, so the exact bytes received are the ones verified.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const CONTRACT = 'tzfd-ai/1';
export const SIGNATURE_WINDOW_SECONDS = 300;
export const MAX_REQUEST_BYTES = 16384;
export const MAX_RESPONSE_BYTES = 65536;

export type BodyBytes = string | Uint8Array;

export function signTzfd(secret: string, timestamp: string, nonce: string, body: BodyBytes): string {
  const mac = createHmac('sha256', secret);
  mac.update(`${timestamp}.${nonce}.`, 'utf8');
  mac.update(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
  return `sha256=${mac.digest('hex')}`;
}

/** Constant-time comparison of two header strings. Different lengths fail without comparing. */
export function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function verifyTzfdSignature(
  secret: string,
  timestamp: string,
  nonce: string,
  body: BodyBytes,
  presented: string,
): boolean {
  return constantTimeEquals(signTzfd(secret, timestamp, nonce, body), presented);
}
