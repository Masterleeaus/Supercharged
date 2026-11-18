/**
 * Wire contract constants and signing helpers for the plugin connector, contract tzfd-ai/1.
 *
 * The human-readable contract is docs/PLUGIN_CONNECTOR_TZFD_AI_1.md. Any change to a value in
 * this file must change that document too; tests/integrations/plugin-hosted/contract.test.mjs
 * fails when the two disagree.
 *
 * Signing: HMAC-SHA256 over `<timestamp>.<nonce>.<body>`, keyed with the per-site secret.
 * The secret is never returned by any function here and never appears in an error message.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const TZFD_CONTRACT = 'tzfd-ai/1';
export const TZFD_CONSENT_VERSION = 'tzfd-ai-consent-1';

export const TZFD_HEADERS = Object.freeze({
  contract: 'x-tzfd-contract',
  site: 'x-tzfd-site',
  timestamp: 'x-tzfd-timestamp',
  nonce: 'x-tzfd-nonce',
  signature: 'x-tzfd-signature',
});

export const TZFD_LIMITS = Object.freeze({
  requestBodyBytes: 16 * 1024,
  responseBodyBytes: 64 * 1024,
  timestampSkewSeconds: 300,
  minSecretChars: 32,
});

export const TZFD_SITE_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
export const TZFD_NONCE_PATTERN = /^[0-9a-f]{32}$/;
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;

/** Body-level statuses the plugin accepts. Any other value is rejected by the plugin. */
export const TZFD_RESPONSE_STATUSES = Object.freeze([
  'ok',
  'allowance_exhausted',
  'service_error',
  'contract_unsupported',
] as const);
export type TzfdResponseStatus = (typeof TZFD_RESPONSE_STATUSES)[number];

/**
 * Feature allowlist. A feature not listed here is refused with contract_unsupported before any
 * handler runs. `scopes` are the consent scopes a site must have granted for the feature.
 */
export const TZFD_FEATURES: Readonly<Record<string, { readonly scopes: readonly string[] }>> = Object.freeze({
  'faq.answer': { scopes: ['faq.read'] },
  'faq.embed_query': { scopes: ['faq.read'] },
  'faq.suggest_batch': { scopes: ['faq.read'] },
  'insight.monthly': { scopes: ['reports.read'] },
  'assistant.turn': { scopes: ['faq.read', 'customer.read'] },
  'agent.run': { scopes: ['booking.read', 'booking.write', 'customer.read'] },
});

export function isTzfdFeature(name: unknown): name is keyof typeof TZFD_FEATURES {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(TZFD_FEATURES, name);
}

export function tzfdCanonical(timestamp: string, nonce: string, body: string): string {
  return `${timestamp}.${nonce}.${body}`;
}

/** Returns `sha256=<hex>` for the given timestamp, nonce and exact body bytes. */
export function tzfdSign(secret: string, timestamp: string, nonce: string, body: string): string {
  const digest = createHmac('sha256', secret).update(tzfdCanonical(timestamp, nonce, body), 'utf8').digest('hex');
  return `sha256=${digest}`;
}

/** Constant-time check. Returns false for any malformed header instead of throwing. */
export function tzfdVerify(
  secret: string,
  timestamp: string,
  nonce: string,
  body: string,
  signatureHeader: string | undefined,
): boolean {
  if (typeof signatureHeader !== 'string' || !SIGNATURE_PATTERN.test(signatureHeader)) return false;
  const expected = Buffer.from(tzfdSign(secret, timestamp, nonce, body), 'utf8');
  const given = Buffer.from(signatureHeader, 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function tzfdBodyBytes(body: string): number {
  return Buffer.byteLength(body, 'utf8');
}
