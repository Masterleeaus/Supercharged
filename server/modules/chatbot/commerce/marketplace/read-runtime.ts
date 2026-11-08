/**
 * Marketplace read runtime: listing search and single-listing lookup through each MarketplaceProvider.
 * Port of MarketplaceReadRuntime.php (search fan-out, per-provider errors, listing snapshots).
 *
 * Company scoping: a connection is looked up with companyId first. A connection that belongs to another
 * company is treated as absent, so the lookup returns null and no provider is called.
 */
import { canonicalJson, sha256Hex } from "./operations.ts";
import { MarketplaceError } from "./errors.ts";
import { guardedCall } from "./outbound.ts";
import type { MarketplaceReadRegistry } from "./registry.ts";
import type { ListingRecord, MarketplaceStore } from "./store.ts";
import type { HttpClient, MarketplaceListing, MarketplaceProviderKey, RateLimitHooks } from "../../contracts/index.ts";

const READ_CAPABILITY = "read_listings";

export interface ListingView {
  connectionId: string;
  provider: MarketplaceProviderKey;
  listing: MarketplaceListing;
}

export interface ReadProviderError {
  connectionId: string;
  provider: MarketplaceProviderKey;
  code: "rate_limited" | "provider_unavailable";
}

export interface SearchResult {
  rows: ListingView[];
  errors: ReadProviderError[];
}

export interface ReadRuntimeDeps {
  store: MarketplaceStore;
  registry: MarketplaceReadRegistry;
  rateLimit: RateLimitHooks;
  http: HttpClient;
  clock: () => Date;
  /** Upper bound on rows taken from one provider. PHP default: maximum_results_per_provider = 50. */
  maxResultsPerProvider?: number;
}

export interface MarketplaceReadRuntime {
  searchListings(
    companyId: string,
    query: { keywords?: string; limit: number },
    options?: { providers?: MarketplaceProviderKey[] },
  ): Promise<SearchResult>;
  getListing(companyId: string, connectionId: string, externalListingId: string): Promise<ListingView | null>;
  /** Stored snapshot only. Makes no provider call. Company-scoped. */
  storedListing(companyId: string, connectionId: string, externalListingId: string): Promise<ListingView | null>;
}

export function createMarketplaceReadRuntime(deps: ReadRuntimeDeps): MarketplaceReadRuntime {
  const maxPerProvider = Math.max(1, deps.maxResultsPerProvider ?? 50);

  function toView(record: ListingRecord): ListingView {
    return { connectionId: record.connectionId, provider: record.provider, listing: record.listing };
  }

  function normaliseListing(listing: MarketplaceListing): MarketplaceListing {
    const sourceHash = listing.sourceHash && listing.sourceHash !== "" ? listing.sourceHash : sha256Hex(canonicalJson(listing));
    return { ...listing, sourceHash };
  }

  async function save(companyId: string, connectionId: string, provider: MarketplaceProviderKey, listing: MarketplaceListing): Promise<void> {
    const now = deps.clock();
    const previous = await deps.store.getListing(companyId, connectionId, listing.externalListingId);
    await deps.store.saveListing({
      companyId,
      connectionId,
      provider,
      externalListingId: listing.externalListingId,
      sourceHash: listing.sourceHash,
      listing,
      firstSeenAt: previous ? previous.firstSeenAt : now,
      lastSeenAt: now,
    });
  }

  return {
    async searchListings(companyId, query, options = {}) {
      const limit = Math.min(maxPerProvider, Math.max(1, Math.floor(query.limit)));
      const connections = (await deps.store.listConnections(companyId)).filter(
        (c) =>
          c.companyId === companyId &&
          c.active &&
          c.capabilities.includes(READ_CAPABILITY) &&
          (options.providers === undefined || options.providers.includes(c.provider)),
      );

      const rows: ListingView[] = [];
      const errors: ReadProviderError[] = [];
      for (const connection of connections) {
        const ref = { companyId, connectionId: connection.connectionId, provider: connection.provider };
        try {
          const page = await guardedCall(deps.rateLimit, companyId, connection.provider, READ_CAPABILITY, () =>
            deps.registry.get(connection.provider).read.searchListings(ref, { keywords: query.keywords, cursor: null, limit }, deps.http),
          );
          for (const raw of page.rows.slice(0, limit)) {
            if (raw.externalListingId === "") continue;
            const listing = normaliseListing(raw);
            await save(companyId, connection.connectionId, connection.provider, listing);
            rows.push({ connectionId: connection.connectionId, provider: connection.provider, listing });
          }
        } catch (error) {
          const code = error instanceof MarketplaceError && error.code === "rate_limited" ? "rate_limited" : "provider_unavailable";
          errors.push({ connectionId: connection.connectionId, provider: connection.provider, code });
        }
      }
      return { rows, errors };
    },

    async getListing(companyId, connectionId, externalListingId) {
      const connection = await deps.store.getConnection(companyId, connectionId);
      if (!connection || connection.companyId !== companyId || !connection.active || !connection.capabilities.includes(READ_CAPABILITY)) {
        return null;
      }
      const ref = { companyId, connectionId, provider: connection.provider };
      const found = await guardedCall(deps.rateLimit, companyId, connection.provider, READ_CAPABILITY, () =>
        deps.registry.get(connection.provider).read.getListing(ref, externalListingId, deps.http),
      );
      if (found === null) return null;
      if (found.externalListingId !== externalListingId) {
        throw new MarketplaceError("provider_mismatch", "The marketplace returned a different listing.");
      }
      const listing = normaliseListing(found);
      await save(companyId, connectionId, connection.provider, listing);
      return { connectionId, provider: connection.provider, listing };
    },

    async storedListing(companyId, connectionId, externalListingId) {
      const record = await deps.store.getListing(companyId, connectionId, externalListingId);
      if (!record || record.companyId !== companyId) return null;
      return toView(record);
    },
  };
}
