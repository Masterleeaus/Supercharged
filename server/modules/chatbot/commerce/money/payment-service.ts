/**
 * Payment intents, authorise, capture, cancel, refund and webhook intake. Ported from PaymentRuntime.php, on top of
 * the PaymentProvider contract and the PaymentStorage port.
 *
 * Rules enforced here, not in the provider:
 * - Money is integer minor units. A refund above the captured amount is refused before the provider is called.
 * - A repeated create with the same key returns the stored intent. The provider is not called again. A different
 *   request under the same key is refused.
 * - A repeated capture, refund or cancel with the same key returns the stored result. A different request is refused.
 * - A webhook with a missing, malformed, stale or wrong signature is refused. Nothing is written for it.
 * - Every read and write is scoped by company id.
 */
import { randomUUID } from "node:crypto";
import type {
  CommerceCredentials,
  HttpClient,
  PaymentIntentInput,
  PaymentProvider,
  PaymentStatus,
  PaymentWebhookInput,
} from "../../contracts/index.ts";
import { assertPositiveMinor, MoneyError, normaliseCurrency } from "./money.ts";
import {
  assertKnownPaymentStatus,
  assertTransition,
  canTransition,
  remainingCapture,
  remainingRefund,
  statusAfterRefund,
} from "./payment-lifecycle.ts";
import { isPaymentsEnabled } from "./flags.ts";
import { createKeyedLock, hashRequest, requiredIdempotencyKey } from "./request-keys.ts";
import type {
  PaymentIntentPatch,
  PaymentIntentRecord,
  PaymentOperationKind,
  PaymentOperationRecord,
  PaymentStorage,
  PaymentWebhookOutcome,
} from "./payment-storage.ts";
import { paymentWebhookEventKey } from "./webhook-signature.ts";
import type { FlagEnv } from "../../contracts/index.ts";

export interface PaymentIntentView {
  readonly id: string;
  readonly providerName: string;
  readonly providerIntentId: string;
  readonly orderRef: string;
  readonly method: string;
  readonly currency: string;
  readonly amountMinor: number;
  readonly authorizedMinor: number;
  readonly capturedMinor: number;
  readonly refundedMinor: number;
  readonly status: PaymentStatus;
  readonly clientToken: string | null;
  readonly version: number;
}

export interface CreateIntentResult extends PaymentIntentView {
  /** True when the key matched an existing intent and no provider call was made. */
  readonly replayed: boolean;
}

export interface RefundResult {
  readonly intentId: string;
  readonly refundId: string;
  readonly refundedMinor: number;
  readonly refundedTotalMinor: number;
  readonly status: PaymentStatus;
  readonly replayed: boolean;
}

export interface WebhookReceipt {
  readonly processed: number;
  readonly ignored: number;
  readonly unmatched: number;
}

export interface PaymentServiceOptions {
  readonly storage: PaymentStorage;
  readonly provider: PaymentProvider;
  readonly env: FlagEnv;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface PaymentService {
  createIntent(input: PaymentIntentInput, http: HttpClient): Promise<CreateIntentResult>;
  getIntent(companyId: string, id: string): Promise<PaymentIntentView | null>;
  authorize(companyId: string, id: string, idempotencyKey: string, http: HttpClient): Promise<PaymentIntentView>;
  capture(companyId: string, id: string, amountMinor: number | null, idempotencyKey: string, http: HttpClient): Promise<PaymentIntentView>;
  cancel(companyId: string, id: string, idempotencyKey: string, http: HttpClient): Promise<PaymentIntentView>;
  refund(companyId: string, id: string, amountMinor: number, idempotencyKey: string, reason: string | null, http: HttpClient): Promise<RefundResult>;
  receiveWebhook(companyId: string, input: PaymentWebhookInput, credentials: CommerceCredentials): Promise<WebhookReceipt>;
}

const MAX_TEXT = 191;

function requireText(value: unknown, field: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "" || text.length > MAX_TEXT) {
    throw new MoneyError("validation", `${field} is required and must be at most ${MAX_TEXT} characters.`);
  }
  return text;
}

function requireCompany(companyId: unknown): string {
  return requireText(companyId, "Company");
}

function toView(record: PaymentIntentRecord): PaymentIntentView {
  return {
    id: record.id,
    providerName: record.providerName,
    providerIntentId: record.providerIntentId,
    orderRef: record.orderRef,
    method: record.method,
    currency: record.currency,
    amountMinor: record.amountMinor,
    authorizedMinor: record.authorizedMinor,
    capturedMinor: record.capturedMinor,
    refundedMinor: record.refundedMinor,
    status: record.status,
    clientToken: record.clientToken,
    version: record.version,
  };
}

const PAYMENT_WEBHOOK_STATUSES_THAT_MAY_BE_APPLIED: readonly PaymentStatus[] = ["canceled", "failed"];

export function createPaymentService(options: PaymentServiceOptions): PaymentService {
  const { storage, provider } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => randomUUID());
  const withLock = createKeyedLock();

  const assertEnabled = (): void => {
    if (!isPaymentsEnabled(options.env)) {
      throw new MoneyError("disabled", "Payments are not enabled.");
    }
  };

  const loadIntent = async (companyId: string, id: string): Promise<PaymentIntentRecord> => {
    const record = await storage.getIntent(companyId, id);
    if (!record) {
      throw new MoneyError("not_found", "The payment intent was not found.");
    }
    return record;
  };

  /**
   * Runs one operation on an intent under the intent lock, with idempotency. A replay returns the stored result
   * and makes no provider call. A new operation runs the body, then stores the patch and the operation record.
   */
  async function runOperation(
    companyId: string,
    intentId: string,
    kind: PaymentOperationKind,
    idempotencyKey: string,
    requestHash: string,
    amountMinor: number | null,
    body: (intent: PaymentIntentRecord) => Promise<{ patch: PaymentIntentPatch; result: Record<string, string | number | null> }>,
  ): Promise<{ intent: PaymentIntentRecord; result: Record<string, string | number | null>; replayed: boolean }> {
    return withLock(`${companyId}\u0000intent\u0000${intentId}`, async () => {
      const stored = await storage.findOperationByKey(companyId, idempotencyKey);
      if (stored) {
        if (stored.intentId !== intentId || stored.operation !== kind || stored.requestHash !== requestHash) {
          throw new MoneyError("conflict", "The idempotency key was already used for a different payment operation.");
        }
        return { intent: await loadIntent(companyId, intentId), result: { ...stored.result }, replayed: true };
      }

      const intent = await loadIntent(companyId, intentId);
      const outcome = await body(intent);
      const stamp = now();
      const saved = await storage.updateIntent(companyId, intentId, intent.version, outcome.patch, stamp);
      if (!saved) {
        throw new MoneyError("conflict", "The payment changed while this operation ran. Retry with the same key.");
      }
      const operation: PaymentOperationRecord = {
        companyId,
        intentId,
        operation: kind,
        idempotencyKey,
        requestHash,
        amountMinor,
        result: outcome.result,
        createdAt: stamp,
      };
      if (!(await storage.insertOperation(operation))) {
        throw new MoneyError("conflict", "The idempotency key was used by a concurrent operation.");
      }
      return { intent: await loadIntent(companyId, intentId), result: outcome.result, replayed: false };
    });
  }

  return {
    async createIntent(input, http) {
      assertEnabled();
      const companyId = requireCompany(input.companyId);
      const orderRef = requireText(input.orderRef, "Order reference");
      const amountMinor = assertPositiveMinor(input.amountMinor, "Amount");
      const currency = normaliseCurrency(input.currency);
      const method = requireText(input.method, "Payment method").toLowerCase();
      if (!provider.supports(method)) {
        throw new MoneyError("validation", "The selected payment method is not supported by the configured payment provider.");
      }
      const idempotencyKey = requiredIdempotencyKey(input.idempotencyKey);
      const customerRef = input.customerRef ?? null;
      const description = input.description ?? null;
      const requestHash = hashRequest({ orderRef, amountMinor, currency, method, customerRef, description });

      return withLock(`${companyId}\u0000create\u0000${idempotencyKey}`, async () => {
        const existing = await storage.findIntentByKey(companyId, idempotencyKey);
        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new MoneyError("conflict", "The idempotency key was already used for another payment intent.");
          }
          return { ...toView(existing), replayed: true };
        }

        const normalised: PaymentIntentInput = { companyId, orderRef, amountMinor, currency, method, description, idempotencyKey, customerRef };
        const providerIntent = await provider.createIntent(companyId, normalised, http);
        if (providerIntent.amountMinor !== amountMinor || providerIntent.currency !== currency) {
          throw new MoneyError("state", "The payment provider returned a different amount or currency.");
        }

        const stamp = now();
        const record: PaymentIntentRecord = {
          companyId,
          id: `pay_${newId()}`,
          providerName: provider.name,
          providerIntentId: providerIntent.providerIntentId,
          idempotencyKey,
          requestHash,
          orderRef,
          method,
          currency,
          amountMinor,
          customerRef,
          status: assertKnownPaymentStatus(providerIntent.status),
          authorizedMinor: 0,
          capturedMinor: 0,
          refundedMinor: 0,
          clientToken: providerIntent.clientToken,
          version: 0,
          createdAt: stamp,
          updatedAt: stamp,
        };
        if (!(await storage.insertIntent(record))) {
          throw new MoneyError("conflict", "The payment intent could not be stored. Retry with the same key.");
        }
        return { ...toView(record), replayed: false };
      });
    },

    async getIntent(companyId, id) {
      const record = await storage.getIntent(requireCompany(companyId), requireText(id, "Payment intent"));
      return record ? toView(record) : null;
    },

    async authorize(companyId, id, idempotencyKey, http) {
      assertEnabled();
      const tenant = requireCompany(companyId);
      const intentId = requireText(id, "Payment intent");
      const key = requiredIdempotencyKey(idempotencyKey);
      const run = await runOperation(tenant, intentId, "authorize", key, hashRequest({ op: "authorize", intentId }), null, async (intent) => {
        if (intent.status !== "requires_payment_method") {
          throw new MoneyError("state", "This payment cannot be authorised from its current state.");
        }
        const providerResult = await provider.authorize(tenant, intent.providerIntentId, http);
        const status = assertKnownPaymentStatus(providerResult.status);
        assertTransition(intent.status, status);
        return {
          patch: { status, authorizedMinor: intent.amountMinor },
          result: { status, authorizedMinor: intent.amountMinor },
        };
      });
      return toView(run.intent);
    },

    async capture(companyId, id, amountMinor, idempotencyKey, http) {
      assertEnabled();
      const tenant = requireCompany(companyId);
      const intentId = requireText(id, "Payment intent");
      const key = requiredIdempotencyKey(idempotencyKey);
      const requested = amountMinor === null ? null : assertPositiveMinor(amountMinor, "Capture amount");
      const requestHash = hashRequest({ op: "capture", intentId, amountMinor: requested });

      const run = await runOperation(tenant, intentId, "capture", key, requestHash, requested, async (intent) => {
        if (intent.status !== "requires_capture") {
          throw new MoneyError("state", "This payment cannot be captured from its current state.");
        }
        const remaining = remainingCapture(intent.authorizedMinor, intent.capturedMinor);
        const amount = requested ?? remaining;
        if (amount <= 0 || amount > remaining) {
          throw new MoneyError("validation", "Capture amount exceeds the remaining authorised payment amount.");
        }
        const providerResult = await provider.capture(tenant, intent.providerIntentId, amount, http);
        const capturedMinor = intent.capturedMinor + amount;
        const status: PaymentStatus = capturedMinor >= intent.authorizedMinor ? "succeeded" : "requires_capture";
        if (assertKnownPaymentStatus(providerResult.status) !== status) {
          throw new MoneyError("state", "The payment provider reported a status that does not match the captured amount.");
        }
        return {
          patch: { status, capturedMinor },
          result: { status, capturedMinor, captureAmountMinor: amount },
        };
      });
      return toView(run.intent);
    },

    async cancel(companyId, id, idempotencyKey, http) {
      assertEnabled();
      const tenant = requireCompany(companyId);
      const intentId = requireText(id, "Payment intent");
      const key = requiredIdempotencyKey(idempotencyKey);
      const run = await runOperation(tenant, intentId, "cancel", key, hashRequest({ op: "cancel", intentId }), null, async (intent) => {
        if (intent.capturedMinor > 0) {
          throw new MoneyError("state", "A captured payment cannot be cancelled; use a refund.");
        }
        if (intent.status !== "requires_payment_method" && intent.status !== "requires_capture") {
          throw new MoneyError("state", "This payment cannot be cancelled from its current state.");
        }
        const providerResult = await provider.cancel(tenant, intent.providerIntentId, http);
        assertKnownPaymentStatus(providerResult.status);
        assertTransition(intent.status, "canceled");
        return { patch: { status: "canceled" }, result: { status: "canceled" } };
      });
      return toView(run.intent);
    },

    async refund(companyId, id, amountMinor, idempotencyKey, reason, http) {
      assertEnabled();
      const tenant = requireCompany(companyId);
      const intentId = requireText(id, "Payment intent");
      const amount = assertPositiveMinor(amountMinor, "Refund amount");
      const key = requiredIdempotencyKey(idempotencyKey);
      const requestHash = hashRequest({ op: "refund", intentId, amountMinor: amount, reason: reason ?? null });

      const run = await runOperation(tenant, intentId, "refund", key, requestHash, amount, async (intent) => {
        const refundable = intent.capturedMinor > 0 && (intent.status === "requires_capture" || intent.status === "succeeded");
        if (!refundable) {
          throw new MoneyError("state", "Only captured payments can be refunded.");
        }
        // Checked before the provider is called. A refund above what was captured never reaches the provider.
        if (amount > remainingRefund(intent.capturedMinor, intent.refundedMinor)) {
          throw new MoneyError("validation", "Refund amount exceeds the remaining refundable amount.");
        }
        const providerResult = await provider.refund(tenant, intent.providerIntentId, amount, reason, http);
        if (providerResult.refundedMinor !== amount) {
          throw new MoneyError("state", "The payment provider refunded a different amount.");
        }
        const refundedMinor = intent.refundedMinor + amount;
        const status = statusAfterRefund(intent.status, intent.capturedMinor, refundedMinor, intent.authorizedMinor);
        if (!canTransition(intent.status, status)) {
          throw new MoneyError("state", `Payment status cannot move from ${intent.status} to ${status}.`);
        }
        return {
          patch: { status, refundedMinor },
          result: { refundId: providerResult.refundId, refundedMinor: amount, refundedTotalMinor: refundedMinor, status },
        };
      });

      const result = run.result;
      return {
        intentId,
        refundId: String(result.refundId),
        refundedMinor: Number(result.refundedMinor),
        refundedTotalMinor: Number(result.refundedTotalMinor),
        status: String(result.status) as PaymentStatus,
        replayed: run.replayed,
      };
    },

    async receiveWebhook(companyId, input, credentials) {
      assertEnabled();
      const tenant = requireCompany(companyId);
      if (typeof input.rawBody !== "string") {
        throw new MoneyError("forbidden", "The payment webhook signature is invalid or stale.");
      }
      // Fails closed: nothing is parsed, stored or applied unless the signature verifies.
      const verified = await provider.verifyWebhook(tenant, input, credentials);
      if (verified !== true) {
        throw new MoneyError("forbidden", "The payment webhook signature is invalid or stale.");
      }

      const receipt = { processed: 0, ignored: 0, unmatched: 0 };
      for (const event of provider.parseWebhook(tenant, input.rawBody)) {
        const eventKey = paymentWebhookEventKey(provider.name, event.providerEventId, input.rawBody);
        const seen = await storage.findWebhookEvent(tenant, provider.name, eventKey);
        if (seen) {
          receipt.ignored += 1;
          continue;
        }

        let outcome: PaymentWebhookOutcome = "unmatched";
        let intentId: string | null = null;
        if (event.providerIntentId) {
          const intent = await storage.findIntentByProviderId(tenant, provider.name, event.providerIntentId);
          if (intent) {
            intentId = intent.id;
            outcome = await withLock(`${tenant}\u0000intent\u0000${intent.id}`, async (): Promise<PaymentWebhookOutcome> => {
              const current = await loadIntent(tenant, intent.id);
              const target = event.status;
              // Webhooks may only apply cancel or fail. Money-moving states come from the operation path.
              if (target === null || !PAYMENT_WEBHOOK_STATUSES_THAT_MAY_BE_APPLIED.includes(target) || !canTransition(current.status, target)) {
                return "ignored";
              }
              const applied = await storage.updateIntent(tenant, current.id, current.version, { status: target }, now());
              return applied ? "processed" : "ignored";
            });
          }
        }

        await storage.saveWebhookEvent({
          companyId: tenant,
          provider: provider.name,
          eventKey,
          providerEventId: event.providerEventId || null,
          eventType: event.type || null,
          intentId,
          outcome,
          receivedAt: now(),
        });
        receipt[outcome === "processed" ? "processed" : outcome === "ignored" ? "ignored" : "unmatched"] += 1;
      }
      return receipt;
    },
  };
}
