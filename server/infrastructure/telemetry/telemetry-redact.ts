/**
 * Redaction for telemetry attributes. This runs before any attribute is set on a span.
 *
 * Two layers:
 * 1. Keys: a key that names a personal or secret field (email, phone, name, message
 *    body, token, key, password...) is dropped, whatever its value.
 * 2. Allowlist: only the keys in TELEMETRY_ATTRIBUTE_KEYS can reach a span. Anything
 *    else is dropped, so a new field cannot leak by accident.
 *
 * Values that do pass are scrubbed: bearer tokens, sk_/pk_ keys and JWTs go through
 * redactForAudit; emails and phone-like digit runs are replaced with a placeholder.
 * Strings are length-capped. Ids are kept only when they look like ids.
 */

import { redactForAudit } from '../../workforce/runtime/redact.ts';

export type TelemetryAttributeValue = string | number | boolean;
export type TelemetryAttributes = Record<string, TelemetryAttributeValue>;

/** The only attribute keys that may reach a span or a usage receipt. */
export const TELEMETRY_ATTRIBUTE_KEYS = [
  'titan.company_id',
  'titan.agent_id',
  'titan.run_id',
  'titan.tool_id',
  'titan.status',
  'titan.error_code',
  'titan.duration_ms',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
] as const;

export type TelemetryAttributeKey = (typeof TELEMETRY_ATTRIBUTE_KEYS)[number];

const ALLOWED = new Set<string>(TELEMETRY_ATTRIBUTE_KEYS);

/** Key names that mark a personal or secret field. Matched case-insensitively, separators removed. */
const PERSONAL_OR_SECRET_KEY =
  /(email|mail|phone|mobile|tel|name|surname|address|message|body|content|text|prompt|transcript|password|passwd|secret|token|apikey|key|authorization|cookie|credential|session|otp|dob|birth|ssn|card)/;

const MAX_STRING_LENGTH = 128;
const ID_SHAPE = /^[A-Za-z0-9_.:-]{1,128}$/;
const CODE_SHAPE = /^[a-z0-9_.-]{1,64}$/;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?<!\d)\+?\d[\d\s().-]{6,}\d(?!\d)/g;

/** Our own token-count keys. They contain "token" but are counts, not secrets. */
const COUNT_KEYS = new Set<string>(['gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens']);

const isPersonalKey = (key: string): boolean =>
  !COUNT_KEYS.has(key) && PERSONAL_OR_SECRET_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));

/** Scrubs free text: tokens first (shared helper), then emails, then phone-like runs. */
export const scrubText = (text: string): string => {
  const tokensRemoved = redactForAudit(text);
  return tokensRemoved
    .replace(EMAIL, '[email]')
    .replace(PHONE, '[phone]')
    .slice(0, MAX_STRING_LENGTH);
};

const sanitizeValue = (key: TelemetryAttributeKey, value: unknown): TelemetryAttributeValue | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  // Ids: keep only if they are id-shaped after scrubbing; an email or phone is not an id.
  if (key === 'titan.company_id' || key === 'titan.agent_id' || key === 'titan.run_id' || key === 'titan.tool_id') {
    const scrubbed = scrubText(value);
    if (scrubbed !== value || !ID_SHAPE.test(value)) {
      return undefined;
    }
    return value;
  }
  // Status and error codes: short machine codes only, never free text.
  if (key === 'titan.status' || key === 'titan.error_code') {
    return CODE_SHAPE.test(value) ? value : undefined;
  }
  return undefined;
};

/**
 * Returns a new attribute object that is safe to set on a span.
 * The input is never mutated. Unknown keys, personal keys and unsafe values are dropped.
 */
export const redactTelemetryAttributes = (input: Record<string, unknown>): TelemetryAttributes => {
  const out: TelemetryAttributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED.has(key) || isPersonalKey(key)) {
      continue;
    }
    const clean = sanitizeValue(key as TelemetryAttributeKey, value);
    if (clean !== undefined) {
      out[key] = clean;
    }
  }
  return out;
};
