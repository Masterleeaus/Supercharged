// Gateway-neutral webhook engine. Every operation takes a server-side scope
// with company_id. company_id is never read from a request body; the caller
// must derive it from the server route or the secret binding.
//
// Order of checks in receiveWebhook (each failure throws, nothing is claimed):
//   1. company_id present and well-formed
//   2. gateway is a known id (Map lookup, so prototype keys are refused)
//   3. signature verified with the company's secret (fail closed)
//   4. event key claimed atomically in the processed-event store (replay refused)
//   5. optional handler runs; if it throws, the claim is released for retry

import {
  COMPANY_ID_PATTERN,
  PaymentEngineError,
  type GatewayAdapter,
  type GatewayId,
  type RawWebhook,
  type RemoteVerifier,
  type VerifiedWebhook,
  type VerifyOutcome,
  type WebhookReceipt,
} from './contract.ts';
import type { ProcessedEventStore } from './idempotency.ts';
import { createDefaultAdapters, sha256Hex } from './verifiers.ts';

export interface PaymentEngineOptions {
  resolveWebhookSecret: (companyId: string, gateway: GatewayId) => Promise<string | null>;
  store: ProcessedEventStore;
  remoteVerifiers?: Partial<Record<'paypal' | 'yookassa', RemoteVerifier>>;
  now?: () => number;
}

export interface PaymentScope {
  companyId: unknown;
}

export type WebhookHandler = (event: VerifiedWebhook) => Promise<void>;

export interface PaymentEngine {
  receiveWebhook(
    scope: PaymentScope,
    gateway: unknown,
    input: RawWebhook,
    onVerified?: WebhookHandler,
  ): Promise<WebhookReceipt>;
}

export function requireCompanyId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PaymentEngineError('company_id_required');
  }
  if (!COMPANY_ID_PATTERN.test(value)) {
    throw new PaymentEngineError('company_id_invalid');
  }
  return value;
}

function toBuffer(raw: string | Uint8Array): Buffer {
  return typeof raw === 'string' ? Buffer.from(raw, 'utf8') : Buffer.from(raw);
}

export function createPaymentEngine(options: PaymentEngineOptions): PaymentEngine {
  if (typeof options?.resolveWebhookSecret !== 'function') {
    throw new PaymentEngineError('engine_misconfigured', 'resolveWebhookSecret');
  }
  if (!options.store || typeof options.store.claim !== 'function') {
    throw new PaymentEngineError('engine_misconfigured', 'store');
  }

  const adapters: Map<GatewayId, GatewayAdapter> = createDefaultAdapters(options.remoteVerifiers ?? {});
  const now = options.now ?? (() => Date.now());
  const store = options.store;
  const resolveSecret = options.resolveWebhookSecret;

  return {
    async receiveWebhook(scope, gateway, input, onVerified) {
      const companyId = requireCompanyId(scope?.companyId);

      if (typeof gateway !== 'string') throw new PaymentEngineError('unknown_gateway');
      const adapter = adapters.get(gateway as GatewayId);
      if (!adapter) throw new PaymentEngineError('unknown_gateway');

      const secret = await resolveSecret(companyId, adapter.id);

      let outcome: VerifyOutcome;
      try {
        outcome = await adapter.verify({
          rawBody: input.rawBody,
          headers: input.headers ?? {},
          query: input.query,
          secret,
          nowMs: now(),
        });
      } catch {
        outcome = { ok: false, reason: 'verifier_error' };
      }
      if (outcome.ok !== true) {
        throw new PaymentEngineError('signature_invalid', outcome.reason);
      }

      const body = toBuffer(input.rawBody);
      // Keys come from signed content only. Headers are not used, because an
      // unsigned header could change the key and bypass replay protection.
      const eventId = outcome.eventId ? `id:${outcome.eventId}` : `sha256:${sha256Hex(body)}`;
      const eventKey = `${companyId}|${adapter.id}|${eventId}`;

      const claimed = await store.claim(eventKey, {
        companyId,
        gateway: adapter.id,
        processedAtMs: now(),
      });
      if (!claimed) throw new PaymentEngineError('replay_refused');

      if (onVerified) {
        try {
          await onVerified({
            companyId,
            gateway: adapter.id,
            eventKey,
            rawBody: body.toString('utf8'),
            receivedAtMs: now(),
          });
        } catch (err) {
          await store.release(eventKey);
          throw err;
        }
      }

      return { status: 'accepted', companyId, gateway: adapter.id, eventKey };
    },
  };
}
