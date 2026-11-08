/**
 * Conversation-scoped cart. Port of CartRuntime's add, set-quantity, remove, clear and getOrCreate paths.
 *
 * Differences from the PHP, all recorded in DECISIONS.md:
 *  - Quantity below 1 is rejected. The PHP treats 0 as removal and clamps silently. Removal is its own call here.
 *  - A line that would exceed 999 is rejected instead of clamped.
 *  - Abandon, recover, merge and coupon paths are not ported.
 *
 * Every mutation runs inside storage.transaction(). All reads and writes in the callback use the
 * transaction-bound `tx`, so the row locks in the Drizzle storage cover the whole read-check-write.
 * The keyed lock is an in-process guard. The module passes it in; a database deployment passes a
 * pass-through lock (see index.ts). Nothing calls storage.transaction() from inside another transaction.
 */
import { randomUUID } from "node:crypto";
import { requireCompanyId } from "../chatbot-scope.ts";
import type { CartStorage } from "./cart-storage.ts";
import {
  CartError,
  type CartLine,
  type CartRecord,
  type CartScope,
  type CustomisationValue,
  canonicalJson,
  ensureEnabled,
  hashRequest,
  normaliseIdempotencyKey,
  sha256Hex,
} from "./cart-types.ts";
import type { CartCatalog } from "./catalog.ts";
import type { KeyedLock } from "./keyed-lock.ts";
import { computeTotals, lineTotalMinor, normaliseQuantity } from "./money.ts";

export const DEFAULT_CART_TTL_DAYS = 7;
const MAX_CUSTOMISATION_KEYS = 20;
const MAX_TEXT_LENGTH = 191;

export interface CartServiceDeps {
  readonly storage: CartStorage;
  readonly catalog: CartCatalog;
  readonly lock: KeyedLock;
  readonly enabled: boolean;
  readonly now: () => Date;
  readonly cartTtlDays: number;
}

export interface AddLineInput {
  readonly variantId: string;
  readonly quantity?: number;
  readonly customisation?: Readonly<Record<string, CustomisationValue>>;
}

export interface CartService {
  /** Returns the active cart for the conversation, creating one if needed. */
  getOrCreateCart(scope: CartScope): Promise<CartRecord>;
  getCart(companyId: string, cartId: string): Promise<CartRecord>;
  addLine(companyId: string, cartId: string, input: AddLineInput, idempotencyKey?: string | null): Promise<CartRecord>;
  setLineQuantity(companyId: string, cartId: string, lineKey: string, quantity: number, idempotencyKey?: string | null): Promise<CartRecord>;
  removeLine(companyId: string, cartId: string, lineKey: string, idempotencyKey?: string | null): Promise<CartRecord>;
  clear(companyId: string, cartId: string, idempotencyKey?: string | null): Promise<CartRecord>;
}

export function cartLockKey(companyId: string, cartId: string): string {
  return `cart:${companyId}:${cartId}`;
}

export function conversationLockKey(companyId: string, conversationId: string): string {
  return `conversation:${companyId}:${conversationId}`;
}

/** Trims a required text field and enforces a length cap. */
export function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > MAX_TEXT_LENGTH) {
    throw new CartError("validation", `${field} must be a non-empty string up to ${MAX_TEXT_LENGTH} characters.`);
  }
  return value.trim();
}

export function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/** Stable line id. Equal variant and customisation give the same key, so repeat adds merge into one line. */
export function makeLineKey(variantId: string, customisation: Readonly<Record<string, CustomisationValue>>): string {
  return sha256Hex(`${variantId}|${canonicalJson(customisation)}`);
}

export function normaliseCustomisation(value: unknown): Record<string, CustomisationValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new CartError("validation", "Customisation must be an object.");
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_CUSTOMISATION_KEYS) {
    throw new CartError("validation", `Customisation can have at most ${MAX_CUSTOMISATION_KEYS} fields.`);
  }
  const out: Record<string, CustomisationValue> = {};
  for (const [key, item] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (key.length === 0 || key.length > 64) {
      throw new CartError("validation", "Customisation keys must be 1 to 64 characters.");
    }
    const isString = typeof item === "string" && item.length <= 255;
    const isBoolean = typeof item === "boolean";
    const isNumber = typeof item === "number" && Number.isFinite(item);
    if (!isString && !isBoolean && !isNumber) {
      throw new CartError("validation", "Customisation values must be short strings, numbers or booleans.");
    }
    out[key] = item as CustomisationValue;
  }
  return out;
}

export function createCartService(deps: CartServiceDeps): CartService {
  const { storage, catalog, lock, now } = deps;

  function requireEnabled(): void {
    ensureEnabled(deps.enabled);
  }

  async function loadCart(store: CartStorage, companyId: string, cartId: string): Promise<CartRecord> {
    const cart = await store.getCart(companyId, requireText(cartId, "cart_id"));
    if (!cart) {
      throw new CartError("not_found", "Cart not found.");
    }
    return cart;
  }

  function assertMutable(cart: CartRecord, at: Date): void {
    if (cart.status !== "active") {
      throw new CartError("cart_closed", "This cart can no longer be changed.");
    }
    if (cart.expiresAt.getTime() <= at.getTime()) {
      throw new CartError("cart_expired", "This cart has expired.");
    }
  }

  function withLines(cart: CartRecord, lines: readonly CartLine[], currency: string | null, at: Date): CartRecord {
    const totals = computeTotals(lines);
    return {
      ...cart,
      lines,
      currency,
      subtotalMinor: totals.subtotalMinor,
      discountMinor: totals.discountMinor,
      totalMinor: totals.totalMinor,
      version: cart.version + 1,
      expiresAt: addDays(at, deps.cartTtlDays),
      updatedAt: at,
    };
  }

  interface LineChange {
    readonly lines: readonly CartLine[];
    readonly currency: string | null;
  }

  /**
   * The shared write path for every cart mutation. Under the cart lock, and inside one storage transaction,
   * it checks the idempotency key first, then the closed or expired state, then applies the change, then
   * records the operation. Like the PHP, a replayed key returns the current cart and does not apply the change again.
   */
  async function mutate(
    companyId: string,
    cartId: string,
    operation: string,
    payload: unknown,
    idempotencyKey: string | null | undefined,
    build: (cart: CartRecord) => Promise<LineChange>,
  ): Promise<CartRecord> {
    requireEnabled();
    const tenant = requireCompanyId(companyId);
    const key = normaliseIdempotencyKey(idempotencyKey, false);
    const requestHash = hashRequest(operation, payload);

    return lock(cartLockKey(tenant, requireText(cartId, "cart_id")), () =>
      storage.transaction(tenant, async (tx) => {
        const cart = await loadCart(tx, tenant, cartId);

        if (key !== null) {
          const existing = await tx.findCartOperation(tenant, cart.id, key);
          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw new CartError("idempotency_conflict", "The idempotency key was already used for a different cart operation.");
            }
            return cart;
          }
        }

        const at = now();
        assertMutable(cart, at);
        const change = await build(cart);
        const next = withLines(cart, change.lines, change.currency, at);
        await tx.putCart(tenant, next);

        if (key !== null) {
          await tx.putCartOperation(tenant, {
            companyId: tenant,
            cartId: cart.id,
            idempotencyKey: key,
            requestHash,
            operation,
            createdAt: at,
          });
        }
        return next;
      }),
    );
  }

  function findLine(cart: CartRecord, lineKey: string): CartLine {
    const line = cart.lines.find((candidate) => candidate.lineKey === lineKey);
    if (!line) {
      throw new CartError("not_found", "Cart line not found.");
    }
    return line;
  }

  return {
    async getOrCreateCart(scope) {
      requireEnabled();
      const tenant = requireCompanyId(scope.companyId);
      const chatbotId = requireText(scope.chatbotId, "chatbot_id");
      const conversationId = requireText(scope.conversationId, "conversation_id");

      return lock(conversationLockKey(tenant, conversationId), () =>
        storage.transaction(tenant, async (tx) => {
          const at = now();
          const active = await tx.findActiveCart(tenant, conversationId);
          if (active) {
            if (active.chatbotId !== chatbotId) {
              // The conversation belongs to another chatbot. Report it as missing, so existence is not leaked.
              throw new CartError("not_found", "Cart not found.");
            }
            if (active.expiresAt.getTime() > at.getTime()) {
              return active;
            }
            await tx.putCart(tenant, { ...active, status: "expired", updatedAt: at });
          }

          const cart: CartRecord = {
            id: randomUUID(),
            companyId: tenant,
            chatbotId,
            conversationId,
            customerId: scope.customerId ?? null,
            status: "active",
            currency: null,
            lines: [],
            subtotalMinor: 0,
            discountMinor: 0,
            totalMinor: 0,
            version: 0,
            expiresAt: addDays(at, deps.cartTtlDays),
            createdAt: at,
            updatedAt: at,
          };
          // If a concurrent first request won the race, the storage returns that cart instead of failing.
          const stored = await tx.insertActiveCartOrFind(tenant, cart);
          if (stored.chatbotId !== chatbotId) {
            throw new CartError("not_found", "Cart not found.");
          }
          return stored;
        }),
      );
    },

    async getCart(companyId, cartId) {
      requireEnabled();
      return loadCart(storage, requireCompanyId(companyId), cartId);
    },

    async addLine(companyId, cartId, input, idempotencyKey) {
      const variantId = requireText(input.variantId, "variant_id");
      const quantity = normaliseQuantity(input.quantity ?? 1);
      const customisation = normaliseCustomisation(input.customisation ?? {});
      const payload = { variantId, quantity, customisation };

      return mutate(companyId, cartId, "line.add", payload, idempotencyKey, async (cart) => {
        const variant = await catalog.findVariant(cart.companyId, variantId);
        if (!variant || !variant.active || variant.chatbotId !== cart.chatbotId) {
          throw new CartError("variant_unavailable", "The selected product variant is unavailable for this storefront.");
        }
        if (cart.currency !== null && cart.currency !== variant.currency) {
          throw new CartError("currency_mismatch", "All lines in a cart must use the same currency.");
        }

        const lineKey = makeLineKey(variantId, customisation);
        const existing = cart.lines.find((line) => line.lineKey === lineKey);
        const nextQuantity = normaliseQuantity((existing?.quantity ?? 0) + quantity);
        const line: CartLine = {
          lineKey,
          variantId,
          productId: variant.productId,
          sku: variant.sku,
          name: variant.name,
          quantity: nextQuantity,
          unitPriceMinor: variant.unitPriceMinor,
          lineTotalMinor: lineTotalMinor(variant.unitPriceMinor, nextQuantity),
          currency: variant.currency,
          customisation,
        };
        const lines = existing
          ? cart.lines.map((candidate) => (candidate.lineKey === lineKey ? line : candidate))
          : [...cart.lines, line];
        return { lines, currency: variant.currency };
      });
    },

    async setLineQuantity(companyId, cartId, lineKey, quantity, idempotencyKey) {
      const key = requireText(lineKey, "line_key");
      const nextQuantity = normaliseQuantity(quantity);

      return mutate(companyId, cartId, "line.set", { lineKey: key, quantity: nextQuantity }, idempotencyKey, async (cart) => {
        const target = findLine(cart, key);
        const updated: CartLine = {
          ...target,
          quantity: nextQuantity,
          lineTotalMinor: lineTotalMinor(target.unitPriceMinor, nextQuantity),
        };
        return {
          lines: cart.lines.map((line) => (line.lineKey === key ? updated : line)),
          currency: cart.currency,
        };
      });
    },

    async removeLine(companyId, cartId, lineKey, idempotencyKey) {
      const key = requireText(lineKey, "line_key");
      return mutate(companyId, cartId, "line.remove", { lineKey: key }, idempotencyKey, async (cart) => {
        findLine(cart, key);
        return {
          lines: cart.lines.filter((line) => line.lineKey !== key),
          currency: cart.currency,
        };
      });
    },

    async clear(companyId, cartId, idempotencyKey) {
      return mutate(companyId, cartId, "cart.clear", {}, idempotencyKey, async (cart) => ({
        lines: [],
        currency: cart.currency,
      }));
    },
  };
}
