/**
 * Cart and checkout slice entry point. Domain logic only. Payment capture, carrier quotes, tax and the
 * product catalog are out of scope and reach this slice through interfaces.
 *
 * Feature flag: the chatbot module reads no environment variables. Its generative UI is gated by an
 * injected option, so this slice follows that pattern. `enabled` defaults to false, and every public
 * method throws feature_disabled until the owner turns it on in the composition root.
 *
 * Usage (composition root, not wired yet):
 *   const { carts, checkouts } = createCartModule({ storage, catalog, enabled: flagFromConfig });
 * Database storage: pass { lock: passThroughLock } as well, so the keyed lock is not used across processes.
 */
import { createCartService, DEFAULT_CART_TTL_DAYS, type CartService } from "./cart-service.ts";
import { createCheckoutService, DEFAULT_CHECKOUT_TTL_MINUTES, type CheckoutService } from "./checkout-service.ts";
import type { CartStorage } from "./cart-storage.ts";
import type { CartCatalog } from "./catalog.ts";
import { createKeyedLock, type KeyedLock } from "./keyed-lock.ts";

export interface CartModuleOptions {
  /** Company-scoped storage. Required. There is no in-memory default, so production cannot start on one by accident. */
  readonly storage: CartStorage;
  readonly catalog: CartCatalog;
  /** Feature flag. Defaults to false. */
  readonly enabled?: boolean;
  readonly now?: () => Date;
  readonly cartTtlDays?: number;
  readonly checkoutTtlMinutes?: number;
  /**
   * In-process guard. Defaults to the keyed lock, which suits the in-memory storage. A database deployment
   * passes passThroughLock, because the storage transaction and its row locks hold across processes.
   */
  readonly lock?: KeyedLock;
}

export interface CartModule {
  readonly enabled: boolean;
  readonly carts: CartService;
  readonly checkouts: CheckoutService;
}

export function createCartModule(options: CartModuleOptions): CartModule {
  const enabled = options.enabled === true;
  const now = options.now ?? (() => new Date());
  // One lock instance is shared, so cart and checkout operations order against each other correctly.
  const lock = options.lock ?? createKeyedLock();

  const carts = createCartService({
    storage: options.storage,
    catalog: options.catalog,
    lock,
    enabled,
    now,
    cartTtlDays: options.cartTtlDays ?? DEFAULT_CART_TTL_DAYS,
  });
  const checkouts = createCheckoutService({
    storage: options.storage,
    lock,
    enabled,
    now,
    checkoutTtlMinutes: options.checkoutTtlMinutes ?? DEFAULT_CHECKOUT_TTL_MINUTES,
  });

  return { enabled, carts, checkouts };
}

export { CartError, type CartErrorCode, type CartRecord, type CartLine, type CheckoutRecord, type OrderRequest, type OrderRequestLine, type SpendLimitRecord, type CartScope, type CheckoutContact } from "./cart-types.ts";
export { createMemoryCartStorage, type CartStorage, type SpendLimitTarget } from "./cart-storage.ts";
export { createMemoryCartCatalog, type CartCatalog, type CatalogVariant } from "./catalog.ts";
export { createCartService, type CartService, type AddLineInput } from "./cart-service.ts";
export { createCheckoutService, type CheckoutService, type ContactInput, type SubmitCheckoutInput, type SubmitCheckoutResult, type SpendLimitInput } from "./checkout-service.ts";
export { computeTotals, lineTotalMinor, normaliseQuantity, type CartTotals } from "./money.ts";
export { evaluateSpendLimit, type SpendLimitDecision, type SpendLimitReason } from "./spend-limit.ts";
export { createKeyedLock, passThroughLock, type KeyedLock } from "./keyed-lock.ts";
