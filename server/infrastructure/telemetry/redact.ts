/**
 * Span attribute redaction. Runs before any attribute leaves the process.
 *
 * Reuses the key and value rules from server/services/redaction.ts. Sensitive keys
 * are masked whatever their value. String values are scrubbed with the value
 * patterns and then truncated, so a large prompt or response is never exported whole.
 */
import { isSensitiveKey, redactString } from '../../services/redaction.ts';

export const TELEMETRY_VALUE_MAX = 256;
export const TELEMETRY_REDACTED = '[redacted]';

export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, SpanAttributeValue>;

function cleanString(value: string): string {
  const { text } = redactString(value, TELEMETRY_REDACTED);
  return text.length > TELEMETRY_VALUE_MAX ? `${text.slice(0, TELEMETRY_VALUE_MAX)}...` : text;
}

/** Returns a copy of attrs that is safe to export. Non-scalar values are dropped. */
export function redactAttributes(attrs: Record<string, unknown> | null | undefined): SpanAttributes {
  const out: SpanAttributes = {};
  if (!attrs) return out;
  for (const [key, value] of Object.entries(attrs)) {
    if (isSensitiveKey(key)) {
      out[key] = TELEMETRY_REDACTED;
    } else if (typeof value === 'string') {
      out[key] = cleanString(value);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}
