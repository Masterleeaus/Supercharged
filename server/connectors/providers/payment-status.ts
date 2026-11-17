/**
 * Read-only payment status connectors for Stripe and Paystack (#356). They read whether a payment
 * succeeded and return that status. They never create, capture, confirm, refund or pay out.
 * Money movement is an owner-decision item and is not built here.
 *
 * Keys must be restricted, read-only keys. The code cannot check key scope, so the owner must
 * create them that way (recorded as a decision on #356).
 */
import { ConnectorError, type ActionRequest, type ConnectorCredentials, type ConnectorDefinition } from '../sdk/contract.ts';
import { callVendor, readJson, requireString, type FetchLike } from './vendor-http.ts';

export const STRIPE_API_URL = 'https://api.stripe.com/v1/';
export const PAYSTACK_API_URL = 'https://api.paystack.co/';

export type PaymentStatusValue = 'paid' | 'pending' | 'failed' | 'unknown';

export interface PaymentStatusOptions {
  fetch: FetchLike;
}

function apiKeyOf(credentials: ConnectorCredentials): string {
  if (credentials.type !== 'api_key' || !credentials.apiKey) throw new ConnectorError('auth', 'connector needs an API key');
  return credentials.apiKey;
}

export function stripeStatus(status: unknown): PaymentStatusValue {
  if (status === 'succeeded') return 'paid';
  if (status === 'canceled') return 'failed';
  if (status === 'processing' || status === 'requires_action' || status === 'requires_payment_method' || status === 'requires_confirmation' || status === 'requires_capture') return 'pending';
  return 'unknown';
}

export function paystackStatus(status: unknown): PaymentStatusValue {
  if (status === 'success') return 'paid';
  if (status === 'failed') return 'failed';
  if (status === 'pending' || status === 'ongoing' || status === 'processing' || status === 'queued') return 'pending';
  return 'unknown';
}

export function createStripeStatusConnector(opts: PaymentStatusOptions): ConnectorDefinition {
  return {
    id: 'stripe',
    auth: 'api_key',
    capabilities: ['read'],
    entities: ['invoice'],
    actions: { getPaymentStatus: { kind: 'read', entity: 'invoice' } },
    async execute(request: ActionRequest, credentials: ConnectorCredentials): Promise<unknown> {
      if (request.action !== 'getPaymentStatus') throw new ConnectorError('validation', `unknown action "${request.action}"`);
      const id = requireString(request.input, 'paymentIntentId');
      if (!/^pi_[A-Za-z0-9]{1,128}$/.test(id)) throw new ConnectorError('validation', 'paymentIntentId is not a Stripe payment intent id');
      const response = await callVendor(
        opts.fetch,
        `${STRIPE_API_URL}payment_intents/${encodeURIComponent(id)}`,
        { method: 'GET', headers: { authorization: `Bearer ${apiKeyOf(credentials)}`, accept: 'application/json' } },
        request.timeoutMs,
      );
      const body = (await readJson(response)) as { status?: unknown };
      const status = stripeStatus(body.status);
      return { status, paid: status === 'paid' };
    },
  };
}

export function createPaystackStatusConnector(opts: PaymentStatusOptions): ConnectorDefinition {
  return {
    id: 'paystack',
    auth: 'api_key',
    capabilities: ['read'],
    entities: ['invoice'],
    actions: { getPaymentStatus: { kind: 'read', entity: 'invoice' } },
    async execute(request: ActionRequest, credentials: ConnectorCredentials): Promise<unknown> {
      if (request.action !== 'getPaymentStatus') throw new ConnectorError('validation', `unknown action "${request.action}"`);
      const reference = requireString(request.input, 'reference');
      if (!/^[A-Za-z0-9_.=-]{1,100}$/.test(reference)) throw new ConnectorError('validation', 'reference has invalid characters');
      const response = await callVendor(
        opts.fetch,
        `${PAYSTACK_API_URL}transaction/verify/${encodeURIComponent(reference)}`,
        { method: 'GET', headers: { authorization: `Bearer ${apiKeyOf(credentials)}`, accept: 'application/json' } },
        request.timeoutMs,
      );
      const body = (await readJson(response)) as { data?: { status?: unknown } };
      const status = paystackStatus(body.data?.status);
      return { status, paid: status === 'paid' };
    },
  };
}
