/**
 * Conversational commerce: the shopping flow the bot runs with a shopper.
 *
 * Port of ConversationalCommerceRuntime.php. Read tools (search, product, compare, cart, order) run at once.
 * Change tools (add to cart, coupon, checkout, return) only PROPOSE: they store an action and return an approval
 * card. Nothing changes until the shopper confirms with the one-time token (confirm()).
 *
 * All storage goes through injected ports. Every port call carries companyId.
 */
import { CommerceError } from "./errors.ts";
import { approvalCard, cartCard, productCards, type CartCardView, type ProductView } from "./cards.ts";
import {
  claimForExecution,
  completeAction,
  failAction,
  proposeAction,
  type ApprovalActionStore,
  type PublicApprovalAction,
} from "./approval-gate.ts";
import type { ApproverActor } from "./authority.ts";
import type { ApprovedActionResult } from "./types.ts";

export interface ShoppingSessionState {
  companyId: string;
  chatbotId: string;
  sessionId: string;
  currentProductIds: number[];
  selectedProductId: number | null;
  selectedVariantId: number | null;
  lastQuery: string | null;
  customerId: number | null;
  contextVersion: number;
}

export interface ShoppingSessionStore {
  load(companyId: string, chatbotId: string, sessionId: string): Promise<ShoppingSessionState | null>;
  save(state: ShoppingSessionState): Promise<void>;
}

export interface CatalogPort {
  search(companyId: string, chatbotId: string, query: string, limit: number): Promise<ProductView[]>;
  findProducts(companyId: string, chatbotId: string, productIds: number[]): Promise<ProductView[]>;
}

export interface CartRecord extends CartCardView {
  sessionId: string;
  version: number;
}

export interface CartPort {
  getOrCreate(companyId: string, chatbotId: string, sessionId: string): Promise<CartRecord>;
  addLine(companyId: string, cartId: string, variantId: number, quantity: number, idempotencyKey: string): Promise<CartRecord>;
  applyCoupon(companyId: string, cartId: string, code: string, idempotencyKey: string): Promise<CartRecord>;
}

export interface BudgetPort {
  /** Throws a CommerceError when the prospective total breaks a spend limit. */
  assertAllowed(companyId: string, chatbotId: string, sessionId: string, totalMinor: number, currency: string): Promise<void>;
}

export interface CheckoutPort {
  prepare(companyId: string, cartId: string, cartVersion: number, idempotencyKey: string): Promise<{ checkoutId: string; status: string; totalMinor: number; currency: string }>;
}

export interface OrderView {
  id: string;
  companyId: string;
  orderNumber: string;
  status: string;
  sessionId: string | null;
  customerId: number | null;
  totalMinor: number;
  currency: string;
}

export interface OrderPort {
  /** Returns the order only when it belongs to this session or this customer. Null otherwise. */
  findScoped(companyId: string, chatbotId: string, orderNumber: string, scope: { sessionId: string; customerId: number | null }): Promise<OrderView | null>;
  requestReturn(companyId: string, orderId: string, items: unknown[], resolution: string, reason: string | null, customerId: number | null): Promise<{ rmaNumber: string; status: string; requestedAmountMinor: number; currency: string }>;
}

export interface ConversationalDeps {
  approvals: ApprovalActionStore;
  sessions: ShoppingSessionStore;
  catalog: CatalogPort;
  cart: CartPort;
  budget: BudgetPort;
  checkout: CheckoutPort;
  orders: OrderPort;
  now: () => Date;
  newId: () => string;
  /** Minutes a proposed action stays confirmable. */
  ttlMinutes?: number;
}

export interface Confirmation {
  actionId: string;
  approvalToken: string | null;
  approver: ApproverActor;
  approverId: string;
}

const MAX_SEARCH_RESULTS = 20;
const MAX_COMPARE = 4;

function requireSession(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (trimmed === "") throw new CommerceError("validation", "A shopping session ID is required.", { session_id: "required" });
  return trimmed;
}

/** Port of ConversationContextStack::requireProductReference. An explicit id is trusted; the scoped lookup is the guard. */
function requireProductReference(state: ShoppingSessionState, explicit: number | null | undefined): number | null {
  if (explicit !== null && explicit !== undefined && explicit > 0) return explicit;
  if (state.selectedProductId !== null && state.selectedProductId > 0) return state.selectedProductId;
  return state.currentProductIds.length === 1 ? (state.currentProductIds[0] ?? null) : null;
}

function requireVariantReference(state: ShoppingSessionState, explicit: number | null | undefined): number | null {
  if (explicit !== null && explicit !== undefined && explicit > 0) return explicit;
  return state.selectedVariantId !== null && state.selectedVariantId > 0 ? state.selectedVariantId : null;
}

export function createConversationalCommerce(deps: ConversationalDeps) {
  const ttl = deps.ttlMinutes ?? 15;

  async function stateFor(companyId: string, chatbotId: string, sessionId: string): Promise<ShoppingSessionState> {
    const existing = await deps.sessions.load(companyId, chatbotId, sessionId);
    if (existing) return existing;
    return { companyId, chatbotId, sessionId, currentProductIds: [], selectedProductId: null, selectedVariantId: null, lastQuery: null, customerId: null, contextVersion: 0 };
  }

  async function saveState(state: ShoppingSessionState, patch: Partial<ShoppingSessionState>): Promise<ShoppingSessionState> {
    const next = { ...state, ...patch, contextVersion: state.contextVersion + 1 };
    await deps.sessions.save(next);
    return next;
  }

  async function propose(
    companyId: string,
    chatbotId: string,
    sessionId: string,
    actionType: string,
    payload: Record<string, unknown>,
    message: string,
    amountMinor: number | null,
    currency: string | null,
  ): Promise<{ status: "awaiting_approval"; action: PublicApprovalAction; approvalToken: string | null; ui: Record<string, unknown> }> {
    const proposed = await proposeAction(
      deps.approvals,
      deps.now(),
      { companyId, chatbotId, scope: "conversational", subjectId: sessionId, actionType, authorityLevel: "require_approval", payload, idempotencyKey: deps.newId(), amountMinor, currency, ttlMinutes: ttl },
      deps.newId,
    );
    return { status: "awaiting_approval", action: proposed.action, approvalToken: proposed.approvalToken, ui: approvalCard(proposed.action, message) };
  }

  return {
    /** Read tool. Remembers the exact result set so later references resolve against it. */
    async search(companyId: string, chatbotId: string, sessionId: string, query: string, limit = 8) {
      const sid = requireSession(sessionId);
      const products = await deps.catalog.search(companyId, chatbotId, query.trim(), Math.min(Math.max(limit, 1), MAX_SEARCH_RESULTS));
      const own = products.filter((p) => p.companyId === companyId && p.active);
      const ids = own.map((p) => p.id);
      const state = await stateFor(companyId, chatbotId, sid);
      const next = await saveState(state, { currentProductIds: ids, lastQuery: query.trim(), selectedProductId: ids.length === 1 ? (ids[0] ?? null) : null });
      return { level: "inform", status: "completed", data: own, ui: productCards(companyId, own), context: { currentProductIds: next.currentProductIds } };
    },

    async product(companyId: string, chatbotId: string, sessionId: string, productId: number | null) {
      const sid = requireSession(sessionId);
      const state = await stateFor(companyId, chatbotId, sid);
      const id = requireProductReference(state, productId);
      if (id === null) throw new CommerceError("validation", "The product reference is ambiguous. Select an exact product first.", { product_id: "ambiguous" });
      const [product] = await deps.catalog.findProducts(companyId, chatbotId, [id]);
      if (!product || product.companyId !== companyId || !product.active) throw new CommerceError("not_found", "The product was not found.");
      await saveState(state, { selectedProductId: id });
      return { level: "inform", status: "completed", data: product, ui: productCards(companyId, [product]) };
    },

    async compare(companyId: string, chatbotId: string, sessionId: string, productIds: number[]) {
      const sid = requireSession(sessionId);
      const ids = [...new Set(productIds.map((n) => Math.trunc(n)).filter((n) => n > 0))].slice(0, MAX_COMPARE);
      if (ids.length < 2) throw new CommerceError("validation", "Choose at least two exact products to compare.", { product_ids: "too_few" });
      await stateFor(companyId, chatbotId, sid);
      const products = (await deps.catalog.findProducts(companyId, chatbotId, ids)).filter((p) => p.companyId === companyId && p.active);
      return {
        level: "inform",
        status: "completed",
        data: products.map((p) => ({ id: p.id, name: p.name, price_minor: p.priceMinor, currency: p.currency, description: p.shortDescription, variants: p.variants })),
        ui: productCards(companyId, products),
      };
    },

    async getCart(companyId: string, chatbotId: string, sessionId: string) {
      const sid = requireSession(sessionId);
      const cart = await deps.cart.getOrCreate(companyId, chatbotId, sid);
      return { level: "inform", status: "completed", data: cart, ui: cartCard(cart, companyId) };
    },

    /** Proposes a cart addition. The cart is not touched here. */
    async prepareAddToCart(companyId: string, chatbotId: string, sessionId: string, input: { productId: number | null; variantId: number | null; quantity: number }) {
      const sid = requireSession(sessionId);
      const state = await stateFor(companyId, chatbotId, sid);
      const productId = requireProductReference(state, input.productId);
      if (productId === null) throw new CommerceError("validation", "Select the exact product before changing the cart.", { product_id: "ambiguous" });
      const [product] = await deps.catalog.findProducts(companyId, chatbotId, [productId]);
      if (!product || product.companyId !== companyId || !product.active) throw new CommerceError("not_found", "The product was not found.");
      const variantId = requireVariantReference(state, input.variantId) ?? (product.variants.length === 1 ? (product.variants[0]?.id ?? null) : null);
      const variant = variantId === null ? undefined : product.variants.find((v) => v.id === variantId);
      if (!variant) throw new CommerceError("validation", "Select an exact variant before changing the cart.", { variant_id: "required" });
      const quantity = Math.min(Math.max(Math.trunc(input.quantity), 1), 999);
      const cart = await deps.cart.getOrCreate(companyId, chatbotId, sid);
      await deps.budget.assertAllowed(companyId, chatbotId, sid, cart.totalMinor + variant.priceMinor * quantity, variant.currency || cart.currency || product.currency);
      return propose(companyId, chatbotId, sid, "add_to_cart", { product_id: productId, variant_id: variantId, quantity }, `Add ${quantity} x ${product.name}`, variant.priceMinor * quantity, variant.currency || product.currency);
    },

    async prepareCoupon(companyId: string, chatbotId: string, sessionId: string, code: string) {
      const sid = requireSession(sessionId);
      const normalised = code.trim().toUpperCase();
      if (normalised === "") throw new CommerceError("validation", "A coupon code is required.", { code: "required" });
      return propose(companyId, chatbotId, sid, "apply_coupon", { code: normalised }, `Apply coupon ${normalised}`, null, null);
    },

    async prepareCheckout(companyId: string, chatbotId: string, sessionId: string) {
      const sid = requireSession(sessionId);
      const cart = await deps.cart.getOrCreate(companyId, chatbotId, sid);
      if (cart.lines.length < 1) throw new CommerceError("validation", "The cart is empty.", { cart: "empty" });
      await deps.budget.assertAllowed(companyId, chatbotId, sid, cart.totalMinor, cart.currency ?? "");
      return propose(companyId, chatbotId, sid, "prepare_checkout", { cart_id: cart.id, cart_version: cart.version, total_minor: cart.totalMinor, currency: cart.currency }, `Prepare checkout for ${cart.currency ?? ""} ${(cart.totalMinor / 100).toFixed(2)}`, cart.totalMinor, cart.currency);
    },

    async prepareReturn(companyId: string, chatbotId: string, sessionId: string, input: { orderNumber: string; items: unknown[]; resolution: string; reason: string | null }) {
      const sid = requireSession(sessionId);
      const state = await stateFor(companyId, chatbotId, sid);
      const order = await deps.orders.findScoped(companyId, chatbotId, input.orderNumber.trim(), { sessionId: sid, customerId: state.customerId });
      if (!order) throw new CommerceError("not_found", "The order was not found.");
      return propose(companyId, chatbotId, sid, "request_return", { order_id: order.id, order_number: order.orderNumber, items: input.items, resolution: input.resolution, reason: input.reason }, `Request a return for order ${order.orderNumber}`, null, null);
    },

    /**
     * The only path that changes state. Requires the approval token (or staff authority), claims the action once,
     * runs it, then records the result. A failure is recorded and never retried silently.
     */
    async confirm(companyId: string, chatbotId: string, sessionId: string, c: Confirmation): Promise<ApprovedActionResult> {
      const sid = requireSession(sessionId);
      const before = await deps.approvals.findById(companyId, c.actionId);
      if (before === null || before.chatbotId !== chatbotId || before.subjectId !== sid || before.scope !== "conversational") {
        throw new CommerceError("not_found", "The action was not found.");
      }
      const claim = await claimForExecution(deps.approvals, deps.now(), companyId, c.actionId, c.approvalToken, c.approver, c.approverId);
      if (claim.state === "replay") {
        return { status: "completed", replay: true, actionId: c.actionId, result: claim.action.result ?? {} };
      }

      const action = claim.action;
      const payload = action.payload;
      try {
        let result: Record<string, unknown>;
        switch (action.actionType) {
          case "add_to_cart": {
            const cart = await deps.cart.getOrCreate(companyId, chatbotId, sid);
            const variantId = Number(payload.variant_id);
            const quantity = Number(payload.quantity);
            const [product] = await deps.catalog.findProducts(companyId, chatbotId, [Number(payload.product_id)]);
            const variant = product?.variants.find((v) => v.id === variantId);
            if (!variant) throw new CommerceError("validation", "The variant is no longer available.", { variant_id: "unavailable" });
            await deps.budget.assertAllowed(companyId, chatbotId, sid, cart.totalMinor + variant.priceMinor * quantity, variant.currency || cart.currency || "");
            const updated = await deps.cart.addLine(companyId, cart.id, variantId, quantity, `approved:${action.id}`);
            result = { type: "cart_line_added", cart: summariseCart(updated) };
            break;
          }
          case "apply_coupon": {
            const cart = await deps.cart.getOrCreate(companyId, chatbotId, sid);
            const updated = await deps.cart.applyCoupon(companyId, cart.id, String(payload.code), `approved:${action.id}`);
            result = { type: "coupon_applied", cart: summariseCart(updated) };
            break;
          }
          case "prepare_checkout": {
            const cart = await deps.cart.getOrCreate(companyId, chatbotId, sid);
            await deps.budget.assertAllowed(companyId, chatbotId, sid, cart.totalMinor, cart.currency ?? "");
            const checkout = await deps.checkout.prepare(companyId, cart.id, cart.version, `approved:${action.id}`);
            result = { type: "checkout_prepared", checkout };
            break;
          }
          case "request_return": {
            const state = await stateFor(companyId, chatbotId, sid);
            const order = await deps.orders.findScoped(companyId, chatbotId, String(payload.order_number), { sessionId: sid, customerId: state.customerId });
            if (!order) throw new CommerceError("not_found", "The order was not found.");
            const ret = await deps.orders.requestReturn(companyId, order.id, Array.isArray(payload.items) ? payload.items : [], String(payload.resolution), payload.reason === null || payload.reason === undefined ? null : String(payload.reason), state.customerId);
            result = { type: "return_requested", return: ret };
            break;
          }
          default:
            throw new CommerceError("unsupported", "The approved action type is not supported.", { action: "unsupported" });
        }
        const done = await completeAction(deps.approvals, deps.now(), companyId, action.id, c.approverId, result);
        if (!done) throw new CommerceError("conflict", "The action was already recorded.");
        return { status: "completed", replay: false, actionId: action.id, result };
      } catch (error) {
        const reason = error instanceof CommerceError ? error.message : "The commerce action could not be completed.";
        await failAction(deps.approvals, deps.now(), companyId, action.id, reason);
        throw error instanceof CommerceError ? error : new CommerceError("validation", reason);
      }
    },
  };
}

function summariseCart(cart: CartRecord): Record<string, unknown> {
  return { id: cart.id, total_minor: cart.totalMinor, currency: cart.currency, line_count: cart.lines.length };
}

