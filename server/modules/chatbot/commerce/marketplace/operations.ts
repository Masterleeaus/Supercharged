/**
 * Marketplace operations, capability mapping, write patch rules, state machines and bulk helpers.
 * Port of Support/MarketplaceWriteOperation.php, MarketplaceCapability.php, MarketplaceWritePatch.php,
 * MarketplaceWriteState.php, MarketplaceBulkState.php, MarketplaceBulkSelector.php, MarketplaceBulkImpact.php.
 * Pure: no storage, no clock, no companyId.
 */
import { createHash } from "node:crypto";
import type { MarketplaceCapability, MarketplaceWriteRequest } from "../../contracts/index.ts";
import { MarketplaceError } from "./errors.ts";

// ---------------------------------------------------------------------------
// Write operations (PHP names). Mapped to the contract's MarketplaceCapability when sent to a provider.
// ---------------------------------------------------------------------------

export const WRITE_OPERATIONS = ["update_listing", "update_price", "update_inventory", "pause_listing", "resume_listing"] as const;
export type MarketplaceWriteOperation = (typeof WRITE_OPERATIONS)[number];

const OPERATION_CAPABILITY: Readonly<Record<MarketplaceWriteOperation, MarketplaceCapability>> = {
  update_listing: "write_listing",
  update_price: "write_price",
  update_inventory: "write_inventory",
  pause_listing: "write_listing",
  resume_listing: "write_listing",
};

export function normaliseWriteOperation(operation: string): MarketplaceWriteOperation {
  const value = operation.trim().toLowerCase();
  if (!(WRITE_OPERATIONS as readonly string[]).includes(value)) {
    throw new MarketplaceError("invalid_changes", "Unsupported marketplace write operation.");
  }
  return value as MarketplaceWriteOperation;
}

export function capabilityForOperation(operation: MarketplaceWriteOperation): MarketplaceCapability {
  return OPERATION_CAPABILITY[operation];
}

export function isWriteCapability(capability: string): boolean {
  return capability.startsWith("write_");
}

/**
 * What a provider receives for one write. The contract's `operation` is the capability, and pause and resume
 * share one capability, so the runtime also sends the PHP operation name. This is an additive field
 * (change request against contracts/commerce.ts, see DECISIONS.md). It carries no confirmation token.
 */
export type ProviderWriteRequest = MarketplaceWriteRequest & { providerOperation: MarketplaceWriteOperation };
export type ProviderRollbackRequest = ProviderWriteRequest & { rollbackState: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Canonical JSON and hashing (used for action hashes and source hashes)
// ---------------------------------------------------------------------------

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalise((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalise(value));
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Write patch rules (MarketplaceWritePatch.php). Camel-case keys in TypeScript.
// ---------------------------------------------------------------------------

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export function sanitiseChanges(operation: MarketplaceWriteOperation, changes: Record<string, unknown>): Record<string, unknown> {
  switch (operation) {
    case "update_price": {
      if (!("priceMinor" in changes)) throw invalid("priceMinor is required for a marketplace price update.");
      const amount = changes.priceMinor;
      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
        throw invalid("priceMinor must be a non-negative integer in minor currency units.");
      }
      const currency = String(changes.currency ?? "").trim().toUpperCase();
      if (!CURRENCY_PATTERN.test(currency)) throw invalid("currency must be a three-letter ISO currency code.");
      return { priceMinor: amount, currency };
    }
    case "update_inventory": {
      if (!("quantity" in changes)) throw invalid("quantity is required for a marketplace inventory update.");
      const quantity = changes.quantity;
      if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 0) {
        throw invalid("quantity must be a non-negative integer.");
      }
      return { quantity };
    }
    case "update_listing": {
      const result: Record<string, unknown> = {};
      if ("title" in changes) {
        const title = String(changes.title).trim();
        if (title === "" || [...title].length > 500) throw invalid("title must contain between 1 and 500 characters.");
        result.title = title;
      }
      if ("description" in changes) {
        const description = String(changes.description).trim();
        if (description.length > 100000) throw invalid("description is too long.");
        result.description = description;
      }
      if ("attributes" in changes) {
        const attributes = changes.attributes;
        if (attributes === null || typeof attributes !== "object" || Array.isArray(attributes)) {
          throw invalid("attributes must be an object.");
        }
        result.attributes = attributes;
      }
      if (Object.keys(result).length === 0) throw invalid("At least one supported listing field is required.");
      return result;
    }
    case "pause_listing":
    case "resume_listing":
      return {};
  }
}

export function changesHash(operation: MarketplaceWriteOperation, changes: Record<string, unknown>): string {
  return sha256Hex(canonicalJson({ operation, changes }));
}

function invalid(message: string): MarketplaceError {
  return new MarketplaceError("invalid_changes", message);
}

// ---------------------------------------------------------------------------
// Write proposal state machine (MarketplaceWriteState.php)
// ---------------------------------------------------------------------------

export const WRITE_STATES = [
  "prepared",
  "conflict_blocked",
  "approved",
  "queued",
  "executing",
  "executed",
  "failed",
  "cancelled",
  "rolled_back",
  "rollback_failed",
] as const;
export type WriteProposalStatus = (typeof WRITE_STATES)[number];

const WRITE_TRANSITIONS: Readonly<Partial<Record<WriteProposalStatus, readonly WriteProposalStatus[]>>> = {
  prepared: ["approved", "cancelled", "conflict_blocked"],
  conflict_blocked: ["prepared", "cancelled"],
  approved: ["queued", "executing", "cancelled", "conflict_blocked"],
  queued: ["executing", "failed", "cancelled", "conflict_blocked"],
  executing: ["executed", "failed", "conflict_blocked"],
  executed: ["rolled_back", "rollback_failed"],
  failed: ["approved", "cancelled", "conflict_blocked"],
  rollback_failed: ["rolled_back"],
};

export function canTransitionWrite(from: WriteProposalStatus, to: WriteProposalStatus): boolean {
  return (WRITE_TRANSITIONS[from] ?? []).includes(to);
}

// ---------------------------------------------------------------------------
// Bulk batch state (MarketplaceBulkState.php) and item status
// ---------------------------------------------------------------------------

export const BULK_STATES = [
  "draft",
  "ready",
  "conflict_blocked",
  "approved",
  "running",
  "partially_completed",
  "completed",
  "failed",
  "partially_rolled_back",
  "rolled_back",
  "cancelled",
] as const;
export type BulkBatchStatus = (typeof BULK_STATES)[number];

/** Per-item result. A failure on one item never changes another item's status. */
export const BULK_ITEM_STATES = ["ready", "blocked", "failed", "succeeded", "rolled_back", "rollback_failed"] as const;
export type BulkItemStatus = (typeof BULK_ITEM_STATES)[number];

// ---------------------------------------------------------------------------
// Bulk selection and price impact (MarketplaceBulkSelector.php, MarketplaceBulkImpact.php)
// ---------------------------------------------------------------------------

export interface BulkCandidate {
  externalListingId: string;
  provider: string;
  status: string;
  brand: string;
  category: string;
  priceMinor: number;
}

export interface BulkSelectionFilters {
  provider?: string | string[];
  status?: string | string[];
  brand?: string | string[];
  category?: string | string[];
  externalListingIds?: string | string[];
  minimumPriceMinor?: number;
  maximumPriceMinor?: number;
}

export function selectBulkCandidates(candidates: readonly BulkCandidate[], filters: BulkSelectionFilters): BulkCandidate[] {
  const multi = (value: unknown): string[] => {
    const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
    return list.map((item) => String(item).trim().toLowerCase()).filter((item) => item !== "");
  };
  const providers = multi(filters.provider);
  const statuses = multi(filters.status);
  const brands = multi(filters.brand);
  const categories = multi(filters.category);
  const ids = multi(filters.externalListingIds);
  const matches = (allowed: string[], actual: string): boolean => allowed.length === 0 || allowed.includes(actual.trim().toLowerCase());
  return candidates.filter(
    (c) =>
      matches(providers, c.provider) &&
      matches(statuses, c.status) &&
      matches(brands, c.brand) &&
      matches(categories, c.category) &&
      matches(ids, c.externalListingId) &&
      (filters.minimumPriceMinor === undefined || c.priceMinor >= filters.minimumPriceMinor) &&
      (filters.maximumPriceMinor === undefined || c.priceMinor <= filters.maximumPriceMinor),
  );
}

export type BulkPriceChange =
  | { mode: "set"; value: number }
  | { mode: "fixed_delta"; value: number }
  /** Basis points: 1000 means a 10.00 percent increase. Integer only (decision, see DECISIONS.md). */
  | { mode: "percentage_bps"; value: number };

export interface PriceImpact {
  before: number;
  after: number;
  delta: number;
}

export function priceImpact(before: number, change: BulkPriceChange): PriceImpact {
  let after: number;
  switch (change.mode) {
    case "set":
      after = Math.round(change.value);
      break;
    case "fixed_delta":
      after = before + Math.round(change.value);
      break;
    case "percentage_bps":
      if (!Number.isSafeInteger(change.value)) throw invalid("Bulk percentage must be an integer in basis points.");
      after = before + Math.round((before * change.value) / 10000);
      break;
  }
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new MarketplaceError("invalid_changes", "Bulk price changes cannot create a negative price.");
  }
  return { before, after, delta: after - before };
}
