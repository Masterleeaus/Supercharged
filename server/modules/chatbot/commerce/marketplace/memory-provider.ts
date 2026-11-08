/**
 * In-memory marketplace provider for tests and local runs. It behaves like a marketplace: it keeps listings per
 * company and connection, checks the expected source hash, applies idempotent writes, and supports rollback. It
 * records every call it receives, so a test can check exactly what reached the provider. No network is used.
 */
import type {
  MarketplaceCapability,
  MarketplaceConnectionRef,
  MarketplaceInventoryLevel,
  MarketplaceListing,
  MarketplaceProvider,
  MarketplaceProviderKey,
  MarketplaceWriteResult,
  RateLimitHooks,
} from "../../contracts/index.ts";
import { canonicalJson, sha256Hex, type MarketplaceWriteOperation, type ProviderRollbackRequest, type ProviderWriteRequest } from "./operations.ts";

export interface MemoryProviderOptions {
  key?: MarketplaceProviderKey;
  rateLimit: RateLimitHooks;
  /** False builds a read-only provider. Default true. */
  writable?: boolean;
}

export interface ReceivedWrite {
  companyId: string;
  connectionId: string;
  request: ProviderWriteRequest | ProviderRollbackRequest;
}

export interface MemoryMarketplaceProvider extends MarketplaceProvider {
  /** Adds or replaces a listing, as if the marketplace already had it. Also used to simulate an outside change. */
  seed(companyId: string, connectionId: string, listing: { externalListingId: string; title: string; priceMinor: number; currency: string; quantity: number | null; raw?: Record<string, unknown> }): MarketplaceListing;
  /** Current stored listing, for assertions. */
  current(companyId: string, connectionId: string, externalListingId: string): MarketplaceListing | null;
  /** Every write and rollback the provider received, in order. */
  readonly writes: ReceivedWrite[];
  /** Every read the provider received, in order. */
  readonly reads: Array<{ companyId: string; connectionId: string; operation: string }>;
}

interface Stored {
  listing: MarketplaceListing;
}

function hashOf(listing: Omit<MarketplaceListing, "sourceHash">): string {
  return sha256Hex(canonicalJson(listing));
}

/** The part of a listing a write can change, saved so a rollback can restore it. Same shape as the runtime's before-state. */
function stateFor(operation: MarketplaceWriteOperation, listing: MarketplaceListing): Record<string, unknown> {
  const attributes = (listing.raw.attributes ?? {}) as Record<string, unknown>;
  switch (operation) {
    case "update_price":
      return { priceMinor: listing.priceMinor, currency: listing.currency };
    case "update_inventory":
      return { quantity: Math.max(0, listing.quantity ?? 0) };
    case "update_listing":
      return { title: listing.title, description: String(listing.raw.description ?? ""), attributes };
    case "pause_listing":
    case "resume_listing":
      return { status: String(listing.raw.status ?? "") };
  }
}

export function createMemoryMarketplaceProvider(options: MemoryProviderOptions): MemoryMarketplaceProvider {
  const key: MarketplaceProviderKey = options.key ?? "generic";
  const listings = new Map<string, Stored>();
  const results = new Map<string, MarketplaceWriteResult>();
  const writes: ReceivedWrite[] = [];
  const reads: Array<{ companyId: string; connectionId: string; operation: string }> = [];
  const lKey = (companyId: string, connectionId: string, externalListingId: string) => `${companyId}\u0000${connectionId}\u0000${externalListingId}`;

  function find(ref: MarketplaceConnectionRef, externalListingId: string): Stored | null {
    return listings.get(lKey(ref.companyId, ref.connectionId, externalListingId)) ?? null;
  }

  function build(
    base: { externalListingId: string; title: string; priceMinor: number; currency: string; quantity: number | null; raw: Record<string, unknown> },
  ): MarketplaceListing {
    const shape = { externalListingId: base.externalListingId, title: base.title, priceMinor: base.priceMinor, currency: base.currency, quantity: base.quantity, raw: base.raw };
    return { ...shape, sourceHash: hashOf(shape) };
  }

  function applyTo(listing: MarketplaceListing, operation: MarketplaceWriteOperation, changes: Record<string, unknown>): MarketplaceListing {
    const raw = { ...listing.raw };
    let { title, priceMinor, currency, quantity } = listing;
    switch (operation) {
      case "update_price":
        priceMinor = Number(changes.priceMinor);
        currency = String(changes.currency ?? currency);
        break;
      case "update_inventory":
        quantity = Number(changes.quantity);
        break;
      case "update_listing":
        if (typeof changes.title === "string") title = changes.title;
        if (typeof changes.description === "string") raw.description = changes.description;
        if (changes.attributes !== undefined && typeof changes.attributes === "object" && changes.attributes !== null) raw.attributes = changes.attributes;
        break;
      case "pause_listing":
        raw.status = "paused";
        break;
      case "resume_listing":
        raw.status = "active";
        break;
    }
    return build({ externalListingId: listing.externalListingId, title, priceMinor, currency, quantity, raw });
  }

  function remember(idempotencyKey: string, result: MarketplaceWriteResult): MarketplaceWriteResult {
    results.set(idempotencyKey, result);
    return result;
  }

  return {
    key,
    capabilities: (): MarketplaceCapability[] => ["read_listings", "read_inventory", "import_orders", "write_listing", "write_inventory", "write_price"],
    rateLimit: options.rateLimit,
    writes,
    reads,

    seed(companyId, connectionId, listing) {
      const built = build({ externalListingId: listing.externalListingId, title: listing.title, priceMinor: listing.priceMinor, currency: listing.currency, quantity: listing.quantity, raw: listing.raw ?? {} });
      listings.set(lKey(companyId, connectionId, listing.externalListingId), { listing: built });
      return built;
    },

    current(companyId, connectionId, externalListingId) {
      const stored = listings.get(lKey(companyId, connectionId, externalListingId));
      return stored ? structuredClone(stored.listing) : null;
    },

    read: {
      async searchListings(ref, query) {
        reads.push({ companyId: ref.companyId, connectionId: ref.connectionId, operation: "search" });
        const rows = [...listings.entries()]
          .filter(([k]) => k.startsWith(`${ref.companyId}\u0000${ref.connectionId}\u0000`))
          .map(([, stored]) => structuredClone(stored.listing))
          .slice(0, query.limit);
        return { rows, nextCursor: null };
      },
      async getListing(ref, externalListingId) {
        reads.push({ companyId: ref.companyId, connectionId: ref.connectionId, operation: "get" });
        const stored = find(ref, externalListingId);
        return stored ? structuredClone(stored.listing) : null;
      },
      async getInventory(ref, externalListingIds): Promise<MarketplaceInventoryLevel[]> {
        reads.push({ companyId: ref.companyId, connectionId: ref.connectionId, operation: "inventory" });
        return externalListingIds.flatMap((id) => {
          const stored = find(ref, id);
          return stored && stored.listing.quantity !== null ? [{ externalListingId: id, quantity: stored.listing.quantity }] : [];
        });
      },
      async importOrders() {
        reads.push({ companyId: "", connectionId: "", operation: "orders" });
        return { orders: [], nextCursor: null };
      },
    },

    write: options.writable === false
      ? null
      : {
          async execute(ref, request) {
            writes.push({ companyId: ref.companyId, connectionId: ref.connectionId, request: structuredClone(request) as ProviderWriteRequest });
            const replay = results.get(`${ref.companyId}\u0000${request.idempotencyKey}`);
            if (replay) return replay;
            const stored = find(ref, request.externalListingId);
            if (!stored) return { status: "rejected", errorCode: "not_found", message: "Listing not found." };
            if (stored.listing.sourceHash !== request.expectedSourceHash) {
              return { status: "conflict", currentSourceHash: stored.listing.sourceHash };
            }
            const operation = (request as ProviderWriteRequest).providerOperation;
            const rollbackState = stateFor(operation, stored.listing);
            const next = applyTo(stored.listing, operation, request.changes);
            listings.set(lKey(ref.companyId, ref.connectionId, request.externalListingId), { listing: next });
            return remember(`${ref.companyId}\u0000${request.idempotencyKey}`, { status: "applied", sourceHash: next.sourceHash, rollbackState });
          },
          async rollback(ref, request) {
            writes.push({ companyId: ref.companyId, connectionId: ref.connectionId, request: structuredClone(request) as ProviderRollbackRequest });
            const replay = results.get(`${ref.companyId}\u0000${request.idempotencyKey}`);
            if (replay) return replay;
            const stored = find(ref, request.externalListingId);
            if (!stored) return { status: "rejected", errorCode: "not_found", message: "Listing not found." };
            if (stored.listing.sourceHash !== request.expectedSourceHash) {
              return { status: "conflict", currentSourceHash: stored.listing.sourceHash };
            }
            const operation = (request as ProviderRollbackRequest).providerOperation;
            const next = applyTo(stored.listing, operation, (request as ProviderRollbackRequest).rollbackState);
            listings.set(lKey(ref.companyId, ref.connectionId, request.externalListingId), { listing: next });
            return remember(`${ref.companyId}\u0000${request.idempotencyKey}`, { status: "applied", sourceHash: next.sourceHash, rollbackState: {} });
          },
        },
  };
}
