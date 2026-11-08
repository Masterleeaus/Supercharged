/**
 * Checkout session: open, contact details, submit, cancel, and the per-conversation or per-customer
 * spend limit. Port of CheckoutRuntime and BudgetLockRuntime, reduced to the states this slice needs:
 * open -> submitted, open -> cancelled, open -> expired.
 *
 * Payment capture is out of scope. Submit produces an OrderRequest and stops there.
 *
 * Every mutation runs inside storage.transaction(), and every read and write inside it uses the
 * transaction-bound `tx`. An open checkout found past its TTL is marked expired and that write must
 * survive, so such a failure is returned from the transaction and thrown after it commits.
 */
import { randomUUID } from "node:crypto";
import { requireCompanyId } from "../chatbot-scope.ts";
import { cartLockKey, requireText } from "./cart-service.ts";
import type { CartStorage, SpendLimitTarget } from "./cart-storage.ts";
import {
  CartError,
  type CartLine,
  type CartRecord,
  type CheckoutContact,
  type CheckoutRecord,
  type OrderRequest,
  type OrderRequestLine,
  type SpendLimitRecord,
  SPEND_SCOPE_TYPES,
  type SpendScopeType,
  ensureEnabled,
  hashRequest,
  normaliseIdempotencyKey,
  orderRequestKey,
  utcDate,
} from "./cart-types.ts";
import type { KeyedLock } from "./keyed-lock.ts";
import { addSpend, evaluateSpendLimit, spentOnDate } from "./spend-limit.ts";

export const DEFAULT_CHECKOUT_TTL_MINUTES = 30;
const MIN_CHECKOUT_TTL_MINUTES = 5;
const MAX_CHECKOUT_TTL_MINUTES = 1440;

export interface CheckoutServiceDeps {
  readonly storage: CartStorage;
  readonly lock: KeyedLock;
  readonly enabled: boolean;
  readonly now: () => Date;
  readonly checkoutTtlMinutes: number;
}

export interface ContactInput {
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly name?: string | null;
}

export interface SubmitCheckoutInput {
  /** Required. Replaying the same key with the same body returns the first result. */
  readonly idempotencyKey: string;
  /** Optional guard. Submit fails if the cart version differs from this value. */
  readonly expectedCartVersion?: number | null;
}

export interface SubmitCheckoutResult {
  readonly checkout: CheckoutRecord;
  readonly orderRequest: OrderRequest;
  /** True when the key had already been used, so nothing new was written. */
  readonly replayed: boolean;
}

export interface SpendLimitInput {
  readonly scopeType: SpendScopeType;
  readonly scopeId: string;
  readonly currency: string;
  readonly maxOrderMinor?: number | null;
  readonly dailyLimitMinor?: number | null;
  readonly enabled?: boolean;
}

export interface CheckoutService {
  /** Returns the open checkout for the cart, or opens one. Requires at least one line. */
  openCheckout(companyId: string, cartId: string): Promise<CheckoutRecord>;
  getCheckout(companyId: string, checkoutId: string): Promise<CheckoutRecord>;
  /** Replaces the contact details. Only open checkouts accept this. */
  updateContact(companyId: string, checkoutId: string, contact: ContactInput): Promise<CheckoutRecord>;
  submitCheckout(companyId: string, checkoutId: string, input: SubmitCheckoutInput): Promise<SubmitCheckoutResult>;
  cancelCheckout(companyId: string, checkoutId: string): Promise<CheckoutRecord>;
  setSpendLimit(companyId: string, input: SpendLimitInput): Promise<SpendLimitRecord>;
}

/** A transaction result that carries either a value or a refusal. A refusal is thrown after commit. */
type Outcome<T> = { readonly value: T } | { readonly problem: CartError };

export function checkoutLockKey(companyId: string, checkoutId: string): string {
  return `checkout:${companyId}:${checkoutId}`;
}

export function spendLockKey(companyId: string): string {
  return `spend:${companyId}`;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+?[0-9()\-\s]{6,}$/;

function optionalText(value: string | null | undefined, field: string, max: number): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new CartError("validation", `${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  if (trimmed.length > max) {
    throw new CartError("validation", `${field} must be at most ${max} characters.`);
  }
  return trimmed;
}

export function normaliseContact(input: ContactInput): CheckoutContact {
  const emailRaw = optionalText(input.email, "Email", 254);
  const email = emailRaw === null ? null : emailRaw.toLowerCase();
  if (email !== null && !EMAIL_PATTERN.test(email)) {
    throw new CartError("validation", "Email address is not valid.");
  }
  const phone = optionalText(input.phone, "Phone", 80);
  if (phone !== null && !PHONE_PATTERN.test(phone)) {
    throw new CartError("validation", "Phone number is not valid.");
  }
  return { email, phone, name: optionalText(input.name, "Name", 191) };
}

function assertContactPresent(contact: CheckoutContact): void {
  if (contact.email === null && contact.phone === null) {
    throw new CartError("contact_required", "An email address or phone number is required.");
  }
}

function requireCartCurrency(cart: CartRecord): string {
  if (cart.currency === null || cart.lines.length === 0) {
    throw new CartError("empty_cart", "The cart is empty.");
  }
  return cart.currency;
}

interface CartSnapshot {
  readonly currency: string;
  readonly lines: readonly CartLine[];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly customerId: string | null;
}

function snapshotOf(cart: CartRecord): CartSnapshot {
  return {
    currency: requireCartCurrency(cart),
    lines: cart.lines,
    subtotalMinor: cart.subtotalMinor,
    discountMinor: cart.discountMinor,
    totalMinor: cart.totalMinor,
    customerId: cart.customerId,
  };
}

function toOrderLine(line: CartLine): OrderRequestLine {
  return {
    variantId: line.variantId,
    productId: line.productId,
    sku: line.sku,
    name: line.name,
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    lineTotalMinor: line.lineTotalMinor,
    currency: line.currency,
  };
}

export function createCheckoutService(deps: CheckoutServiceDeps): CheckoutService {
  const { storage, lock, now } = deps;
  const requestedTtl = Number.isSafeInteger(deps.checkoutTtlMinutes) ? deps.checkoutTtlMinutes : DEFAULT_CHECKOUT_TTL_MINUTES;
  const ttlMinutes = Math.min(Math.max(requestedTtl, MIN_CHECKOUT_TTL_MINUTES), MAX_CHECKOUT_TTL_MINUTES);

  function requireEnabled(): void {
    ensureEnabled(deps.enabled);
  }

  function addMinutes(at: Date): Date {
    return new Date(at.getTime() + ttlMinutes * 60 * 1000);
  }

  async function loadCheckout(store: CartStorage, companyId: string, checkoutId: string): Promise<CheckoutRecord> {
    const checkout = await store.getCheckout(companyId, requireText(checkoutId, "checkout_id"));
    if (!checkout) {
      throw new CartError("not_found", "Checkout not found.");
    }
    return checkout;
  }

  /**
   * Returns the reason an open checkout cannot be changed, or null. An open checkout past its TTL is
   * marked expired first, and that write is kept by the caller's transaction. The refusal is returned,
   * not thrown, so the transaction commits the expiry.
   */
  async function openProblem(store: CartStorage, companyId: string, checkout: CheckoutRecord, at: Date): Promise<CartError | null> {
    if (checkout.status !== "open") {
      return new CartError("checkout_closed", "This checkout can no longer be changed.");
    }
    if (checkout.expiresAt.getTime() <= at.getTime()) {
      await store.putCheckout(companyId, { ...checkout, status: "expired", updatedAt: at });
      return new CartError("checkout_expired", "This checkout has expired.");
    }
    return null;
  }

  async function loadCartForCheckout(store: CartStorage, companyId: string, checkout: CheckoutRecord): Promise<CartRecord> {
    const cart = await store.getCart(companyId, checkout.cartId);
    if (!cart) {
      throw new CartError("not_found", "Cart not found.");
    }
    return cart;
  }

  /**
   * Checks every enabled limit that matches this conversation or customer. The first block wins.
   * Matching limits are all checked, not just the most specific one, so a customer cap cannot be
   * bypassed by a looser conversation cap.
   */
  async function enforceSpend(store: CartStorage, companyId: string, cart: CartRecord, currency: string, at: Date): Promise<SpendLimitRecord[]> {
    const targets: SpendLimitTarget[] = [{ scopeType: "conversation", scopeId: cart.conversationId }];
    if (cart.customerId !== null) {
      targets.push({ scopeType: "customer", scopeId: cart.customerId });
    }
    const limits = (await store.findSpendLimits(companyId, targets)).filter((limit) => limit.enabled);
    const today = utcDate(at);

    for (const limit of limits) {
      const decision = evaluateSpendLimit(cart.totalMinor, currency, {
        currency: limit.currency,
        maxOrderMinor: limit.maxOrderMinor,
        dailyLimitMinor: limit.dailyLimitMinor,
        spentTodayMinor: spentOnDate(limit, today),
      });
      if (!decision.allowed) {
        const reason = (decision.reason ?? "limit").replace(/_/g, " ");
        throw new CartError("spend_limit_exceeded", `Purchase blocked by ${reason}.`);
      }
    }
    return limits;
  }

  function buildOrderRequest(checkout: CheckoutRecord, cart: CartRecord, snapshot: CartSnapshot, at: Date): OrderRequest {
    return {
      idempotencyKey: orderRequestKey(checkout.id),
      companyId: checkout.companyId,
      chatbotId: checkout.chatbotId,
      conversationId: checkout.conversationId,
      customerId: snapshot.customerId,
      checkoutId: checkout.id,
      cartId: cart.id,
      currency: snapshot.currency,
      lines: snapshot.lines.map(toOrderLine),
      subtotalMinor: snapshot.subtotalMinor,
      discountMinor: snapshot.discountMinor,
      totalMinor: snapshot.totalMinor,
      contact: checkout.contact,
      createdAt: at.toISOString(),
    };
  }

  return {
    async openCheckout(companyId, cartId) {
      requireEnabled();
      const tenant = requireCompanyId(companyId);
      const cartKey = requireText(cartId, "cart_id");

      return lock(cartLockKey(tenant, cartKey), () =>
        storage.transaction(tenant, async (tx) => {
          const at = now();
          const cart = await tx.getCart(tenant, cartKey);
          if (!cart) {
            throw new CartError("not_found", "Cart not found.");
          }
          if (cart.status !== "active") {
            throw new CartError("cart_closed", "Only an active cart can be checked out.");
          }
          if (cart.expiresAt.getTime() <= at.getTime()) {
            throw new CartError("cart_expired", "The cart has expired.");
          }
          const snapshot = snapshotOf(cart);

          const existing = await tx.findOpenCheckoutForCart(tenant, cart.id);
          if (existing && existing.expiresAt.getTime() > at.getTime()) {
            const refreshed: CheckoutRecord = { ...existing, ...snapshot, updatedAt: at };
            await tx.putCheckout(tenant, refreshed);
            return refreshed;
          }
          if (existing) {
            await tx.putCheckout(tenant, { ...existing, status: "expired", updatedAt: at });
          }

          const checkout: CheckoutRecord = {
            id: randomUUID(),
            companyId: tenant,
            cartId: cart.id,
            chatbotId: cart.chatbotId,
            conversationId: cart.conversationId,
            status: "open",
            ...snapshot,
            contact: { email: null, phone: null, name: null },
            orderRequest: null,
            version: 0,
            expiresAt: addMinutes(at),
            submittedAt: null,
            cancelledAt: null,
            createdAt: at,
            updatedAt: at,
          };
          await tx.putCheckout(tenant, checkout);
          return checkout;
        }),
      );
    },

    async getCheckout(companyId, checkoutId) {
      requireEnabled();
      return loadCheckout(storage, requireCompanyId(companyId), checkoutId);
    },

    async updateContact(companyId, checkoutId, contact) {
      requireEnabled();
      const tenant = requireCompanyId(companyId);
      const id = requireText(checkoutId, "checkout_id");

      const outcome: Outcome<CheckoutRecord> = await lock(checkoutLockKey(tenant, id), () =>
        storage.transaction(tenant, async (tx): Promise<Outcome<CheckoutRecord>> => {
          const at = now();
          const checkout = await loadCheckout(tx, tenant, id);
          const problem = await openProblem(tx, tenant, checkout, at);
          if (problem) {
            return { problem };
          }

          const next = normaliseContact(contact);
          assertContactPresent(next);

          const updated: CheckoutRecord = {
            ...checkout,
            contact: next,
            expiresAt: addMinutes(at),
            version: checkout.version + 1,
            updatedAt: at,
          };
          await tx.putCheckout(tenant, updated);
          return { value: updated };
        }),
      );
      return unwrap(outcome);
    },

    async submitCheckout(companyId, checkoutId, input) {
      requireEnabled();
      const tenant = requireCompanyId(companyId);
      const id = requireText(checkoutId, "checkout_id");
      const key = normaliseIdempotencyKey(input.idempotencyKey, true) as string;
      const expected = input.expectedCartVersion ?? null;
      if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) {
        throw new CartError("validation", "The expected cart version must be a non-negative whole number.");
      }
      const requestHash = hashRequest("checkout.submit", { expectedCartVersion: expected });

      // Lock order is always cart, then checkout, then spend. No path takes them in reverse.
      // The keyed locks are the in-process guard. The storage transaction is the consistency guarantee.
      const peek = await loadCheckout(storage, tenant, id);
      const outcome: Outcome<SubmitCheckoutResult> = await lock(cartLockKey(tenant, peek.cartId), () =>
        lock(checkoutLockKey(tenant, id), () =>
          lock(spendLockKey(tenant), () =>
            storage.transaction(tenant, async (tx): Promise<Outcome<SubmitCheckoutResult>> => {
              const at = now();
              const checkout = await loadCheckout(tx, tenant, id);

              const replay = await tx.findCheckoutOperation(tenant, checkout.id, key);
              if (replay) {
                if (replay.requestHash !== requestHash || checkout.orderRequest === null) {
                  throw new CartError("idempotency_conflict", "The idempotency key was already used for a different checkout request.");
                }
                return { value: { checkout, orderRequest: checkout.orderRequest, replayed: true } };
              }

              const problem = await openProblem(tx, tenant, checkout, at);
              if (problem) {
                return { problem };
              }
              const cart = await loadCartForCheckout(tx, tenant, checkout);
              if (cart.status !== "active") {
                throw new CartError("cart_closed", "Only an active cart can be checked out.");
              }
              if (cart.expiresAt.getTime() <= at.getTime()) {
                throw new CartError("cart_expired", "The cart has expired.");
              }
              const currency = requireCartCurrency(cart);
              if (expected !== null && cart.version !== expected) {
                throw new CartError("cart_version_mismatch", "The cart changed before checkout. Review it and submit again.");
              }
              assertContactPresent(checkout.contact);

              const limits = await enforceSpend(tx, tenant, cart, currency, at);

              const snapshot = snapshotOf(cart);
              const submitted: CheckoutRecord = {
                ...checkout,
                status: "submitted",
                ...snapshot,
                orderRequest: null,
                submittedAt: at,
                version: checkout.version + 1,
                updatedAt: at,
              };
              const orderRequest = buildOrderRequest(submitted, cart, snapshot, at);
              const sealed: CheckoutRecord = { ...submitted, orderRequest };

              // Freeze the cart, record the checkout and its key, then count the spend. All in one transaction.
              await tx.putCart(tenant, { ...cart, status: "converted", version: cart.version + 1, updatedAt: at });
              await tx.putCheckout(tenant, sealed);
              await tx.putCheckoutOperation(tenant, {
                companyId: tenant,
                checkoutId: checkout.id,
                idempotencyKey: key,
                requestHash,
                operation: "checkout.submit",
                createdAt: at,
              });

              const today = utcDate(at);
              for (const limit of limits) {
                await tx.putSpendLimit(tenant, {
                  ...limit,
                  spentMinor: addSpend(limit, snapshot.totalMinor, today),
                  periodDate: today,
                  updatedAt: at,
                });
              }

              return { value: { checkout: sealed, orderRequest, replayed: false } };
            }),
          ),
        ),
      );
      return unwrap(outcome);
    },

    async cancelCheckout(companyId, checkoutId) {
      requireEnabled();
      const tenant = requireCompanyId(companyId);
      const id = requireText(checkoutId, "checkout_id");

      const outcome: Outcome<CheckoutRecord> = await lock(checkoutLockKey(tenant, id), () =>
        storage.transaction(tenant, async (tx): Promise<Outcome<CheckoutRecord>> => {
          const at = now();
          const checkout = await loadCheckout(tx, tenant, id);
          const problem = await openProblem(tx, tenant, checkout, at);
          if (problem) {
            return { problem };
          }
          const cancelled: CheckoutRecord = {
            ...checkout,
            status: "cancelled",
            cancelledAt: at,
            version: checkout.version + 1,
            updatedAt: at,
          };
          await tx.putCheckout(tenant, cancelled);
          return { value: cancelled };
        }),
      );
      return unwrap(outcome);
    },

    async setSpendLimit(companyId, input) {
      requireEnabled();
      const tenant = requireCompanyId(companyId);
      if (!(SPEND_SCOPE_TYPES as readonly string[]).includes(input.scopeType)) {
        throw new CartError("validation", "Spend limit scope must be conversation or customer.");
      }
      const scopeId = requireText(input.scopeId, "scope_id");
      const currency = typeof input.currency === "string" && /^[A-Za-z]{3}$/.test(input.currency.trim())
        ? input.currency.trim().toUpperCase()
        : null;
      if (currency === null) {
        throw new CartError("validation", "Currency must be a three-letter code.");
      }
      const maxOrderMinor = input.maxOrderMinor ?? null;
      const dailyLimitMinor = input.dailyLimitMinor ?? null;
      for (const [field, value] of [["Per-order cap", maxOrderMinor], ["Daily cap", dailyLimitMinor]] as const) {
        if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
          throw new CartError("validation", `${field} must be a positive whole number of minor units.`);
        }
      }
      if (maxOrderMinor === null && dailyLimitMinor === null) {
        throw new CartError("validation", "A spend limit needs a per-order cap, a daily cap, or both.");
      }

      return lock(spendLockKey(tenant), () =>
        storage.transaction(tenant, async (tx) => {
          const at = now();
          const [existing] = await tx.findSpendLimits(tenant, [{ scopeType: input.scopeType, scopeId }]);
          const record: SpendLimitRecord = {
            id: existing?.id ?? randomUUID(),
            companyId: tenant,
            scopeType: input.scopeType,
            scopeId,
            currency,
            maxOrderMinor,
            dailyLimitMinor,
            spentMinor: existing?.spentMinor ?? 0,
            periodDate: existing?.periodDate ?? null,
            enabled: input.enabled ?? true,
            createdAt: existing?.createdAt ?? at,
            updatedAt: at,
          };
          await tx.putSpendLimit(tenant, record);
          return record;
        }),
      );
    },
  };
}

/** Throws the refusal that a transaction returned, after it has committed. */
function unwrap<T>(outcome: Outcome<T>): T {
  if ("problem" in outcome) {
    throw outcome.problem;
  }
  return outcome.value;
}
