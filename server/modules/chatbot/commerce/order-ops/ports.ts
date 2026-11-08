/**
 * Ports this slice needs from other slices. The order-ops code depends on these shapes, never on another
 * slice's internals. Each port takes companyId first and returns null or an empty result for another
 * company's data.
 */
import type { HttpClient, MarketplaceProvider, MarketplaceProviderKey } from "../../contracts/index.ts";
import type { OrderDetail } from "../../orders/index.ts";
import type { InventoryService, StockView } from "../../fulfilment/index.ts";
import type { ConnectionScope } from "./types.ts";

/** Local stock for one variant, summed over the listed locations when no location is given. */
export interface CanonicalStock {
  quantity: number;
  reserved: number;
  committed: number;
  incoming: number;
  damaged: number;
  safetyStock: number;
  available: number;
  version: number;
}

export interface CanonicalStockReader {
  /** locationId null means every location of the variant, summed. Returns null when the variant has no stock rows. */
  read(companyId: string, variantId: string, locationId: string | null): Promise<CanonicalStock | null>;
}

/** Finds variants by exact SKU. The catalogue slice owns the lookup. */
export interface VariantLookup {
  idsBySku(companyId: string, sku: string): Promise<string[]>;
}

/** Resolves a marketplace provider implementation by key. Read-only providers still return a provider. */
export interface MarketplaceRegistry {
  get(key: MarketplaceProviderKey): MarketplaceProvider;
}

/** Lists native orders for one chatbot. The orders slice has no chatbot-wide list yet (see DECISIONS.md). */
export interface NativeOrderSource {
  listForChatbot(companyId: string, chatbotId: string): Promise<OrderDetail[]>;
}

/** Records a proposed marketplace stock change for seller approval. It never applies the change. */
export interface InventoryWriteProposer {
  propose(input: {
    companyId: string;
    connection: ConnectionScope;
    externalListingId: string;
    quantity: number;
    expectedSourceHash: string;
    idempotencyKey: string;
    actorUserId: string;
  }): Promise<{ proposalId: string }>;
}

/** Thin adapter over the fulfilment inventory service. Only the public availability() call is used. */
export function canonicalStockFromFulfilment(
  inventory: Pick<InventoryService, "availability">,
  locationsFor: (companyId: string, variantId: string) => Promise<string[]>,
): CanonicalStockReader {
  const fromView = (view: StockView): CanonicalStock => ({
    quantity: view.quantity,
    reserved: view.reserved,
    committed: view.committed,
    incoming: view.incoming,
    damaged: view.damaged,
    safetyStock: view.safetyStock,
    available: view.available,
    version: view.version,
  });
  return {
    async read(companyId, variantId, locationId) {
      if (locationId !== null) {
        const view = await inventory.availability(companyId, variantId, locationId);
        return fromView(view);
      }
      const locations = await locationsFor(companyId, variantId);
      if (locations.length === 0) return null;
      const views = await Promise.all(locations.map((id) => inventory.availability(companyId, variantId, id)));
      const sum = (pick: (v: StockView) => number) => views.reduce((total, v) => total + pick(v), 0);
      return {
        quantity: sum((v) => v.quantity),
        reserved: sum((v) => v.reserved),
        committed: sum((v) => v.committed),
        incoming: sum((v) => v.incoming),
        damaged: sum((v) => v.damaged),
        safetyStock: sum((v) => v.safetyStock),
        available: sum((v) => v.available),
        version: sum((v) => v.version),
      };
    },
  };
}

/**
 * Reads whether a communication thread exists for a chatbot. The conversational slice owns the thread table, so
 * order-ops reads it through this port and never writes to it. Null means absent or another company's thread.
 */
export interface CommunicationThreadPort {
  find(companyId: string, chatbotId: string, threadId: string): Promise<{ id: string; chatbotId: string } | null>;
}

export type { HttpClient };
