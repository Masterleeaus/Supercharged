// Language and voice provider routing with a circuit breaker (#333). Pure: the caller passes `now`.
// Speech and telephony providers are chosen here. Nothing in this file calls a network.

export interface VoiceProviderConfig {
  id: string;
  languages: string[];
  priority: number;
}

export interface BreakerState {
  failures: number;
  openUntil: number | null;
}

export const BREAKER_FAILURE_THRESHOLD = 3;
export const BREAKER_COOLDOWN_MS = 60_000;

export function recordOutcome(state: BreakerState, ok: boolean, now: number): BreakerState {
  if (ok) return { failures: 0, openUntil: null };
  const failures = state.failures + 1;
  if (failures >= BREAKER_FAILURE_THRESHOLD) return { failures: 0, openUntil: now + BREAKER_COOLDOWN_MS };
  return { failures, openUntil: null };
}

export function isAvailable(state: BreakerState, now: number): boolean {
  return state.openUntil === null || now >= state.openUntil;
}

export type RouteDecision =
  | { type: 'provider'; providerId: string; language: string; fellBack: boolean }
  | { type: 'none'; reason: 'no_available_provider' };

const norm = (lang: string) => lang.trim().toLowerCase().split(/[-_]/)[0];

/**
 * Picks the highest-priority available provider for the caller's language. If none supports it,
 * falls back to any available provider (fellBack true) so the call still connects.
 * Breaker states are keyed by provider id; a missing key means no failures so far.
 */
export function routeVoiceProvider(
  providers: VoiceProviderConfig[],
  breakers: Record<string, BreakerState>,
  callerLanguage: string,
  now: number,
): RouteDecision {
  const lang = norm(callerLanguage || 'en');
  const available = providers
    .filter((p) => isAvailable(breakers[p.id] ?? { failures: 0, openUntil: null }, now))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const match = available.find((p) => p.languages.map(norm).includes(lang));
  if (match) return { type: 'provider', providerId: match.id, language: lang, fellBack: false };
  if (available.length > 0) return { type: 'provider', providerId: available[0].id, language: lang, fellBack: true };
  return { type: 'none', reason: 'no_available_provider' };
}
