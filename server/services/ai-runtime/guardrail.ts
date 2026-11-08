/**
 * Guardrails. Ported from TitanPro:
 *   - Modules/TitanZero/Services/Guardrails/BlockedTermGuardrailService.php (term screening)
 *   - Modules/TitanZero/DTO/GuardrailTripped.php
 *   - Modules/TitanZero/Contracts/Guardrails/GuardrailHandlerInterface.php
 *   - Modules/TitanCore/Contracts/AI/GuardrailContract.php (the pipeline stage contract)
 *
 * Scope: blocked-term screening only. TitanPro has no production prompt-injection or PII check. Its only
 * injection terms appear as test fixtures ("ignore previous instructions", "jailbreak"). Those are not ported
 * as built-in rules. A deployment that wants them passes them as blocked_terms in its manifest.
 *
 * Changes from TitanPro (see PORT-MAP.md):
 * - manifest `handler_class` (dynamic class loading from a manifest string) becomes an injected
 *   GuardrailHandler object. The port never instantiates a class named in data.
 * - A handler that is declared but not supplied is a configuration error. TitanPro fails open here. This
 *   port fails closed, so screenInput() reports a trip.
 * - A verdict that is not exactly { pass: true } blocks. TitanPro treats a verdict with no `pass` key as a pass.
 *
 * Pure functions. No I/O.
 */
import { requireCompanyId } from './company.ts';
import type { CompanyId } from './types.ts';

export type GuardrailContext = 'input' | 'output';

export interface GuardrailTripped {
  term: string;
  context: GuardrailContext;
  message: string;
}

export interface GuardrailHandler {
  check(text: string, context: GuardrailContext): GuardrailTripped | null;
}

export interface GuardrailManifest {
  blocked_terms?: unknown;
  input_guardrails?: unknown;
  output_guardrails?: unknown;
  case_sensitive?: boolean;
  input_screening?: boolean;
  output_screening?: boolean;
  /** Declared when a custom handler is expected. The handler itself is injected separately. */
  handler_class?: string;
}

export interface GuardrailInput {
  companyId: CompanyId;
  text: string;
  tool: string | null;
  params: Record<string, unknown>;
  context: Record<string, unknown>;
}

/** What a guardrail returns. Only { pass: true } lets a request through. */
export interface GuardrailVerdict {
  pass: boolean;
  reason?: string;
}

export interface GuardrailContract {
  evaluate(input: GuardrailInput): GuardrailVerdict | Promise<GuardrailVerdict>;
}

/**
 * Collects blocked terms from the manifest: the flat `blocked_terms` list, plus `patterns` of rules whose
 * action is `block` in `input_guardrails` or `output_guardrails`. Patterns are matched as literal text.
 */
export function resolveBlockedTerms(manifest: GuardrailManifest): string[] {
  const terms: string[] = [];

  if (Array.isArray(manifest.blocked_terms)) {
    for (const term of manifest.blocked_terms) {
      if (typeof term === 'string' && term !== '') terms.push(term);
    }
  }

  for (const section of [manifest.input_guardrails, manifest.output_guardrails]) {
    if (!Array.isArray(section)) continue;
    for (const rule of section) {
      if (!rule || typeof rule !== 'object') continue;
      const r = rule as { action?: unknown; patterns?: unknown };
      if (r.action !== 'block' || !Array.isArray(r.patterns)) continue;
      for (const pattern of r.patterns) {
        if (typeof pattern === 'string' && pattern !== '') terms.push(pattern);
      }
    }
  }

  return [...new Set(terms)];
}

/**
 * Screens text for one context. Uses the injected handler when one is given, otherwise matches blocked terms
 * as case-insensitive substrings (set case_sensitive to change that). Returns null when the text passes.
 */
export function screenText(
  manifest: GuardrailManifest,
  text: string,
  context: GuardrailContext,
  handler?: GuardrailHandler | null,
): GuardrailTripped | null {
  if (handler) return handler.check(text, context);

  const terms = resolveBlockedTerms(manifest);
  if (terms.length === 0) return null;

  const caseSensitive = manifest.case_sensitive === true;
  const haystack = caseSensitive ? text : text.toLowerCase();

  for (const rawTerm of terms) {
    const needle = caseSensitive ? rawTerm : rawTerm.toLowerCase();
    if (needle !== '' && haystack.includes(needle)) {
      return {
        term: needle,
        context,
        message: `Guardrail blocked: the ${context} contains a restricted term.`,
      };
    }
  }

  return null;
}

/** Screens input. Returns null when screening is switched off with input_screening: false. */
export function screenInput(manifest: GuardrailManifest, text: string, handler?: GuardrailHandler | null): GuardrailTripped | null {
  if (manifest.input_screening === false) return null;
  return screenText(manifest, text, 'input', handler);
}

/** Screens output. Returns null when screening is switched off with output_screening: false. */
export function screenOutput(manifest: GuardrailManifest, text: string, handler?: GuardrailHandler | null): GuardrailTripped | null {
  if (manifest.output_screening === false) return null;
  return screenText(manifest, text, 'output', handler);
}

/** Builds a pipeline guardrail (GuardrailContract) from a manifest. Screens the text field only. */
export function createBlockedTermGuardrail(manifest: GuardrailManifest, handler?: GuardrailHandler | null): GuardrailContract {
  return {
    evaluate(input: GuardrailInput): GuardrailVerdict {
      const tripped = screenInput(manifest, input.text, handler);
      if (tripped) return { pass: false, reason: tripped.message };
      return { pass: true };
    },
  };
}

/**
 * Applies a guardrail to a request and returns a pass or block decision. The verdict must be exactly
 * { pass: true }. Anything else blocks. A guardrail that throws also blocks.
 */
export async function evaluateGuardrail(
  guardrail: GuardrailContract,
  input: GuardrailInput,
): Promise<{ pass: true } | { pass: false; reason: string }> {
  requireCompanyId(input.companyId);
  let verdict: unknown;
  try {
    verdict = await guardrail.evaluate(input);
  } catch {
    return { pass: false, reason: 'guardrail_error' };
  }
  if (verdict && typeof verdict === 'object') {
    const v = verdict as { pass?: unknown; reason?: unknown };
    if (v.pass === true) return { pass: true };
    if (v.pass === false) {
      return { pass: false, reason: typeof v.reason === 'string' && v.reason !== '' ? v.reason : 'blocked by guardrail' };
    }
  }
  return { pass: false, reason: 'guardrail_malformed_result' };
}
