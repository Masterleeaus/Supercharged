/**
 * Secret and PII redaction helpers.
 *
 * Ported from mcp-gateway-work (src/services/redaction.ts), MIT License,
 * Copyright (c) 2026 Aureo Bueno. Patterns and functions are kept from the
 * source; the only change is the Date guard in redactValue. See
 * _TITAN_HANDOFF/NOTICES/mcp-gateway-work-MIT.md for the full notice.
 *
 * This module is pure: no imports, no I/O.
 */

export interface RedactionRule {
  name: string
  source: string
  flags: string
}

export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  { name: 'openai_key', source: '\\bsk-[A-Za-z0-9_-]{16,}\\b', flags: 'g' },
  { name: 'github_token', source: '\\bgh[pousr]_[A-Za-z0-9]{20,}\\b', flags: 'g' },
  { name: 'slack_token', source: '\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b', flags: 'g' },
  { name: 'aws_access_key', source: '\\bAKIA[0-9A-Z]{16}\\b', flags: 'g' },
  { name: 'google_api_key', source: '\\bAIza[0-9A-Za-z_-]{35}\\b', flags: 'g' },
  {
    name: 'jwt',
    source: '\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b',
    flags: 'g',
  },
  { name: 'bearer_token', source: '(?<=Bearer\\s+)[A-Za-z0-9._-]{6,}', flags: 'gi' },
  { name: 'cpf', source: '\\b\\d{3}\\.\\d{3}\\.\\d{3}-\\d{2}\\b', flags: 'g' },
  { name: 'credit_card', source: '\\b(?:\\d{4}[- ]?){3}\\d{1,4}\\b', flags: 'g' },
  {
    name: 'secret_assignment',
    source:
      '(?<=(?:api[_-]?key|token|secret|password|passwd)["\']?\\s*[:=]\\s*)["\']?[A-Za-z0-9._-]{8,}',
    flags: 'gi',
  },
]

export type RedactionHits = Record<string, number>

export interface RedactionSummary {
  total: number
  hits: RedactionHits
}

export interface RedactionOptions {
  enabled?: boolean
  replacement?: string
  rules?: RedactionRule[]
}

/**
 * Key names whose values are treated as secrets regardless of their content.
 * Matched against the key lowercased with separators removed, by suffix, so
 * `password`, `db_password`, `githubToken` and `x-api-key` all match while
 * `max_tokens` or `token_type` do not.
 */
const SENSITIVE_KEY_SUFFIXES = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'privatekey',
  'credential',
  'credentials',
  'cookie',
  'sessionid',
]

export const isSensitiveKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '')
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

const SENSITIVE_KEY_RULE = 'sensitive_key'

export const redactString = (
  input: string,
  replacement = '***',
  rules: RedactionRule[] = DEFAULT_REDACTION_RULES
): { text: string; hits: RedactionHits } => {
  let text = input
  const hits: RedactionHits = {}

  for (const rule of rules) {
    const matches = text.match(new RegExp(rule.source, rule.flags))
    if (matches === null || matches.length === 0) {
      continue
    }
    hits[rule.name] = (hits[rule.name] ?? 0) + matches.length
    text = text.replace(new RegExp(rule.source, rule.flags), replacement)
  }

  return { text, hits }
}

interface WalkOptions {
  replacement: string
  rules: RedactionRule[]
  maskSensitiveKeys: boolean
}

const countHit = (summary: RedactionSummary, rule: string, count: number): void => {
  summary.hits[rule] = (summary.hits[rule] ?? 0) + count
  summary.total += count
}

const redactValue = (value: unknown, summary: RedactionSummary, options: WalkOptions): unknown => {
  if (typeof value === 'string') {
    const { text, hits } = redactString(value, options.replacement, options.rules)
    for (const [rule, count] of Object.entries(hits)) {
      countHit(summary, rule, count)
    }
    return text
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, summary, options))
  }

  // Dates have no own enumerable keys; walking them would turn them into {}.
  if (value instanceof Date) {
    return value
  }

  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (
        options.maskSensitiveKeys &&
        isSensitiveKey(key) &&
        (typeof item === 'string' || typeof item === 'number')
      ) {
        countHit(summary, SENSITIVE_KEY_RULE, 1)
        out[key] = options.replacement
        continue
      }
      out[key] = redactValue(item, summary, options)
    }
    return out
  }

  return value
}

const redact = <T>(
  value: T,
  options: RedactionOptions,
  maskSensitiveKeys: boolean
): { result: T; summary: RedactionSummary } => {
  const summary: RedactionSummary = { total: 0, hits: {} }

  if (options.enabled === false) {
    return { result: value, summary }
  }

  const redacted = redactValue(value, summary, {
    replacement: options.replacement ?? '***',
    rules: options.rules ?? DEFAULT_REDACTION_RULES,
    maskSensitiveKeys,
  }) as T

  return { result: redacted, summary }
}

/** Redacts secrets found in the text of a tool, resource or prompt response. */
export const redactToolResult = <T>(
  result: T,
  options: RedactionOptions = {}
): { result: T; summary: RedactionSummary } => redact(result, options, false)

/**
 * Redacts secrets from request arguments before they are persisted (audit log,
 * approvals). On top of the value patterns, any string or number stored under a
 * sensitive key name (`password`, `token`, `api_key`, ...) is masked. The original
 * arguments are still the ones forwarded to the upstream server.
 */
export const redactArguments = <T>(
  args: T,
  options: RedactionOptions = {}
): { result: T; summary: RedactionSummary } => redact(args, options, true)
