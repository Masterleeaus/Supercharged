/**
 * Inventory reconciliation between local stock and each marketplace listing.
 *
 * Port of MarketplaceInventoryReconciliationRuntime.php. The rules that matter for safety:
 *   - A scan reads both sides and records any disagreement as a conflict. It never writes to the marketplace.
 *   - A conflict is never overwritten silently. A new observation of the same conflict writes an event that
 *     holds the previous and current values. A conflict with a different code closes the old one as
 *     "superseded" and opens a new one. Nothing is deleted.
 *   - A correction is only prepared, as a write proposal for the owning seller. Applying it is a separate step.
 */
import type { HttpClient, MarketplaceConnectionRef, MarketplaceListing } from "../../contracts/index.ts";
import { type CanonicalStockReader, type InventoryWriteProposer, type MarketplaceRegistry, type VariantLookup } from "./ports.ts";
import type { OrderOpsStore } from "./storage.ts";
import { allocate, assess, evaluateResolution, type AllocationPolicy, type InventoryAssessment } from "./inventory-math.ts";
import { assertConnectionScope, connectionRef, enqueue, marketplaceWriteEnabled, requireOwner } from "./support.ts";
import { hashOf } from "./canonical.ts";
import type { FlagEnv } from "../../contracts/index.ts";
import {
  OrderOpsError,
  type ConnectionScope,
  type InventoryConflict,
  type InventoryMapping,
  type InventoryPolicy,
  type ListingSnapshot,
  type ScanRun,
} from "./types.ts";

export interface InventoryReconciliationDeps {
  store: OrderOpsStore;
  stock: CanonicalStockReader;
  variants: VariantLookup;
  marketplaces: MarketplaceRegistry;
  writes: InventoryWriteProposer;
  http: HttpClient;
  now?: () => Date;
  env?: FlagEnv;
  httpTimeoutMs?: number;
  defaultMaximumSyncAgeSeconds?: number;
}

export interface ScanMappingResult {
  assessment: InventoryAssessment & { warnings: { code: string; message: string }[]; mappingVerified: boolean };
  conflictId: string | null;
  correctionPrepared: boolean;
}

const OPEN_STATUSES = ["open", "acknowledged", "resolution_prepared", "ignored"] as const;

export function defaultInventoryPolicy(chatbotId: string, companyId: string, connectionId: string | null, maximumSyncAgeSeconds: number): Omit<InventoryPolicy, "id"> {
  return {
    companyId,
    chatbotId,
    connectionId,
    active: true,
    sourceOfTruth: "internal",
    resolutionMode: "suggest_only",
    allocationMode: "equal_share",
    allocationBps: 10_000,
    bufferQuantity: 0,
    minimumQuantity: 0,
    maximumQuantity: null,
    maximumSyncAgeSeconds,
    quantityTolerance: 0,
    maximumAutoDelta: 0,
    requireFreshSnapshot: true,
    autoMapBySku: true,
  };
}

export function createInventoryReconciliation(deps: InventoryReconciliationDeps) {
  const { store } = deps;
  const now = deps.now ?? (() => new Date());
  const defaultAge = deps.defaultMaximumSyncAgeSeconds ?? 300;

  async function policyFor(companyId: string, scope: ConnectionScope): Promise<InventoryPolicy> {
    assertConnectionScope(companyId, scope);
    const rows = await store.policies.list(companyId, (p) => p.chatbotId === scope.chatbotId && p.active && (p.connectionId === scope.connectionId || p.connectionId === null));
    const specific = rows.find((p) => p.connectionId === scope.connectionId);
    const shared = rows.find((p) => p.connectionId === null);
    if (specific ?? shared) return (specific ?? shared) as InventoryPolicy;
    return { id: "", ...defaultInventoryPolicy(scope.chatbotId, companyId, scope.connectionId, defaultAge) };
  }

  async function setPolicy(companyId: string, scope: ConnectionScope, values: Partial<Omit<InventoryPolicy, "id" | "companyId" | "chatbotId">>): Promise<InventoryPolicy> {
    assertConnectionScope(companyId, scope);
    const existing = await store.policies.find(companyId, (p) => p.chatbotId === scope.chatbotId && p.connectionId === scope.connectionId);
    const merged = { ...defaultInventoryPolicy(scope.chatbotId, companyId, scope.connectionId, defaultAge), ...(existing ?? {}), ...values, chatbotId: scope.chatbotId, connectionId: scope.connectionId };
    if (existing) {
      const { id: _id, companyId: _c, ...patch } = merged as InventoryPolicy;
      return (await store.policies.update(companyId, existing.id, patch)) as InventoryPolicy;
    }
    const { companyId: _c, ...row } = merged as InventoryPolicy;
    return (await store.policies.insert(companyId, row)) as InventoryPolicy;
  }

  /** Seller creates a mapping by hand (for example, a listing whose SKU does not match). It starts unverified. */
  async function createMapping(companyId: string, scope: ConnectionScope, input: { variantId: string; externalListingId: string; locationId?: string | null }): Promise<InventoryMapping> {
    assertConnectionScope(companyId, scope);
    return store.mappings.insert(companyId, {
      chatbotId: scope.chatbotId,
      connectionId: scope.connectionId,
      listingSnapshotId: null,
      variantId: input.variantId,
      locationId: input.locationId ?? null,
      externalListingId: input.externalListingId,
      sku: null,
      active: true,
      verified: false,
      allocationMode: null,
      allocationBps: null,
      bufferQuantity: null,
      minimumQuantity: null,
      maximumQuantity: null,
      lastExternalQuantity: null,
      lastTargetQuantity: null,
      lastSourceHash: null,
      lastScannedAt: null,
      lastInSyncAt: null,
      metadata: { mapping_source: "manual" },
    });
  }

  async function verifyMapping(companyId: string, scope: ConnectionScope, mappingId: string, userId: string): Promise<InventoryMapping> {
    assertConnectionScope(companyId, scope);
    requireOwner(scope, userId, "Only the owning seller can verify a mapping.");
    const mapping = await requireMapping(companyId, scope, mappingId);
    return (await store.mappings.update(companyId, mapping.id, { verified: true })) as InventoryMapping;
  }

  async function discoverMappings(companyId: string, scope: ConnectionScope): Promise<number> {
    assertConnectionScope(companyId, scope);
    const policy = await policyFor(companyId, scope);
    if (!policy.autoMapBySku) return 0;
    const listings = await store.listings.list(companyId, (l) => l.connectionId === scope.connectionId);
    let created = 0;
    for (const listing of listings) {
      const existing = await store.mappings.find(companyId, (m) => m.connectionId === scope.connectionId && m.externalListingId === listing.externalListingId);
      if (existing) continue;
      const sku = extractSku(listing.snapshot);
      if (sku === "") continue;
      const ids = await deps.variants.idsBySku(companyId, sku);
      if (ids.length !== 1) continue;
      await store.mappings.insert(companyId, {
        chatbotId: scope.chatbotId,
        connectionId: scope.connectionId,
        listingSnapshotId: listing.id,
        variantId: ids[0],
        locationId: null,
        externalListingId: listing.externalListingId,
        sku,
        active: true,
        verified: false,
        allocationMode: null,
        allocationBps: null,
        bufferQuantity: null,
        minimumQuantity: null,
        maximumQuantity: null,
        lastExternalQuantity: null,
        lastTargetQuantity: null,
        lastSourceHash: null,
        lastScannedAt: null,
        lastInSyncAt: null,
        metadata: { mapping_source: "exact_sku", requires_seller_verification: true },
      });
      created++;
    }
    return created;
  }

  /** Scans every active mapping of the connection. Records a scan run with its counts. */
  async function scan(companyId: string, scope: ConnectionScope, actorUserId: string | null = null): Promise<ScanRun> {
    assertConnectionScope(companyId, scope);
    const run = await store.scanRuns.insert(companyId, {
      chatbotId: scope.chatbotId,
      connectionId: scope.connectionId,
      ownerUserId: actorUserId,
      status: "running",
      mappingCount: 0,
      inSyncCount: 0,
      conflictCount: 0,
      criticalCount: 0,
      correctionsPrepared: 0,
      failureHash: null,
      startedAt: now(),
      completedAt: null,
      metadata: {},
    });
    try {
      const autoMapped = await discoverMappings(companyId, scope);
      const mappings = await store.mappings.list(companyId, (m) => m.connectionId === scope.connectionId && m.chatbotId === scope.chatbotId && m.active);
      const counts = { inSync: 0, conflict: 0, critical: 0, prepared: 0 };
      for (const mapping of mappings) {
        const result = await scanMapping(companyId, scope, mapping.id, { runId: run.id, actorUserId });
        if (result.assessment.conflict) counts.conflict++;
        else counts.inSync++;
        if (result.assessment.severity === "critical") counts.critical++;
        if (result.correctionPrepared) counts.prepared++;
      }
      const done = await store.scanRuns.update(companyId, run.id, {
        status: "completed",
        mappingCount: mappings.length,
        inSyncCount: counts.inSync,
        conflictCount: counts.conflict,
        criticalCount: counts.critical,
        correctionsPrepared: counts.prepared,
        completedAt: now(),
        metadata: { auto_mapped: autoMapped },
      });
      return done as ScanRun;
    } catch (error) {
      await store.scanRuns.update(companyId, run.id, { status: "failed", failureHash: hashOf(String((error as Error).message ?? error)), completedAt: now() });
      throw error;
    }
  }

  async function scanMapping(
    companyId: string,
    scope: ConnectionScope,
    mappingId: string,
    options: { runId?: string | null; actorUserId?: string | null; allowAutoPrepare?: boolean } = {},
  ): Promise<ScanMappingResult> {
    const mapping = await requireMapping(companyId, scope, mappingId);
    const policy = await policyFor(companyId, scope);
    const listing = await refreshListing(companyId, scope, mapping);
    const canonical = await canonicalState(companyId, mapping);
    const allocation = allocate(canonical.available, await allocationPolicy(companyId, policy, mapping));
    const external = { quantity: extractQuantity(listing.snapshot), observedAt: listing.lastSeenAt, sourceHash: listing.sourceHash };
    const base = assess(canonical, external, { targetQuantity: allocation.targetQuantity, maximumSyncAgeSeconds: policy.maximumSyncAgeSeconds, quantityTolerance: policy.quantityTolerance }, now().getTime());
    const warnings: { code: string; message: string }[] = [];
    let blocking = base.blocking;
    if (!mapping.verified) {
      blocking = true;
      warnings.push({ code: "mapping_unverified", message: "The SKU mapping must be verified by the seller before correction." });
    }
    const assessment = { ...base, blocking, warnings, mappingVerified: mapping.verified, allocation, sourceOfTruth: policy.sourceOfTruth } as ScanMappingResult["assessment"];

    const timestamp = now();
    const holder: { conflictId: string | null } = { conflictId: null };
    await store.transaction(async (tx) => {
      await tx.mappings.update(companyId, mapping.id, {
        listingSnapshotId: listing.id,
        lastExternalQuantity: external.quantity,
        lastTargetQuantity: allocation.targetQuantity,
        lastSourceHash: listing.sourceHash,
        lastScannedAt: timestamp,
        lastInSyncAt: !assessment.conflict ? timestamp : mapping.lastInSyncAt,
      });
      if (!assessment.conflict) {
        await resolveOpenConflicts(tx, companyId, mapping.id, options.actorUserId ?? null, "inventory_returned_to_sync");
        return;
      }
      const conflict = await recordConflict(tx, companyId, scope, mapping, options.runId ?? null, assessment, listing.lastSeenAt, options.actorUserId ?? null);
      holder.conflictId = conflict.id;
    });
    const conflictId = holder.conflictId;

    let correctionPrepared = false;
    if (conflictId !== null) {
      const conflict = (await store.conflicts.get(companyId, conflictId)) as InventoryConflict;
      const eligibility = evaluateResolution(policy, assessment);
      const writesOn = marketplaceWriteEnabled(deps.env ?? {});
      if (writesOn && (options.allowAutoPrepare ?? true) && conflict.status !== "ignored" && eligibility.autoPrepare && mapping.verified && policy.sourceOfTruth === "internal") {
        const result = await prepareCorrection(companyId, scope, conflictId, scope.ownerUserId, "automatic_policy");
        correctionPrepared = result.proposalId !== null;
      }
    }
    return { assessment, conflictId, correctionPrepared };
  }

  /**
   * Prepares a write proposal that would set the marketplace quantity to the target. Only prepares: the
   * proposal waits for seller approval, and this function never applies it.
   */
  async function prepareCorrection(
    companyId: string,
    scope: ConnectionScope,
    conflictId: string,
    userId: string,
    mode: "manual" | "automatic_policy" = "manual",
  ): Promise<{ conflict: InventoryConflict; proposalId: string | null }> {
    const existing = await store.conflicts.get(companyId, conflictId);
    if (!existing || existing.chatbotId !== scope.chatbotId || existing.connectionId !== scope.connectionId) {
      throw new OrderOpsError("Inventory conflict not found.", 404);
    }
    const mapping = await requireMapping(companyId, scope, existing.mappingId);
    requireOwner(scope, userId, "Only the owning seller can prepare this correction.");
    if (!mapping.verified) throw new OrderOpsError("Verify the marketplace-to-variant mapping before preparing a correction.");
    const policy = await policyFor(companyId, scope);
    if (policy.sourceOfTruth !== "internal") {
      throw new OrderOpsError("This connection does not use internal inventory as its authoritative source, so an external stock correction cannot be prepared.");
    }
    const latest = await scanMapping(companyId, scope, mapping.id, { actorUserId: userId, allowAutoPrepare: false });
    if (latest.assessment.code === "in_sync") {
      return { conflict: (await store.conflicts.get(companyId, conflictId)) as InventoryConflict, proposalId: null };
    }
    if (latest.assessment.code === "external_state_stale") {
      throw new OrderOpsError("Refresh the marketplace listing before preparing an inventory correction.");
    }
    const current = await latestConflict(companyId, (c) => c.mappingId === mapping.id && ["open", "acknowledged", "resolution_prepared"].includes(c.status));
    if (!current) throw new OrderOpsError("No open inventory conflict for this mapping.", 404);
    if (current.writeProposalId !== null) {
      return { conflict: current, proposalId: current.writeProposalId };
    }
    if (!marketplaceWriteEnabled(deps.env ?? {})) {
      throw new OrderOpsError("Marketplace write operations are disabled.", 403);
    }
    const proposal = await deps.writes.propose({
      companyId,
      connection: scope,
      externalListingId: mapping.externalListingId,
      quantity: current.targetQuantity,
      expectedSourceHash: current.sourceHash,
      idempotencyKey: `inventory-conflict:${current.id}:${current.sourceHash}:${current.targetQuantity}`,
      actorUserId: userId,
    });

    return store.transaction(async (tx) => {
      const before = current.status;
      const updated = (await tx.conflicts.update(companyId, current.id, {
        writeProposalId: proposal.proposalId,
        status: "resolution_prepared",
        resolutionMode: mode,
        metadata: { ...current.metadata, write_status: "proposed" },
      })) as InventoryConflict;
      await recordEvent(tx, companyId, current.id, "correction_prepared", before, "resolution_prepared", userId, { proposal_id: proposal.proposalId, mode }, now());
      await enqueue(tx, companyId, "commerce.marketplace.inventory.correction.prepared", current.id, { conflict_id: current.id, proposal_id: proposal.proposalId }, `correction:${current.id}:${proposal.proposalId}`, now());
      return { conflict: updated, proposalId: proposal.proposalId };
    });
  }

  async function acknowledge(companyId: string, scope: ConnectionScope, conflictId: string, userId: string): Promise<InventoryConflict> {
    return store.transaction(async (tx) => {
      const conflict = await requireConflict(tx, companyId, scope, conflictId);
      if (conflict.status === "resolved" || conflict.status === "ignored") return conflict;
      const updated = (await tx.conflicts.update(companyId, conflict.id, { status: "acknowledged", acknowledgedByUserId: userId, acknowledgedAt: now() })) as InventoryConflict;
      await recordEvent(tx, companyId, conflict.id, "acknowledged", conflict.status, "acknowledged", userId, {}, now());
      return updated;
    });
  }

  async function ignore(companyId: string, scope: ConnectionScope, conflictId: string, userId: string, reason: string, hours: number | null = null): Promise<InventoryConflict> {
    const trimmed = reason.trim();
    if (trimmed === "") throw new OrderOpsError("An audit reason is required.");
    return store.transaction(async (tx) => {
      const conflict = await requireConflict(tx, companyId, scope, conflictId);
      const timestamp = now();
      const until = hours === null ? null : new Date(timestamp.getTime() + Math.min(720, Math.max(1, hours)) * 3_600_000);
      const updated = (await tx.conflicts.update(companyId, conflict.id, {
        status: "ignored",
        ignoredByUserId: userId,
        ignoredAt: timestamp,
        ignoredUntil: until,
        ignoreReason: trimmed,
      })) as InventoryConflict;
      await recordEvent(tx, companyId, conflict.id, "ignored", conflict.status, "ignored", userId, { reason: trimmed, ignored_until: until?.toISOString() ?? null }, timestamp);
      return updated;
    });
  }

  async function listConflicts(companyId: string, scope: ConnectionScope, statuses: string[] = [...OPEN_STATUSES]): Promise<InventoryConflict[]> {
    assertConnectionScope(companyId, scope);
    return store.conflicts.list(companyId, (c) => c.chatbotId === scope.chatbotId && c.connectionId === scope.connectionId && statuses.includes(c.status));
  }

  async function requireMapping(companyId: string, scope: ConnectionScope, mappingId: string): Promise<InventoryMapping> {
    assertConnectionScope(companyId, scope);
    const mapping = await store.mappings.get(companyId, mappingId);
    if (!mapping || mapping.chatbotId !== scope.chatbotId || mapping.connectionId !== scope.connectionId) {
      throw new OrderOpsError("Inventory mapping does not belong to this marketplace connection.", 404);
    }
    return mapping;
  }

  async function requireConflict(tx: OrderOpsStore, companyId: string, scope: ConnectionScope, conflictId: string): Promise<InventoryConflict> {
    const conflict = await tx.conflicts.get(companyId, conflictId);
    if (!conflict || conflict.chatbotId !== scope.chatbotId || conflict.connectionId !== scope.connectionId) {
      throw new OrderOpsError("Inventory conflict not found.", 404);
    }
    return conflict;
  }

  async function latestConflict(companyId: string, where: (c: InventoryConflict) => boolean): Promise<InventoryConflict | null> {
    const rows = await store.conflicts.list(companyId, where);
    return rows.length === 0 ? null : rows[rows.length - 1];
  }

  /** Reads the live listing and stores it. If the read fails, the last stored observation is used and ages out. */
  async function refreshListing(companyId: string, scope: ConnectionScope, mapping: InventoryMapping): Promise<ListingSnapshot> {
    const existing = await store.listings.find(companyId, (l) => l.connectionId === scope.connectionId && l.externalListingId === mapping.externalListingId);
    try {
      const live = await deps.marketplaces.get(scope.provider).read.getListing(connectionRef(scope), mapping.externalListingId, deps.http);
      if (live) {
        const stored = snapshotFromListing(live);
        const timestamp = now();
        if (existing) {
          return (await store.listings.update(companyId, existing.id, { sourceHash: stored.sourceHash, snapshot: stored.snapshot, lastSeenAt: timestamp })) as ListingSnapshot;
        }
        return store.listings.insert(companyId, {
          chatbotId: scope.chatbotId,
          connectionId: scope.connectionId,
          provider: scope.provider,
          externalListingId: mapping.externalListingId,
          sourceHash: stored.sourceHash,
          snapshot: stored.snapshot,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
        });
      }
    } catch (error) {
      if (!existing) throw error;
    }
    if (!existing) throw new OrderOpsError("No marketplace listing observation exists for this mapping.");
    return existing;
  }

  function snapshotFromListing(live: MarketplaceListing): { sourceHash: string; snapshot: Record<string, unknown> } {
    const snapshot: Record<string, unknown> = { ...live.raw, externalListingId: live.externalListingId, title: live.title, priceMinor: live.priceMinor, currency: live.currency, quantity: live.quantity };
    return { sourceHash: live.sourceHash || hashOf(snapshot), snapshot };
  }

  async function canonicalState(companyId: string, mapping: InventoryMapping) {
    const row = await deps.stock.read(companyId, mapping.variantId, mapping.locationId);
    if (!row) return { quantity: 0, reserved: 0, committed: 0, incoming: 0, damaged: 0, safetyStock: 0, available: 0, version: 0 };
    return row;
  }

  async function allocationPolicy(companyId: string, policy: InventoryPolicy, mapping: InventoryMapping): Promise<AllocationPolicy> {
    const siblings = await store.mappings.list(companyId, (m) => m.chatbotId === mapping.chatbotId && m.variantId === mapping.variantId && m.active && m.locationId === mapping.locationId);
    return {
      allocationMode: mapping.allocationMode ?? policy.allocationMode,
      allocationBps: mapping.allocationBps ?? policy.allocationBps,
      bufferQuantity: mapping.bufferQuantity ?? policy.bufferQuantity,
      minimumQuantity: mapping.minimumQuantity ?? policy.minimumQuantity,
      maximumQuantity: mapping.maximumQuantity ?? policy.maximumQuantity,
      channelCount: Math.max(1, siblings.length),
    };
  }

  async function recordConflict(
    tx: OrderOpsStore,
    companyId: string,
    scope: ConnectionScope,
    mapping: InventoryMapping,
    runId: string | null,
    assessment: ScanMappingResult["assessment"],
    observedAt: Date,
    actorUserId: string | null,
  ): Promise<InventoryConflict> {
    const timestamp = now();
    // A different code means the old conflict no longer describes the state. Close it with a reason. Do not delete it.
    const stale = await tx.conflicts.list(companyId, (c) => c.mappingId === mapping.id && c.status !== "resolved" && c.status !== "ignored" && c.code !== assessment.code);
    for (const old of stale) {
      await tx.conflicts.update(companyId, old.id, { status: "resolved", resolvedByUserId: actorUserId, resolvedAt: timestamp, resolutionMode: "superseded" });
      await recordEvent(tx, companyId, old.id, "superseded", old.status, "resolved", actorUserId, { superseded_by_code: assessment.code }, timestamp);
    }

    const current = await latestConflict(companyId, (c) => c.mappingId === mapping.id && c.code === assessment.code && OPEN_STATUSES.includes(c.status as (typeof OPEN_STATUSES)[number]));
    let status: InventoryConflict["status"] = "open";
    if (current && current.status === "ignored" && (current.ignoredUntil === null || current.ignoredUntil.getTime() > timestamp.getTime())) status = "ignored";
    else if (current && current.status === "resolution_prepared") status = "resolution_prepared";
    else if (current && current.status === "acknowledged") status = "acknowledged";

    const values = {
      chatbotId: scope.chatbotId,
      connectionId: scope.connectionId,
      mappingId: mapping.id,
      scanRunId: runId,
      provider: scope.provider,
      externalListingId: mapping.externalListingId,
      code: assessment.code,
      severity: assessment.severity,
      status,
      canonicalQuantity: assessment.canonicalAvailable,
      targetQuantity: assessment.targetQuantity,
      externalQuantity: assessment.externalQuantity,
      delta: assessment.delta,
      oversellExposure: assessment.oversellExposure,
      canonicalVersion: assessment.canonicalVersion,
      sourceHash: assessment.sourceHash,
      observedAt,
      firstDetectedAt: current?.firstDetectedAt ?? timestamp,
      lastDetectedAt: timestamp,
      assessment: { ...assessment } as Record<string, unknown>,
    };

    if (!current) {
      const created = await tx.conflicts.insert(companyId, {
        ...values,
        resolutionMode: null,
        acknowledgedByUserId: null,
        acknowledgedAt: null,
        ignoredByUserId: null,
        ignoredAt: null,
        ignoredUntil: null,
        ignoreReason: null,
        resolvedByUserId: null,
        resolvedAt: null,
        writeProposalId: null,
        metadata: {},
      });
      await recordEvent(tx, companyId, created.id, "detected", null, status, actorUserId, { assessment: { ...assessment } as Record<string, unknown> }, timestamp);
      await enqueue(tx, companyId, "commerce.marketplace.inventory.conflict.detected", created.id, { conflict_id: created.id, code: created.code, severity: created.severity }, `conflict:${created.id}:detected`, timestamp);
      return created;
    }

    // Same conflict seen again. Keep the history: the event holds what was there before and what is there now.
    const previous = { status: current.status, canonical_quantity: current.canonicalQuantity, target_quantity: current.targetQuantity, external_quantity: current.externalQuantity, delta: current.delta, source_hash: current.sourceHash };
    const updated = (await tx.conflicts.update(companyId, current.id, values)) as InventoryConflict;
    const after = { status, canonical_quantity: updated.canonicalQuantity, target_quantity: updated.targetQuantity, external_quantity: updated.externalQuantity, delta: updated.delta, source_hash: updated.sourceHash };
    await recordEvent(tx, companyId, current.id, "observed_again", current.status, status, actorUserId, { previous, current: after, assessment_hash: hashOf(assessment) }, timestamp);
    await enqueue(tx, companyId, "commerce.marketplace.inventory.conflict.detected", current.id, { conflict_id: current.id, code: updated.code, severity: updated.severity }, `conflict:${current.id}:observed:${hashOf(assessment)}`, timestamp);
    return updated;
  }

  async function resolveOpenConflicts(tx: OrderOpsStore, companyId: string, mappingId: string, userId: string | null, mode: string): Promise<void> {
    const open = await tx.conflicts.list(companyId, (c) => c.mappingId === mappingId && c.status !== "resolved" && c.status !== "ignored");
    const timestamp = now();
    for (const conflict of open) {
      await tx.conflicts.update(companyId, conflict.id, { status: "resolved", resolvedByUserId: userId, resolvedAt: timestamp, resolutionMode: mode });
      await recordEvent(tx, companyId, conflict.id, "resolved", conflict.status, "resolved", userId, { mode }, timestamp);
    }
  }

  return {
    policyFor,
    setPolicy,
    createMapping,
    verifyMapping,
    discoverMappings,
    scan,
    scanMapping,
    prepareCorrection,
    acknowledge,
    ignore,
    listConflicts,
  };
}

function extractSku(snapshot: Record<string, unknown>): string {
  const attributes = isRecord(snapshot.attributes) ? snapshot.attributes : {};
  const value = snapshot.sku ?? attributes.sku ?? attributes.seller_sku ?? "";
  return typeof value === "string" ? value.trim() : "";
}

/** Reads the quantity from the stored listing. Missing or negative values are read as zero, as in PHP. */
function extractQuantity(snapshot: Record<string, unknown>): number {
  const attributes = isRecord(snapshot.attributes) ? snapshot.attributes : {};
  for (const key of ["quantity", "available_quantity", "inventory_quantity", "stock", "quantity_available"]) {
    const source = key in snapshot ? snapshot : key in attributes ? attributes : null;
    if (source) {
      const value = Number(source[key]);
      return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
    }
  }
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function recordEvent(
  tx: OrderOpsStore,
  companyId: string,
  conflictId: string,
  eventType: string,
  before: string | null,
  after: string | null,
  userId: string | null,
  payload: Record<string, unknown>,
  at: Date,
): Promise<void> {
  await tx.conflictEvents.insert(companyId, {
    conflictId,
    eventType,
    actorType: userId === null ? "system" : "seller",
    actorUserId: userId,
    statusBefore: before,
    statusAfter: after,
    payload,
    occurredAt: at,
  });
}
