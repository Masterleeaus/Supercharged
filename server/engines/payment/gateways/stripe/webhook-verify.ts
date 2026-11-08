'use strict';
/**
 * Stripe webhook event verification (fail closed).
 *
 * Stripe signs every webhook with the endpoint secret. Without that secret the
 * body cannot be trusted, so this helper never parses it. The route maps
 * StripeWebhookSecretMissingError to 503 so Stripe redelivers the event once
 * the secret is configured.
 *
 * Type-only import of 'stripe' keeps this module free of runtime dependencies,
 * so it can be unit-tested without installing packages.
 */
import type Stripe from 'stripe';

export class StripeWebhookSecretMissingError extends Error {
  constructor() {
    super('Stripe webhook secret is not configured');
    this.name = 'StripeWebhookSecretMissingError';
  }
}

export interface StripeWebhookVerifier {
  webhooks: {
    constructEvent(payload: string | Buffer, header: string, secret: string): Stripe.Event;
  };
}

export function verifyStripeWebhookEvent(
  stripe: StripeWebhookVerifier,
  rawBody: string | Buffer,
  signature: string,
  secret: string | null | undefined
): Stripe.Event {
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new StripeWebhookSecretMissingError();
  }
  if (!signature) {
    throw new Error('Missing Stripe-Signature header');
  }
  return stripe.webhooks.constructEvent(rawBody, signature, secret);
}
