/**
 * Feature allowlist for tzfd-ai/1. Each feature lists the consent scopes it needs.
 * The default implementation makes no model call: it answers service_error.
 * Budget checks belong to a later wave and are not here.
 */
export interface FeatureDefinition {
  readonly scopes: readonly string[];
}

export const FEATURES: ReadonlyMap<string, FeatureDefinition> = new Map<string, FeatureDefinition>([
  ['faq.answer', { scopes: ['faq.read'] }],
  ['faq.embed_query', { scopes: ['faq.read'] }],
  ['faq.suggest_batch', { scopes: ['faq.read'] }],
  ['insight.monthly', { scopes: ['reports.read'] }],
  ['assistant.turn', { scopes: ['faq.read', 'customer.read'] }],
  ['agent.run', { scopes: ['booking.read', 'booking.write', 'customer.read'] }],
]);

export interface FeatureRequest {
  readonly site: string;
  readonly feature: string;
  readonly payload: unknown;
  readonly scopes: readonly string[];
}

/** What a feature returns. The handler checks the status and size before it signs the reply. */
export interface FeatureOutcome {
  readonly status: string;
  readonly data?: unknown;
  readonly usage?: unknown;
}

export type FeatureImplementation = (request: FeatureRequest) => FeatureOutcome | Promise<FeatureOutcome>;

export const defaultFeatureImplementation: FeatureImplementation = () => ({ status: 'service_error' });
