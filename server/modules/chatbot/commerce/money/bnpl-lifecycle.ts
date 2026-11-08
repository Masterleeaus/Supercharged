/**
 * BNPL after the offer is made: cancelling an offer, and the provider webhook that moves an offer's status.
 *
 * Source note: BnplRuntime.php has no BNPL-specific cancel route and no BNPL webhook route. In Commerce Crew the offer
 * follows its payment intent. PaymentRuntime::cancel refuses a captured or refunded intent, PaymentRuntime::receiveWebhook
 * and processReceivedWebhook move the intent, and PaymentRuntime::synchroniseBnplOffer copies the status to the offer.
 * The statuses and transitions below are Desk design, not a port of the PHP BnplStatus values. The PHP offer statuses
 * are quoted, requires_action, approved, captured, refunded, declined, cancelled and expired. See DECISIONS.md.
 *
 * Fail-closed rules:
 * - The webhook signature is checked by the provider before anything is read or stored. A refusal, a missing secret, or
 *   a provider that throws all count as a refusal. Nothing is written for a refused webhook.
 * - A webhook can only move an offer along BNPL_WEBHOOK_TRANSITIONS. Any other status is ignored and stored as ignored.
 * - Tenancy: an offer from another company is treated as absent, so the webhook is stored as unmatched.
 */
import type { BnplOffer, BnplOfferStatus, BnplProvider, CommerceCredentials, FlagEnv, HttpClient, PaymentWebhookInput } from "../../contracts/index.ts";
import { BNPL_OFFER_STATUSES } from "../../contracts/index.ts";
import { isBnplEnabled } from "./flags.ts";
import type { BnplOfferRecord, BnplOfferStorage } from "./bnpl.ts";
import { MoneyError } from "./money.ts";
import type { PaymentWebhookOutcome, PaymentWebhookRecord } from "./payment-storage.ts";
import { createKeyedLock } from "./request-keys.ts";
import { paymentWebhookEventKey } from "./webhook-signature.ts";

/** Offers that the customer can still walk away from. An active or completed plan must be refunded, not cancelled. */
export const BNPL_CANCELLABLE_STATUSES: readonly BnplOfferStatus[] = ["eligible", "accepted"];

/** Status moves a provider webhook may make. Terminal statuses have no moves. */
export const BNPL_WEBHOOK_TRANSITIONS: Readonly<Record<BnplOfferStatus, readonly BnplOfferStatus[]>> = {
  eligible: ["accepted", "declined", "cancelled"],
  accepted: ["active", "cancelled"],
  active: ["completed"],
  declined: [],
  cancelled: [],
  completed: [],
};

export interface BnplWebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly offerId: string;
  readonly status: BnplOfferStatus;
}

export type BnplWebhookResult = PaymentWebhookOutcome | "replayed";

/** Storage for offers after creation. Extends the creation storage, so one store serves both. */
export interface BnplLifecycleStorage extends BnplOfferStorage {
  getOffer(companyId: string, offerId: string): Promise<BnplOfferRecord | null>;
  /** Compare-and-set on status. Returns false when the offer is missing or its status is not in `from`. */
  setOfferStatus(companyId: string, offerId: string, from: readonly BnplOfferStatus[], to: BnplOfferStatus, now: Date): Promise<boolean>;
  findWebhookEvent(companyId: string, provider: string, eventKey: string): Promise<PaymentWebhookRecord | null>;
  /**
   * One transaction. When `to` is set, moves the offer from one of `from`. Always saves the webhook record, so an
   * ignored or unmatched event is still recorded. Returns whether the offer moved.
   */
  settleWebhook(input: {
    readonly companyId: string;
    readonly offerId: string | null;
    readonly from: readonly BnplOfferStatus[];
    readonly to: BnplOfferStatus | null;
    readonly webhook: PaymentWebhookRecord;
    readonly now: Date;
  }): Promise<boolean>;
}

export interface BnplLifecycleOptions {
  readonly storage: BnplLifecycleStorage;
  readonly provider: BnplProvider;
  readonly env: FlagEnv;
  readonly now?: () => Date;
}

export interface BnplLifecycleService {
  /** Cancels an eligible or accepted offer at the provider, then locally. Returns the status after the call. */
  cancelOffer(companyId: string, offerId: string, credentials: CommerceCredentials, http: HttpClient): Promise<BnplOfferStatus>;
  /** Verifies, parses and applies one provider webhook. Throws MoneyError "forbidden" when the signature is refused. */
  receiveWebhook(companyId: string, input: PaymentWebhookInput, credentials: CommerceCredentials): Promise<BnplWebhookResult>;
}

function requireCompany(value: unknown): string {
  const companyId = typeof value === "string" ? value.trim() : "";
  if (companyId === "") {
    throw new MoneyError("validation", "Company is required.");
  }
  return companyId;
}

/** Parses the BNPL webhook body. Expects { id, type, data: { offer_id, status } }. Throws on anything else. */
export function parseBnplWebhook(rawBody: string): BnplWebhookEvent {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new MoneyError("validation", "The BNPL webhook body is not valid JSON.");
  }
  const root = body as { id?: unknown; type?: unknown; data?: { offer_id?: unknown; status?: unknown } } | null;
  const id = typeof root?.id === "string" ? root.id.trim() : "";
  const offerId = typeof root?.data?.offer_id === "string" ? root.data.offer_id.trim() : "";
  const status = root?.data?.status;
  if (id === "" || offerId === "") {
    throw new MoneyError("validation", "The BNPL webhook must carry an event id and an offer id.");
  }
  if (typeof status !== "string" || !(BNPL_OFFER_STATUSES as readonly string[]).includes(status)) {
    throw new MoneyError("validation", "The BNPL webhook status is not a known offer status.");
  }
  return {
    id,
    type: typeof root?.type === "string" ? root.type : "",
    offerId,
    status: status as BnplOfferStatus,
  };
}

export function createBnplLifecycleService(options: BnplLifecycleOptions): BnplLifecycleService {
  const now = options.now ?? (() => new Date());
  const withLock = createKeyedLock();
  const providerCode = options.provider.code;
  const webhookProvider = `bnpl:${providerCode}`;

  return {
    async cancelOffer(companyIdInput, offerId, credentials, http) {
      if (!isBnplEnabled(options.env)) {
        throw new MoneyError("disabled", "BNPL is not enabled.");
      }
      const companyId = requireCompany(companyIdInput);
      const id = offerId.trim();
      if (id === "") {
        throw new MoneyError("validation", "An offer id is required.");
      }
      return withLock(`${companyId}\u0000bnpl-offer\u0000${id}`, async (): Promise<BnplOfferStatus> => {
        const record = await options.storage.getOffer(companyId, id);
        if (!record) {
          throw new MoneyError("not_found", "The BNPL offer was not found.");
        }
        if (record.offer.status === "cancelled") {
          return "cancelled";
        }
        if (!BNPL_CANCELLABLE_STATUSES.includes(record.offer.status)) {
          throw new MoneyError("state", "Only an eligible or accepted BNPL offer can be cancelled.");
        }
        const result: BnplOffer | null = await options.provider.cancelOffer(companyId, id, credentials, http);
        if (!result || result.status !== "cancelled") {
          throw new MoneyError("state", "The BNPL provider did not confirm the cancellation.");
        }
        const moved = await options.storage.setOfferStatus(companyId, id, BNPL_CANCELLABLE_STATUSES, "cancelled", now());
        if (!moved) {
          throw new MoneyError("conflict", "The BNPL offer changed while this request ran. Retry.");
        }
        return "cancelled";
      });
    },

    async receiveWebhook(companyIdInput, input, credentials) {
      const companyId = requireCompany(companyIdInput);
      let verified = false;
      try {
        verified = (await options.provider.verifyWebhook(companyId, input, credentials)) === true;
      } catch {
        verified = false;
      }
      if (!verified) {
        throw new MoneyError("forbidden", "The BNPL webhook signature is not valid.");
      }

      const event = parseBnplWebhook(input.rawBody);
      const eventKey = paymentWebhookEventKey(webhookProvider, event.id, input.rawBody);
      const stored = await options.storage.findWebhookEvent(companyId, webhookProvider, eventKey);
      if (stored) {
        return "replayed";
      }

      return withLock(`${companyId}\u0000bnpl-offer\u0000${event.offerId}`, async (): Promise<BnplWebhookResult> => {
        const record = await options.storage.getOffer(companyId, event.offerId);
        const receivedAt = now();
        const base = { companyId, provider: webhookProvider, eventKey, providerEventId: event.id, eventType: event.type || null, receivedAt };

        if (!record || record.offer.providerCode !== providerCode) {
          await options.storage.settleWebhook({
            companyId,
            offerId: null,
            from: [],
            to: null,
            now: receivedAt,
            webhook: { ...base, intentId: null, outcome: "unmatched" },
          });
          return "unmatched";
        }

        const current = record.offer.status;
        const allowed = BNPL_WEBHOOK_TRANSITIONS[current].includes(event.status);
        if (!allowed) {
          await options.storage.settleWebhook({
            companyId,
            offerId: event.offerId,
            from: [],
            to: null,
            now: receivedAt,
            webhook: { ...base, intentId: event.offerId, outcome: "ignored" },
          });
          return "ignored";
        }

        const moved = await options.storage.settleWebhook({
          companyId,
          offerId: event.offerId,
          from: [current],
          to: event.status,
          now: receivedAt,
          webhook: { ...base, intentId: event.offerId, outcome: "processed" },
        });
        return moved ? "processed" : "ignored";
      });
    },
  };
}

/** Lifecycle store for tests and local runs. Keeps offers by id as well as by idempotency key. */
export function createMemoryBnplLifecycleStorage(): BnplLifecycleStorage & { readonly offers: ReadonlyMap<string, BnplOfferRecord> } {
  const byKey = new Map<string, BnplOfferRecord>();
  const byId = new Map<string, BnplOfferRecord>();
  const webhooks = new Map<string, PaymentWebhookRecord>();
  const scoped = (companyId: string, value: string): string => `${companyId}\u0000${value}`;

  const setOfferStatus = async (companyId: string, offerId: string, from: readonly BnplOfferStatus[], to: BnplOfferStatus): Promise<boolean> => {
    const record = byId.get(scoped(companyId, offerId));
    if (!record || record.companyId !== companyId || !from.includes(record.offer.status)) return false;
    const next: BnplOfferRecord = { ...record, offer: { ...record.offer, status: to } };
    byId.set(scoped(companyId, offerId), next);
    byKey.set(scoped(companyId, record.idempotencyKey), next);
    return true;
  };

  return {
    offers: byId,
    async findByKey(companyId, key) {
      return byKey.get(scoped(companyId, key)) ?? null;
    },
    async insert(record) {
      const key = scoped(record.companyId, record.idempotencyKey);
      if (byKey.has(key)) return false;
      byKey.set(key, record);
      byId.set(scoped(record.companyId, record.offer.id), record);
      return true;
    },
    async getOffer(companyId, offerId) {
      const record = byId.get(scoped(companyId, offerId));
      return record && record.companyId === companyId ? record : null;
    },
    setOfferStatus,
    async findWebhookEvent(companyId, provider, eventKey) {
      const record = webhooks.get(scoped(companyId, `${provider}|${eventKey}`));
      return record && record.companyId === companyId ? record : null;
    },
    async settleWebhook(input) {
      const moved = input.offerId !== null && input.to !== null
        ? await setOfferStatus(input.companyId, input.offerId, input.from, input.to)
        : false;
      webhooks.set(scoped(input.companyId, `${input.webhook.provider}|${input.webhook.eventKey}`), input.webhook);
      return moved;
    },
  };
}
