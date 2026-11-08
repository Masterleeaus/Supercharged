/**
 * In-process PaymentProvider for the "internal" provider key. It calls no external service, so the HttpClient it
 * receives is never used. Ported from Providers/InternalPaymentProvider.php. Its state lives in memory. A real
 * provider replaces this and keeps its own state.
 *
 * Idempotency: a repeated createIntent with the same company and key returns the same intent, as the contract requires.
 */
import { randomUUID } from "node:crypto";
import type {
  CommerceCredentials,
  PaymentActionResult,
  PaymentIntent,
  PaymentIntentInput,
  PaymentProvider,
  PaymentRefundResult,
  PaymentStatus,
  PaymentWebhookEvent,
  PaymentWebhookInput,
} from "../../contracts/index.ts";
import { MoneyError } from "./money.ts";
import { assertKnownPaymentStatus, statusAfterRefund } from "./payment-lifecycle.ts";
import { verifyPaymentWebhookSignature, WEBHOOK_TOLERANCE_SECONDS } from "./webhook-signature.ts";

export interface InternalPaymentProviderOptions {
  readonly allowedMethods?: readonly string[];
  readonly now?: () => Date;
  readonly newId?: () => string;
}

interface InternalIntentState {
  readonly companyId: string;
  readonly idempotencyKey: string;
  readonly providerIntentId: string;
  readonly currency: string;
  readonly amountMinor: number;
  status: PaymentStatus;
  authorizedMinor: number;
  capturedMinor: number;
  refundedMinor: number;
  readonly clientToken: string;
}

export const INTERNAL_PAYMENT_METHODS = ["card", "bank_transfer", "payid", "cash", "external"] as const;

export function createInternalPaymentProvider(options: InternalPaymentProviderOptions = {}): PaymentProvider {
  const allowed = new Set((options.allowedMethods ?? INTERNAL_PAYMENT_METHODS).map((method) => method.trim().toLowerCase()));
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const byProviderId = new Map<string, InternalIntentState>();
  const byKey = new Map<string, InternalIntentState>();

  const lookup = (companyId: string, providerIntentId: string): InternalIntentState => {
    const state = byProviderId.get(providerIntentId);
    if (!state || state.companyId !== companyId) {
      throw new MoneyError("not_found", "The provider payment was not found.");
    }
    return state;
  };

  const result = (state: InternalIntentState, providerRequestId: string | null): PaymentActionResult => ({
    providerIntentId: state.providerIntentId,
    status: state.status,
    amountMinor: state.amountMinor,
    currency: state.currency,
    providerRequestId,
  });

  return {
    name: "internal",

    supports(method: string): boolean {
      return allowed.has(method.trim().toLowerCase());
    },

    async createIntent(companyId: string, input: PaymentIntentInput): Promise<PaymentIntent> {
      const replayKey = `${companyId}\u0000${input.idempotencyKey}`;
      const existing = byKey.get(replayKey);
      if (existing) {
        return { providerIntentId: existing.providerIntentId, status: existing.status, amountMinor: existing.amountMinor, currency: existing.currency, clientToken: existing.clientToken };
      }
      if (!allowed.has(input.method.trim().toLowerCase())) {
        throw new MoneyError("validation", "The selected payment method is not supported by the internal provider.");
      }
      const state: InternalIntentState = {
        companyId,
        idempotencyKey: input.idempotencyKey,
        providerIntentId: `pi_internal_${newId()}`,
        currency: input.currency,
        amountMinor: input.amountMinor,
        status: "requires_payment_method",
        authorizedMinor: 0,
        capturedMinor: 0,
        refundedMinor: 0,
        clientToken: `ct_internal_${newId()}`,
      };
      byProviderId.set(state.providerIntentId, state);
      byKey.set(replayKey, state);
      return { providerIntentId: state.providerIntentId, status: state.status, amountMinor: state.amountMinor, currency: state.currency, clientToken: state.clientToken };
    },

    async authorize(companyId: string, providerIntentId: string): Promise<PaymentActionResult> {
      const state = lookup(companyId, providerIntentId);
      if (state.status !== "requires_payment_method") {
        throw new MoneyError("state", "This payment cannot be authorised from its current state.");
      }
      state.status = "requires_capture";
      state.authorizedMinor = state.amountMinor;
      return result(state, `auth_${newId()}`);
    },

    async capture(companyId: string, providerIntentId: string, amountMinor: number): Promise<PaymentActionResult> {
      const state = lookup(companyId, providerIntentId);
      if (state.status !== "requires_capture" || amountMinor <= 0 || state.capturedMinor + amountMinor > state.authorizedMinor) {
        throw new MoneyError("state", "This payment cannot be captured for that amount.");
      }
      state.capturedMinor += amountMinor;
      state.status = state.capturedMinor >= state.authorizedMinor ? "succeeded" : "requires_capture";
      return result(state, `cap_${newId()}`);
    },

    async cancel(companyId: string, providerIntentId: string): Promise<PaymentActionResult> {
      const state = lookup(companyId, providerIntentId);
      if (state.capturedMinor > 0 || (state.status !== "requires_payment_method" && state.status !== "requires_capture")) {
        throw new MoneyError("state", "This payment cannot be cancelled from its current state.");
      }
      state.status = "canceled";
      return result(state, `can_${newId()}`);
    },

    async refund(companyId: string, providerIntentId: string, amountMinor: number): Promise<PaymentRefundResult> {
      const state = lookup(companyId, providerIntentId);
      const refundable = state.capturedMinor - state.refundedMinor;
      if (amountMinor <= 0 || amountMinor > refundable) {
        throw new MoneyError("validation", "Refund amount exceeds the remaining refundable amount.");
      }
      state.refundedMinor += amountMinor;
      state.status = statusAfterRefund(state.status, state.capturedMinor, state.refundedMinor, state.authorizedMinor);
      return {
        ...result(state, `ref_${newId()}`),
        refundId: `re_${newId()}`,
        refundedMinor: amountMinor,
      };
    },

    async retrieve(companyId: string, providerIntentId: string): Promise<PaymentActionResult> {
      return result(lookup(companyId, providerIntentId), null);
    },

    async verifyWebhook(_companyId: string, input: PaymentWebhookInput, credentials: CommerceCredentials): Promise<boolean> {
      return verifyPaymentWebhookSignature(input, credentials["webhook_secret"], Math.floor(now().getTime() / 1000), WEBHOOK_TOLERANCE_SECONDS);
    },

    parseWebhook(_companyId: string, rawBody: string): PaymentWebhookEvent[] {
      let decoded: unknown;
      try {
        decoded = JSON.parse(rawBody);
      } catch {
        return [];
      }
      const events = Array.isArray(decoded) ? decoded : [decoded];
      const parsed: PaymentWebhookEvent[] = [];
      for (const item of events) {
        if (item === null || typeof item !== "object") continue;
        const raw = item as Record<string, unknown>;
        const statusText = typeof raw.status === "string" ? raw.status : null;
        const status = statusText === null ? null : assertKnownPaymentStatusOrNull(statusText);
        const amount = Number.isSafeInteger(raw.amount_minor) ? (raw.amount_minor as number) : null;
        const created = Number.isSafeInteger(raw.created) ? (raw.created as number) : Math.floor(now().getTime() / 1000);
        parsed.push({
          providerEventId: String(raw.id ?? ""),
          type: String(raw.type ?? ""),
          providerIntentId: typeof raw.payment_intent_id === "string" ? raw.payment_intent_id : null,
          status,
          amountMinor: amount,
          currency: typeof raw.currency === "string" ? raw.currency.toUpperCase() : null,
          occurredAt: new Date(created * 1000),
        });
      }
      return parsed;
    },
  };
}

function assertKnownPaymentStatusOrNull(value: string): PaymentStatus | null {
  try {
    return assertKnownPaymentStatus(value);
  } catch {
    return null;
  }
}
