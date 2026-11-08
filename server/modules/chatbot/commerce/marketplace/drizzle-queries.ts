/**
 * Company-scoped Drizzle conditions for the marketplace tables. Each builder returns a condition, so a caller
 * can use it with db.select().from(table).where(...). Every condition starts with company_id. A missing or
 * empty companyId throws before any SQL is built.
 */
import { and, desc, eq, type SQL } from "drizzle-orm";
import {
  chatbotMarketplaceBulkBatches,
  chatbotMarketplaceBulkItems,
  chatbotMarketplaceListings,
  chatbotMarketplaceWriteProposals,
} from "../../db/commerce-marketplace.ts";
import { MarketplaceError } from "./errors.ts";

function requireCompany(companyId: string): string {
  if (typeof companyId !== "string" || companyId.trim() === "") {
    throw new MarketplaceError("forbidden", "A company is required for every marketplace query.");
  }
  return companyId;
}

export function listingWhere(companyId: string, connectionId: string, externalListingId: string): SQL | undefined {
  const t = chatbotMarketplaceListings;
  return and(
    eq(t.companyId, requireCompany(companyId)),
    eq(t.connectionId, connectionId),
    eq(t.externalListingId, externalListingId),
  );
}

/** Newest first. Use with .orderBy(listingOrder) and .limit(n). */
export function listingsForConnectionWhere(companyId: string, connectionId: string): SQL | undefined {
  const t = chatbotMarketplaceListings;
  return and(eq(t.companyId, requireCompany(companyId)), eq(t.connectionId, connectionId));
}

export const listingOrder = desc(chatbotMarketplaceListings.lastSeenAt);

export function proposalWhere(companyId: string, id: string): SQL | undefined {
  const t = chatbotMarketplaceWriteProposals;
  return and(eq(t.companyId, requireCompany(companyId)), eq(t.id, id));
}

export function proposalByKeyWhere(companyId: string, connectionId: string, idempotencyKey: string): SQL | undefined {
  const t = chatbotMarketplaceWriteProposals;
  return and(
    eq(t.companyId, requireCompany(companyId)),
    eq(t.connectionId, connectionId),
    eq(t.idempotencyKey, idempotencyKey),
  );
}

export function batchWhere(companyId: string, id: string): SQL | undefined {
  const t = chatbotMarketplaceBulkBatches;
  return and(eq(t.companyId, requireCompany(companyId)), eq(t.id, id));
}

export function batchByKeyWhere(companyId: string, connectionId: string, idempotencyKey: string): SQL | undefined {
  const t = chatbotMarketplaceBulkBatches;
  return and(
    eq(t.companyId, requireCompany(companyId)),
    eq(t.connectionId, connectionId),
    eq(t.idempotencyKey, idempotencyKey),
  );
}

export function batchItemsWhere(companyId: string, batchId: string): SQL | undefined {
  const t = chatbotMarketplaceBulkItems;
  return and(eq(t.companyId, requireCompany(companyId)), eq(t.batchId, batchId));
}
