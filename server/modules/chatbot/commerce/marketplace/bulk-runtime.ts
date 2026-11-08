/**
 * Bulk marketplace writes: preview, confirm, execute and rollback over a selection of listings.
 * Port of MarketplaceBulkRuntime.php with these rules (see DECISIONS.md):
 *
 * - Off unless bulk is enabled AND the write flag is on. PHP's allow_bulk_writes is kept as bulkEnabled.
 * - Size cap: a selection larger than maxItems is refused at preview. PHP silently sliced it instead.
 * - Spend cap: the sum of absolute price changes must stay within maxBulkAbsDeltaMinor (new check).
 * - One batch token confirms the whole batch. Each item is still checked and executed on its own.
 * - Per-item results: a failure on one item is recorded on that item only. Other items still run.
 */
import { randomUUID } from "node:crypto";
import { type FlagEnv, type MarketplaceProviderKey } from "../../contracts/index.ts";
import { MarketplaceError } from "./errors.ts";
import { hashToken, sameDigest, type ApprovalSigner } from "./approval.ts";
import {
  canonicalJson,
  normaliseWriteOperation,
  priceImpact,
  selectBulkCandidates,
  sha256Hex,
  type BulkBatchStatus,
  type BulkCandidate,
  type BulkPriceChange,
  type BulkSelectionFilters,
  type MarketplaceWriteOperation,
} from "./operations.ts";
import type { MarketplaceStore, BulkBatchRecord, BulkItemRecord, ListingRecord } from "./store.ts";
import { assertWriteActor, assertWritesEnabled, type MarketplaceActor, type MarketplaceWriteRuntime } from "./write-runtime.ts";

export interface BulkConfig {
  /** Largest selection a batch may hold. PHP default: maximum_items = 250. */
  maxItems: number;
  /** Largest sum of absolute price changes across a batch, in minor units. Default 500000 (for example 5000.00). */
  maxAbsDeltaMinor: number;
  approvalTtlMs: number;
  bulkEnabled: boolean;
}

export const DEFAULT_BULK_CONFIG: BulkConfig = {
  maxItems: 250,
  maxAbsDeltaMinor: 500_000,
  approvalTtlMs: 15 * 60_000,
  bulkEnabled: false,
};

export interface BulkPreviewInput {
  connectionId: string;
  operation: string;
  filters: BulkSelectionFilters;
  /** For update_price: { mode, value }. For update_inventory: { delta } or { quantity }. For listing edits: the fields. */
  changeTemplate: Record<string, unknown>;
  idempotencyKey: string;
}

export interface BulkPreview {
  batch: BulkBatchRecord;
  items: BulkItemRecord[];
  confirmationToken: string | null;
}

export interface BulkRuntimeDeps {
  store: MarketplaceStore;
  writes: MarketplaceWriteRuntime;
  signer: ApprovalSigner;
  env: FlagEnv;
  clock: () => Date;
  config?: Partial<BulkConfig>;
  newId?: () => string;
}

export interface MarketplaceBulkRuntime {
  preview(companyId: string, actor: MarketplaceActor, input: BulkPreviewInput): Promise<BulkPreview>;
  confirm(companyId: string, actor: MarketplaceActor, batchId: string, token: string): Promise<BulkBatchRecord>;
  execute(companyId: string, actor: MarketplaceActor, batchId: string): Promise<BulkBatchRecord>;
  rollback(companyId: string, actor: MarketplaceActor, batchId: string): Promise<BulkBatchRecord>;
}

function assertBulkEnabled(env: FlagEnv, bulkEnabled: boolean): void {
  assertWritesEnabled(env);
  if (!bulkEnabled) throw new MarketplaceError("disabled", "Marketplace bulk writes are disabled.");
}

function changesFor(
  operation: MarketplaceWriteOperation,
  listing: ListingRecord["listing"],
  template: Record<string, unknown>,
): { changes: Record<string, unknown>; impact: Record<string, number> } {
  if (operation === "update_price") {
    const mode = String(template.mode ?? "");
    if (mode !== "set" && mode !== "fixed_delta" && mode !== "percentage_bps") {
      throw new MarketplaceError("invalid_changes", "Unsupported bulk price mode.");
    }
    const impact = priceImpact(listing.priceMinor, { mode, value: Number(template.value) } as BulkPriceChange);
    return { changes: { priceMinor: impact.after, currency: listing.currency }, impact: { ...impact } };
  }
  if (operation === "update_inventory") {
    if (typeof template.delta === "number") {
      const quantity = Math.max(0, (listing.quantity ?? 0) + Math.trunc(template.delta));
      return { changes: { quantity }, impact: { before: listing.quantity ?? 0, after: quantity, delta: quantity - (listing.quantity ?? 0) } };
    }
    const quantity = Number(template.quantity);
    return { changes: { quantity }, impact: { before: listing.quantity ?? 0, after: quantity, delta: quantity - (listing.quantity ?? 0) } };
  }
  return { changes: { ...template }, impact: { before: 0, after: 0, delta: 0 } };
}

function toCandidate(record: ListingRecord): BulkCandidate {
  const raw = record.listing.raw ?? {};
  const attributes = (raw.attributes ?? {}) as Record<string, unknown>;
  return {
    externalListingId: record.externalListingId,
    provider: record.provider,
    status: String(raw.status ?? ""),
    brand: String(attributes.brand ?? ""),
    category: String(attributes.category ?? ""),
    priceMinor: record.listing.priceMinor,
  };
}

function errorCodeOf(error: unknown): BulkItemRecord["errorCode"] {
  return error instanceof MarketplaceError ? error.code : "provider_unavailable";
}

export function createMarketplaceBulkRuntime(deps: BulkRuntimeDeps): MarketplaceBulkRuntime {
  const config: BulkConfig = { ...DEFAULT_BULK_CONFIG, ...(deps.config ?? {}) };
  const newId = deps.newId ?? randomUUID;

  async function loadOwnedBatch(companyId: string, actor: MarketplaceActor, batchId: string): Promise<BulkBatchRecord> {
    const batch = await deps.store.getBatch(companyId, batchId);
    if (!batch || batch.companyId !== companyId) throw new MarketplaceError("not_found", "The bulk batch was not found.");
    if (batch.ownerUserId !== actor.userId) throw new MarketplaceError("forbidden", "Only the owning seller can act on this batch.");
    return batch;
  }

  async function refreshCounts(batch: BulkBatchRecord, rollback: boolean): Promise<BulkBatchRecord> {
    const items = await deps.store.listBatchItems(batch.companyId, batch.id);
    const succeeded = items.filter((i) => i.status === "succeeded").length;
    const failed = items.filter((i) => i.status === "failed" || i.status === "blocked" || i.status === "rollback_failed").length;
    const rolledBack = items.filter((i) => i.status === "rolled_back").length;
    const eligible = Math.max(1, batch.eligibleCount);
    let status: BulkBatchStatus;
    if (rollback) {
      status = rolledBack >= eligible ? "rolled_back" : "partially_rolled_back";
    } else if (succeeded >= eligible) {
      status = "completed";
    } else if (succeeded > 0) {
      status = "partially_completed";
    } else {
      status = "failed";
    }
    batch.status = status;
    batch.succeededCount = succeeded;
    batch.failedCount = failed;
    batch.rolledBackCount = rolledBack;
    batch.updatedAt = deps.clock();
    await deps.store.saveBatch(batch);
    return batch;
  }

  return {
    async preview(companyId, actor, input) {
      assertBulkEnabled(deps.env, config.bulkEnabled);
      assertWriteActor(companyId, actor);
      const operation = normaliseWriteOperation(input.operation);
      const connection = await deps.store.getConnection(companyId, input.connectionId);
      if (!connection || connection.companyId !== companyId) throw new MarketplaceError("not_found", "The marketplace connection was not found.");
      if (!connection.active || !connection.writeEnabled || connection.ownerUserId !== actor.userId) {
        throw new MarketplaceError("forbidden", "This marketplace connection is not enabled for owned seller writes.");
      }

      const key = input.idempotencyKey.trim();
      if (key === "" || [...key].length > 191) throw new MarketplaceError("invalid_changes", "A bounded idempotency key is required.");

      const batchHash = sha256Hex(
        canonicalJson({ connectionId: connection.connectionId, operation, filters: input.filters, template: input.changeTemplate }),
      );
      const existing = await deps.store.findBatchByKey(companyId, connection.connectionId, key);
      if (existing) {
        if (!sameDigest(existing.batchHash, batchHash)) {
          throw new MarketplaceError("idempotency_conflict", "This idempotency key belongs to another bulk action.");
        }
        const items = await deps.store.listBatchItems(companyId, existing.id);
        if (existing.status !== "ready") return { batch: existing, items, confirmationToken: null };
        const now = deps.clock();
        const token = deps.signer.issue({ kind: "bulk", subjectId: existing.id, actionHash: existing.batchHash, companyId, userId: actor.userId }, config.approvalTtlMs, now.getTime());
        existing.approvalTokenHash = hashToken(token);
        existing.approvalExpiresAt = new Date(now.getTime() + config.approvalTtlMs);
        await deps.store.saveBatch(existing);
        return { batch: existing, items, confirmationToken: token };
      }

      const listings = await deps.store.listListings(companyId, connection.connectionId, config.maxItems * 4);
      const candidates = listings.map(toCandidate);
      const byId = new Map(listings.map((l) => [l.externalListingId, l]));
      const selected = selectBulkCandidates(candidates, input.filters).map((c) => byId.get(c.externalListingId)!);
      if (selected.length === 0) throw new MarketplaceError("no_match", "No marketplace listings matched the bulk selection.");
      if (selected.length > config.maxItems) {
        throw new MarketplaceError("bulk_cap", `This selection has ${selected.length} listings. The limit is ${config.maxItems}. Narrow the filters.`);
      }

      const planned = selected.map((listing) => ({ listing, ...changesFor(operation, listing.listing, input.changeTemplate) }));
      if (operation === "update_price") {
        const currencies = new Set(planned.map((p) => p.listing.listing.currency));
        if (currencies.size > 1) throw new MarketplaceError("invalid_changes", "A bulk price change must cover one currency.");
        const absDelta = planned.reduce((sum, p) => sum + Math.abs(p.impact.delta ?? 0), 0);
        if (absDelta > config.maxAbsDeltaMinor) {
          throw new MarketplaceError("spend_limit", "This bulk price change is larger than the allowed total. Narrow the selection.");
        }
      }

      const now = deps.clock();
      const batch: BulkBatchRecord = {
        id: newId(),
        companyId,
        connectionId: connection.connectionId,
        ownerUserId: actor.userId,
        provider: connection.provider as MarketplaceProviderKey,
        operation,
        status: "draft",
        idempotencyKey: key,
        batchHash,
        selectionFilters: input.filters as Record<string, unknown>,
        changeTemplate: input.changeTemplate,
        selectedCount: planned.length,
        eligibleCount: 0,
        blockedCount: 0,
        succeededCount: 0,
        failedCount: 0,
        rolledBackCount: 0,
        impactSummary: { totalBeforeMinor: 0, totalAfterMinor: 0, totalDeltaMinor: 0 },
        approvalTokenHash: null,
        approvalExpiresAt: null,
        approvedBy: null,
        approvedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      await deps.store.saveBatch(batch);

      const items: BulkItemRecord[] = [];
      let eligible = 0;
      let blocked = 0;
      let totalBefore = 0;
      let totalAfter = 0;
      for (const entry of planned) {
        const itemBase = {
          id: newId(),
          companyId,
          batchId: batch.id,
          externalListingId: entry.listing.externalListingId,
          proposedChanges: entry.changes,
          impact: entry.impact,
        };
        try {
          const prepared = await deps.writes.prepare(
            companyId,
            actor,
            {
              connectionId: connection.connectionId,
              externalListingId: entry.listing.externalListingId,
              operation,
              changes: entry.changes,
              expectedSourceHash: entry.listing.sourceHash,
              idempotencyKey: `bulk:${batch.id}:${entry.listing.externalListingId}`,
            },
            { batchId: batch.id },
          );
          const isBlocked = prepared.proposal.status === "conflict_blocked";
          if (isBlocked) blocked++;
          else eligible++;
          totalBefore += entry.impact.before ?? 0;
          totalAfter += entry.impact.after ?? 0;
          items.push({
            ...itemBase,
            proposalId: prepared.proposal.id,
            status: isBlocked ? "blocked" : "ready",
            errorCode: null,
            conflicts: prepared.proposal.conflicts,
            updatedAt: deps.clock(),
          });
        } catch (error) {
          items.push({ ...itemBase, proposalId: null, status: "failed", errorCode: errorCodeOf(error), conflicts: [], updatedAt: deps.clock() });
        }
      }
      for (const item of items) await deps.store.saveBatchItem(item);

      batch.eligibleCount = eligible;
      batch.blockedCount = blocked;
      batch.failedCount = items.filter((i) => i.status === "failed").length;
      batch.impactSummary = { totalBeforeMinor: totalBefore, totalAfterMinor: totalAfter, totalDeltaMinor: totalAfter - totalBefore };
      batch.status = eligible > 0 ? "ready" : "conflict_blocked";
      batch.updatedAt = deps.clock();

      if (batch.status !== "ready") {
        await deps.store.saveBatch(batch);
        return { batch, items, confirmationToken: null };
      }
      const token = deps.signer.issue({ kind: "bulk", subjectId: batch.id, actionHash: batch.batchHash, companyId, userId: actor.userId }, config.approvalTtlMs, now.getTime());
      batch.approvalTokenHash = hashToken(token);
      batch.approvalExpiresAt = new Date(now.getTime() + config.approvalTtlMs);
      await deps.store.saveBatch(batch);
      return { batch, items, confirmationToken: token };
    },

    async confirm(companyId, actor, batchId, token) {
      assertBulkEnabled(deps.env, config.bulkEnabled);
      assertWriteActor(companyId, actor);
      const batch = await loadOwnedBatch(companyId, actor, batchId);
      if (batch.status === "approved") return batch;
      if (batch.status !== "ready") throw new MarketplaceError("invalid_state", "Only a ready bulk batch can be confirmed.");
      const now = deps.clock();
      if (batch.approvalTokenHash === null || batch.approvalExpiresAt === null || batch.approvalExpiresAt.getTime() <= now.getTime()) {
        throw new MarketplaceError("confirmation_expired", "The bulk confirmation has expired. Preview the batch again.");
      }
      if (!sameDigest(batch.approvalTokenHash, hashToken(token))) {
        throw new MarketplaceError("confirmation_invalid", "The bulk confirmation token is invalid.");
      }
      const payload = deps.signer.verify(token, now.getTime());
      if (payload.kind !== "bulk" || payload.subjectId !== batch.id || payload.actionHash !== batch.batchHash || payload.companyId !== companyId || payload.userId !== actor.userId) {
        throw new MarketplaceError("confirmation_invalid", "The bulk confirmation does not match this batch.");
      }
      batch.status = "approved";
      batch.approvedBy = actor.userId;
      batch.approvedAt = now;
      batch.approvalTokenHash = null;
      batch.updatedAt = now;
      await deps.store.saveBatch(batch);
      return batch;
    },

    async execute(companyId, actor, batchId) {
      assertBulkEnabled(deps.env, config.bulkEnabled);
      assertWriteActor(companyId, actor);
      const batch = await loadOwnedBatch(companyId, actor, batchId);
      const runnable: BulkBatchStatus[] = ["approved", "partially_completed", "failed"];
      if (!runnable.includes(batch.status)) throw new MarketplaceError("invalid_state", "This bulk batch is not approved for execution.");
      batch.status = "running";
      batch.updatedAt = deps.clock();
      await deps.store.saveBatch(batch);

      const items = await deps.store.listBatchItems(companyId, batch.id);
      for (const item of items) {
        if (item.status !== "ready" && item.status !== "failed") continue;
        try {
          if (item.proposalId === null) throw new MarketplaceError("invalid_state", "The batch item has no proposal.");
          let proposal = await deps.store.getProposal(companyId, item.proposalId);
          if (!proposal) throw new MarketplaceError("not_found", "The batch item proposal was not found.");
          if (proposal.status === "prepared") {
            proposal = await deps.writes.approveForBatch(companyId, actor, proposal.id, batch.id, batch.batchHash);
          }
          proposal = await deps.writes.execute(companyId, actor, proposal.id);
          item.status = proposal.status === "executed" ? "succeeded" : proposal.status === "conflict_blocked" ? "blocked" : "failed";
          item.errorCode = proposal.errorCode as BulkItemRecord["errorCode"];
          item.conflicts = proposal.conflicts;
        } catch (error) {
          item.status = "failed";
          item.errorCode = errorCodeOf(error);
        }
        item.updatedAt = deps.clock();
        await deps.store.saveBatchItem(item);
      }
      return refreshCounts(batch, false);
    },

    async rollback(companyId, actor, batchId) {
      assertBulkEnabled(deps.env, config.bulkEnabled);
      assertWriteActor(companyId, actor);
      const batch = await loadOwnedBatch(companyId, actor, batchId);
      const items = await deps.store.listBatchItems(companyId, batch.id);
      for (const item of items.reverse()) {
        if (item.status !== "succeeded" || item.proposalId === null) continue;
        try {
          const proposal = await deps.writes.rollback(companyId, actor, item.proposalId);
          item.status = proposal.status === "rolled_back" ? "rolled_back" : "rollback_failed";
          item.errorCode = proposal.errorCode as BulkItemRecord["errorCode"];
        } catch (error) {
          item.status = "rollback_failed";
          item.errorCode = errorCodeOf(error);
        }
        item.updatedAt = deps.clock();
        await deps.store.saveBatchItem(item);
      }
      return refreshCounts(batch, true);
    },
  };
}

