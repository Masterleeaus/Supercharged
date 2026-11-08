/**
 * Read-only adapters for the conversational commerce runtime. They wrap the public functions of the cart, orders
 * and marketplace slices. They never change a row.
 *
 * Tenancy: every call carries companyId. A record whose companyId or chatbotId differs from the request is
 * treated as absent (null or an empty list), never as an error that reveals it exists.
 *
 * Customer scope: these adapters scope by session and optional customer identity only. Whether a verified
 * identity may see order facts is decided by the communications layer, not here.
 */
import type { CartRecord, CartService } from "../../cart/index.ts";
import { CartError } from "../../cart/index.ts";
import type { OrderRecord, OrderService } from "../../orders/index.ts";
import type { ListingView, MarketplaceReadRuntime, ReadProviderError } from "../marketplace/index.ts";
import { CommerceError } from "./errors.ts";

export const CATALOGUE_MAX_RESULTS = 20;
export const CATALOGUE_MAX_KEYWORDS = 200;
export const ORDER_LOOKUP_WINDOW = 100;

export interface CartLineView {
  lineKey: string;
  name: string;
  sku: string | null;
  quantity: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  currency: string;
}

export interface CartReadView {
  cartId: string;
  status: string;
  currency: string | null;
  lines: CartLineView[];
  subtotalMinor: number;
  discountMinor: number;
  totalMinor: number;
  version: number;
}

export interface CartReader {
  /**
   * Returns the active cart for this shopping session, or null when the cart is not visible to this company
   * and chatbot. Uses the cart service's getOrCreateCart, as the PHP getCart did, so a session with no cart
   * gets an empty one.
   */
  readSessionCart(companyId: string, chatbotId: string, sessionId: string): Promise<CartReadView | null>;
}

export function createCartReader(cart: Pick<CartService, "getOrCreateCart">): CartReader {
  return {
    async readSessionCart(companyId, chatbotId, sessionId) {
      requireId(companyId, "company_id");
      requireId(chatbotId, "chatbot_id");
      requireId(sessionId, "session_id");
      let record: CartRecord;
      try {
        record = await cart.getOrCreateCart({ companyId, chatbotId, conversationId: sessionId.trim() });
      } catch (error) {
        if (error instanceof CartError && error.code === "not_found") return null;
        throw error;
      }
      if (record.companyId !== companyId || record.chatbotId !== chatbotId) return null;
      return toCartView(record);
    },
  };
}

function toCartView(record: CartRecord): CartReadView {
  return {
    cartId: record.id,
    status: record.status,
    currency: record.currency,
    lines: record.lines.map((line) => ({
      lineKey: line.lineKey,
      name: line.name,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceMinor: line.unitPriceMinor,
      lineTotalMinor: line.lineTotalMinor,
      currency: line.currency,
    })),
    subtotalMinor: record.subtotalMinor,
    discountMinor: record.discountMinor,
    totalMinor: record.totalMinor,
    version: record.version,
  };
}

export interface OrderSummaryView {
  id: string;
  orderNumber: string;
  status: string;
  fulfillmentStatus: string;
  currency: string;
  totalMinor: number;
  placedAt: Date;
}

export interface OrderScope {
  sessionId: string;
  customerIdentityId?: string | null;
}

export interface OrderReader {
  listSessionOrders(companyId: string, chatbotId: string, scope: OrderScope, limit?: number): Promise<OrderSummaryView[]>;
  /** Exact order number match, inside the same scope. Null when absent or outside the scope. */
  findSessionOrder(companyId: string, chatbotId: string, orderNumber: string, scope: OrderScope): Promise<OrderSummaryView | null>;
}

export function createOrderReader(orders: Pick<OrderService, "listOrdersForSession">): OrderReader {
  async function load(companyId: string, chatbotId: string, scope: OrderScope, limit: number): Promise<OrderRecord[]> {
    requireId(companyId, "company_id");
    requireId(chatbotId, "chatbot_id");
    requireId(scope.sessionId, "session_id");
    const rows = await orders.listOrdersForSession(
      companyId,
      { chatbotId, sessionId: scope.sessionId.trim(), customerIdentityId: scope.customerIdentityId ?? null },
      { limit, offset: 0 },
    );
    return rows.filter((row) => row.companyId === companyId && row.chatbotId === chatbotId);
  }

  return {
    async listSessionOrders(companyId, chatbotId, scope, limit = 20) {
      const capped = Math.min(Math.max(Math.trunc(limit), 1), ORDER_LOOKUP_WINDOW);
      return (await load(companyId, chatbotId, scope, capped)).map(toOrderSummary);
    },

    async findSessionOrder(companyId, chatbotId, orderNumber, scope) {
      const wanted = orderNumber.trim();
      if (wanted === "") return null;
      const match = (await load(companyId, chatbotId, scope, ORDER_LOOKUP_WINDOW)).find((row) => row.orderNumber === wanted);
      return match ? toOrderSummary(match) : null;
    },
  };
}

function toOrderSummary(row: OrderRecord): OrderSummaryView {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    status: row.status,
    fulfillmentStatus: row.fulfillmentStatus,
    currency: row.currency,
    totalMinor: row.total,
    placedAt: row.placedAt,
  };
}

export interface CatalogueListingView {
  connectionId: string;
  provider: string;
  externalListingId: string;
  title: string;
  priceMinor: number;
  currency: string;
  quantity: number | null;
}

export interface CatalogueSearchResult {
  rows: CatalogueListingView[];
  errors: ReadProviderError[];
}

export interface CatalogueReader {
  /** Searches listings through the marketplace read runtime (provider calls, rate limited by that runtime). */
  search(companyId: string, keywords: string, limit?: number): Promise<CatalogueSearchResult>;
  /** Reads the stored listing snapshot only. Makes no provider call. */
  lookup(companyId: string, connectionId: string, externalListingId: string): Promise<CatalogueListingView | null>;
}

export function createCatalogueReader(read: Pick<MarketplaceReadRuntime, "searchListings" | "storedListing">): CatalogueReader {
  return {
    async search(companyId, keywords, limit = 8) {
      requireId(companyId, "company_id");
      const text = keywords.trim();
      if ([...text].length > CATALOGUE_MAX_KEYWORDS) throw new CommerceError("validation", "The search is too long.", { keywords: "too_long" });
      const capped = Math.min(Math.max(Math.trunc(limit), 1), CATALOGUE_MAX_RESULTS);
      const result = await read.searchListings(companyId, { keywords: text, limit: capped });
      return { rows: result.rows.map(toCatalogueView), errors: result.errors };
    },

    async lookup(companyId, connectionId, externalListingId) {
      requireId(companyId, "company_id");
      requireId(connectionId, "connection_id");
      requireId(externalListingId, "external_listing_id");
      const view = await read.storedListing(companyId, connectionId.trim(), externalListingId.trim());
      return view ? toCatalogueView(view) : null;
    },
  };
}

function toCatalogueView(view: ListingView): CatalogueListingView {
  return {
    connectionId: view.connectionId,
    provider: view.provider,
    externalListingId: view.listing.externalListingId,
    title: view.listing.title,
    priceMinor: view.listing.priceMinor,
    currency: view.listing.currency,
    quantity: view.listing.quantity,
  };
}

function requireId(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CommerceError("validation", `${field} is required.`, { [field]: "required" });
  }
}
