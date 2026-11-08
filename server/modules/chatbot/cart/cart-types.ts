/**
 * Shared types, status vocabularies, the error type and request helpers for the cart and checkout slice.
 *
 * Money is always an integer count of minor units (cents). No float arithmetic touches an amount.
 * Every record carries companyId, and every storage call takes companyId first.
 */
import { createHash } from "node:crypto";
import { ChatbotError } from "../chatbot-scope.ts";

export const CART_STATUSES = ["active", "converted", "expired"] as const;
export type CartStatus = (typeof CART_STATUSES)[number];

export const CHECKOUT_STATUSES = ["open", "submitted", "cancelled", "expired"] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

export const SPEND_SCOPE_TYPES = ["conversation", "customer"] as const;
export type SpendScopeType = (typeof SPEND_SCOPE_TYPES)[number];

export const MIN_LINE_QUANTITY = 1;
export const MAX_LINE_QUANTITY = 999;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 191;

export type CartErrorCode =
  | "feature_disabled"
  | "not_found"
  | "validation"
  | "idempotency_key_required"
  | "idempotency_conflict"
  | "conflict"
  | "cart_closed"
  | "cart_expired"
  | "cart_version_mismatch"
  | "empty_cart"
  | "variant_unavailable"
  | "currency_mismatch"
  | "checkout_closed"
  | "checkout_expired"
  | "contact_required"
  | "spend_limit_exceeded";

/** HTTP status for each error code. Validation is 422, state conflicts are 409, missing rows are 404. */
const STATUS_BY_CODE: Record<CartErrorCode, number> = {
  feature_disabled: 404,
  not_found: 404,
  validation: 422,
  idempotency_key_required: 422,
  idempotency_conflict: 409,
  conflict: 409,
  cart_closed: 409,
  cart_expired: 409,
  cart_version_mismatch: 409,
  empty_cart: 422,
  variant_unavailable: 422,
  currency_mismatch: 422,
  checkout_closed: 409,
  checkout_expired: 409,
  contact_required: 422,
  spend_limit_exceeded: 422,
};

export class CartError extends ChatbotError {
  readonly code: CartErrorCode;

  constructor(code: CartErrorCode, message: string) {
    super(message, STATUS_BY_CODE[code]);
    this.name = "CartError";
    this.code = code;
  }
}

export type CustomisationValue = string | number | boolean;

export interface CartLine {
  /** Stable line id: sha256 of variant id plus canonical customisation. Clients reference lines by this. */
  readonly lineKey: string;
  readonly variantId: string;
  readonly productId: string;
  readonly sku: string | null;
  readonly name: string;
  readonly quantity: number;
  /** Unit price captured when the line was last written. Minor units. */
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
  readonly currency: string;
  readonly customisation: Readonly<Record<string, CustomisationValue>>;
}

export interface CartRecord {
  readonly id: string;
  readonly companyId: string;
  readonly chatbotId: string;
  readonly conversationId: string;
  readonly customerId: string | null;
  readonly status: CartStatus;
  /** Null until the first line is added. Once set, every line in the cart shares it. */
  readonly currency: string | null;
  readonly lines: readonly CartLine[];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly version: number;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CartOperationRecord {
  readonly companyId: string;
  readonly cartId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly operation: string;
  readonly createdAt: Date;
}

export interface CheckoutContact {
  readonly email: string | null;
  readonly phone: string | null;
  readonly name: string | null;
}

export interface CheckoutRecord {
  readonly id: string;
  readonly companyId: string;
  readonly cartId: string;
  readonly chatbotId: string;
  readonly conversationId: string;
  readonly customerId: string | null;
  readonly status: CheckoutStatus;
  readonly currency: string;
  /** Snapshot of the cart lines, refreshed on open and again on submit. */
  readonly lines: readonly CartLine[];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly contact: CheckoutContact;
  readonly orderRequest: OrderRequest | null;
  readonly version: number;
  readonly expiresAt: Date;
  readonly submittedAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CheckoutOperationRecord {
  readonly companyId: string;
  readonly checkoutId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly operation: string;
  readonly createdAt: Date;
}

export interface SpendLimitRecord {
  readonly id: string;
  readonly companyId: string;
  readonly scopeType: SpendScopeType;
  readonly scopeId: string;
  readonly currency: string;
  /** Largest single checkout allowed, minor units. Null means no cap. */
  readonly maxOrderMinor: number | null;
  /** Rolling daily cap, minor units. Null means no cap. */
  readonly dailyLimitMinor: number | null;
  /** Amount submitted on periodDate. Ignored when periodDate is not today. */
  readonly spentMinor: number;
  readonly periodDate: string | null;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Plain order request produced by a submitted checkout. The orders slice accepts this shape.
 * idempotencyKey is derived from the checkout id, so the orders side can deduplicate retries.
 */
export interface OrderRequest {
  readonly idempotencyKey: string;
  readonly companyId: string;
  readonly chatbotId: string;
  readonly conversationId: string;
  readonly customerId: string | null;
  readonly checkoutId: string;
  readonly cartId: string;
  readonly currency: string;
  readonly lines: readonly OrderRequestLine[];
  readonly subtotalMinor: number;
  readonly discountMinor: number;
  readonly totalMinor: number;
  readonly contact: CheckoutContact;
  readonly createdAt: string;
}

export interface OrderRequestLine {
  readonly variantId: string;
  readonly productId: string;
  readonly sku: string | null;
  readonly name: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly lineTotalMinor: number;
  readonly currency: string;
}

/** Tenant and conversation scope for a cart. Passed by the caller, never read from the body. */
export interface CartScope {
  readonly companyId: string;
  readonly chatbotId: string;
  readonly conversationId: string;
  readonly customerId?: string | null;
}

export function orderRequestKey(checkoutId: string): string {
  return `checkout:${checkoutId}`;
}

/** Feature gate. Defaults to off. The chatbot module reads no env, so the flag is an injected option. */
export function ensureEnabled(enabled: boolean): void {
  if (!enabled) {
    throw new CartError("feature_disabled", "Cart and checkout are not enabled for this deployment.");
  }
}

/** Trims the key and rejects empty or over-long keys. Returns the trimmed key. */
export function normaliseIdempotencyKey(key: unknown, required: boolean): string | null {
  if (key === undefined || key === null || key === "") {
    if (required) {
      throw new CartError("idempotency_key_required", "A valid idempotency key is required.");
    }
    return null;
  }
  if (typeof key !== "string") {
    throw new CartError("validation", "The idempotency key must be a string.");
  }
  const trimmed = key.trim();
  if (trimmed === "" || trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new CartError("idempotency_key_required", "A valid idempotency key is required.");
  }
  return trimmed;
}

/** Deterministic JSON: object keys sorted at every depth, so equal requests hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

export function hashRequest(operation: string, payload: unknown): string {
  return createHash("sha256").update(canonicalJson([operation, payload])).digest("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Returns the UTC calendar date as YYYY-MM-DD. Used for daily spend periods. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}
