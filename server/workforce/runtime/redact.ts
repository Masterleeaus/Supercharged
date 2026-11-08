/**
 * Redaction for logs, prompts, tool outputs and audit views.
 *
 * redactForAudit walks a plain value and returns a copy. The input is never mutated.
 * Rules:
 * - A key matching SENSITIVE_KEY has its value replaced with REDACTED, whatever the value's type.
 * - Strings have bearer tokens, sk_/pk_ keys and eyJ-form JWTs replaced with REDACTED.
 * - Email addresses keep their first local-part character and their domain; the rest is masked.
 * - Card-like digit runs (13 to 19 digits) keep only the last 4 digits.
 * - Values nested deeper than MAX_DEPTH, and cyclic references, become TRUNCATED.
 *
 * This module does not import from server/services/redaction.ts or audit-log.ts. Their
 * rules differ (different key list, no email rule, different card pattern), and
 * audit-log.ts does not export redactFreeText.
 */

export const REDACTED = '[redacted]'
export const TRUNCATED = '[truncated]'

const MAX_DEPTH = 10

const SENSITIVE_KEY = /(token|secret|password|api[_-]?key|authorization|cookie|session|credential|otp|code)/i

const BEARER = /(?<=\bBearer\s+)[A-Za-z0-9._~+/-]+=*/gi
const API_KEY = /\b(?:sk|pk)_[A-Za-z0-9_]{8,}/g
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const CARD = /(?<!\d)\d{13,19}(?!\d)/g

const maskEmail = (email: string): string => {
  const at = email.indexOf('@')
  const local = email.slice(0, at)
  const domain = email.slice(at)
  return local.charAt(0) + '*'.repeat(local.length - 1) + domain
}

const maskCard = (digits: string): string =>
  '*'.repeat(digits.length - 4) + digits.slice(-4)

const redactText = (text: string): string =>
  text
    .replace(BEARER, REDACTED)
    .replace(JWT, REDACTED)
    .replace(API_KEY, REDACTED)
    .replace(EMAIL, maskEmail)
    .replace(CARD, maskCard)

const walk = (value: unknown, depth: number, ancestors: Set<object>): unknown => {
  if (depth > MAX_DEPTH) return TRUNCATED
  if (typeof value === 'string') return redactText(value)
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) return TRUNCATED

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1, ancestors))
    }
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      const child = SENSITIVE_KEY.test(key)
        ? REDACTED
        : walk((value as Record<string, unknown>)[key], depth + 1, ancestors)
      // defineProperty keeps a literal "__proto__" key as data instead of setting the prototype.
      Object.defineProperty(out, key, { value: child, enumerable: true, writable: true, configurable: true })
    }
    return out
  } finally {
    ancestors.delete(value)
  }
}

export function redactForAudit<T>(value: T): T {
  return walk(value, 0, new Set<object>()) as T
}
