/**
 * Marketplace write runtime: prepare, confirm, execute and rollback for listing, price, inventory, pause and
 * resume writes. Port of MarketplaceWriteRuntime.php with these rules, each recorded in DECISIONS.md:
 *
 * - Off unless CHATBOT_MARKETPLACE_WRITE_ENABLED is exactly "true" (readFlag). Off means refused, not ignored.
 * - Role check: the actor must hold a write role and own the connection. Other roles and other owners are refused.
 * - Confirmation: prepare returns a short-lived token. Nothing reaches the provider until confirm() accepts it.
 * - Spend check: a price change larger than maxPriceChangeBps (relative to the current price) is refused at
 *   prepare. Inventory above internal stock is blocked by the conflict check.
 * - Before execute, the authoritative listing is re-read and the conflict check runs again.
 * - Provider failures mark the proposal failed and return it. They do not throw, so a bulk batch can continue.
 */
import { randomUUID } from "node:crypto";
import { readFlag, CONTRACT_FLAGS, type FlagEnv, type HttpClient, type MarketplaceCapability, type RateLimitHooks } from "../../contracts/index.ts";
import { MarketplaceError } from "./errors.ts";
import { assessConflicts, type ConflictFinding } from "./conflicts.ts";
import { createApprovalSigner, hashToken, sameDigest, type ApprovalSigner } from "./approval.ts";
import {
  canTransitionWrite,
  canonicalJson,
  capabilityForOperation,
  changesHash,
  normaliseWriteOperation,
  sanitiseChanges,
  sha256Hex,
  type MarketplaceWriteOperation,
  type ProviderRollbackRequest,
  type ProviderWriteRequest,
  type WriteProposalStatus,
} from "./operations.ts";
import { guardedCall } from "./outbound.ts";
import type { MarketplaceReadRegistry, MarketplaceWriteRegistry } from "./registry.ts";
import type { ConnectionRecord, ListingRecord, MarketplaceStore, WriteProposalRecord } from "./store.ts";

export const WRITE_ROLES = ["owner", "admin"] as const;
export type MarketplaceRole = "owner" | "admin" | "agent" | "viewer";

export interface MarketplaceActor {
  companyId: string;
  userId: string;
  role: MarketplaceRole;
}

export interface WriteConfig {
  /** Largest allowed relative price change, in basis points. PHP has no such check. Default 2000 (20 percent). */
  maxPriceChangeBps: number;
  /** A snapshot older than this cannot be written against. PHP default 300. */
  maxSnapshotAgeSeconds: number;
  allowInventoryOversell: boolean;
  /** PHP default approval_ttl_minutes = 10. */
  approvalTtlMs: number;
}

export const DEFAULT_WRITE_CONFIG: WriteConfig = {
  maxPriceChangeBps: 2000,
  maxSnapshotAgeSeconds: 300,
  allowInventoryOversell: false,
  approvalTtlMs: 10 * 60_000,
};

export interface PrepareWriteInput {
  connectionId: string;
  externalListingId: string;
  operation: string;
  changes: Record<string, unknown>;
  expectedSourceHash: string;
  idempotencyKey: string;
}

export interface PreparedWrite {
  proposal: WriteProposalRecord;
  /** Null when the write is blocked, or when it belongs to a bulk batch (the batch issues one token). */
  confirmationToken: string | null;
}

export interface WriteRuntimeDeps {
  store: MarketplaceStore;
  readRegistry: MarketplaceReadRegistry;
  writeRegistry: MarketplaceWriteRegistry;
  rateLimit: RateLimitHooks;
  http: HttpClient;
  clock: () => Date;
  env: FlagEnv;
  /** Signing secret for confirmation tokens. Must be at least 32 characters, or construction throws. */
  approvalSecret: string;
  /** Internal available stock for a mapped listing. Null when the listing is not mapped. Optional. */
  inventoryAvailable?: (companyId: string, connectionId: string, externalListingId: string) => Promise<number | null>;
  config?: Partial<WriteConfig>;
  newId?: () => string;
}

export interface MarketplaceWriteRuntime {
  prepare(companyId: string, actor: MarketplaceActor, input: PrepareWriteInput, options?: { batchId?: string }): Promise<PreparedWrite>;
  confirm(companyId: string, actor: MarketplaceActor, proposalId: string, token: string): Promise<WriteProposalRecord>;
  /** Used by bulk batches. The batch token has already been checked. */
  approveForBatch(companyId: string, actor: MarketplaceActor, proposalId: string, batchId: string, batchHash: string): Promise<WriteProposalRecord>;
  execute(companyId: string, actor: MarketplaceActor, proposalId: string): Promise<WriteProposalRecord>;
  rollback(companyId: string, actor: MarketplaceActor, proposalId: string): Promise<WriteProposalRecord>;
  signer: ApprovalSigner;
}

/** Shared guards. Exported so the bulk runtime applies the same rules. */
export function assertWriteActor(companyId: string, actor: MarketplaceActor): void {
  if (actor.companyId !== companyId) throw new MarketplaceError("forbidden", "Marketplace action is not available to this account.");
  if (!(WRITE_ROLES as readonly string[]).includes(actor.role)) {
    throw new MarketplaceError("forbidden", "Marketplace writes need an owner or admin role.");
  }
}

export function assertWritesEnabled(env: FlagEnv): void {
  if (!readFlag(CONTRACT_FLAGS.MARKETPLACE_WRITE_ENABLED, env)) {
    throw new MarketplaceError("disabled", "Marketplace writes are disabled for this installation.");
  }
}

function stateForOperation(operation: MarketplaceWriteOperation, listing: ListingRecord["listing"]): Record<string, unknown> {
  const raw = listing.raw ?? {};
  const attributes = (raw.attributes ?? {}) as Record<string, unknown>;
  switch (operation) {
    case "update_price":
      return { priceMinor: listing.priceMinor, currency: listing.currency };
    case "update_inventory":
      return { quantity: Math.max(0, listing.quantity ?? 0) };
    case "update_listing":
      return { title: listing.title, description: String(raw.description ?? ""), attributes };
    case "pause_listing":
    case "resume_listing":
      return { status: String(raw.status ?? "") };
  }
}

function afterStateFor(operation: MarketplaceWriteOperation, changes: Record<string, unknown>): Record<string, unknown> {
  switch (operation) {
    case "update_price":
      return { priceMinor: changes.priceMinor, currency: changes.currency };
    case "update_inventory":
      return { quantity: changes.quantity };
    case "update_listing":
      return { ...changes };
    default:
      return {};
  }
}

export function createMarketplaceWriteRuntime(deps: WriteRuntimeDeps): MarketplaceWriteRuntime {
  const config: WriteConfig = { ...DEFAULT_WRITE_CONFIG, ...(deps.config ?? {}) };
  const newId = deps.newId ?? randomUUID;
  // Fails closed: throws here when the secret is missing or short, even if the flag is off.
  const signer = createApprovalSigner(deps.approvalSecret);

  async function loadWritableConnection(companyId: string, actor: MarketplaceActor, connectionId: string, operation: MarketplaceWriteOperation): Promise<ConnectionRecord> {
    const connection = await deps.store.getConnection(companyId, connectionId);
    if (!connection || connection.companyId !== companyId) {
      throw new MarketplaceError("not_found", "The marketplace connection was not found.");
    }
    if (!connection.active || !connection.writeEnabled || connection.ownerUserId !== actor.userId) {
      throw new MarketplaceError("forbidden", "The marketplace connection is not available to this seller.");
    }
    const needed: MarketplaceCapability = capabilityForOperation(operation);
    if (!connection.capabilities.includes(needed)) {
      throw new MarketplaceError("capability_missing", "This marketplace connection does not advertise the requested write capability.");
    }
    deps.writeRegistry.get(connection.provider); // throws read_only_provider for read-only marketplaces
    return connection;
  }

  function moveTo(proposal: WriteProposalRecord, to: WriteProposalStatus, now: Date): void {
    if (!canTransitionWrite(proposal.status, to)) {
      throw new MarketplaceError("invalid_state", "This marketplace action cannot move to the requested state.");
    }
    proposal.status = to;
    proposal.updatedAt = now;
  }

  function assertOwner(proposal: WriteProposalRecord, actor: MarketplaceActor): void {
    if (proposal.ownerUserId !== actor.userId) throw new MarketplaceError("forbidden", "Only the owning seller can act on this marketplace write.");
  }

  async function issueToken(proposal: WriteProposalRecord, actor: MarketplaceActor, now: Date): Promise<string> {
    const token = signer.issue(
      { kind: "write", subjectId: proposal.id, actionHash: proposal.actionHash, companyId: proposal.companyId, userId: actor.userId },
      config.approvalTtlMs,
      now.getTime(),
    );
    proposal.approvalTokenHash = hashToken(token);
    proposal.approvalExpiresAt = new Date(now.getTime() + config.approvalTtlMs);
    return token;
  }

  async function freshListing(companyId: string, connection: ConnectionRecord, externalListingId: string, now: Date): Promise<ListingRecord> {
    const authoritative = await guardedCall(deps.rateLimit, companyId, connection.provider, "read_listings", () =>
      deps.readRegistry.get(connection.provider).read.getListing(
        { companyId, connectionId: connection.connectionId, provider: connection.provider },
        externalListingId,
        deps.http,
      ),
    );
    if (authoritative === null || authoritative.externalListingId !== externalListingId) {
      throw new MarketplaceError("provider_unavailable", "The marketplace listing could not be refreshed.");
    }
    const sourceHash = authoritative.sourceHash !== "" ? authoritative.sourceHash : sha256Hex(canonicalJson(authoritative));
    const previous = await deps.store.getListing(companyId, connection.connectionId, externalListingId);
    const record: ListingRecord = {
      companyId,
      connectionId: connection.connectionId,
      provider: connection.provider,
      externalListingId,
      sourceHash,
      listing: { ...authoritative, sourceHash },
      firstSeenAt: previous ? previous.firstSeenAt : now,
      lastSeenAt: now,
    };
    await deps.store.saveListing(record);
    return record;
  }

  return {
    signer,

    async prepare(companyId, actor, input, options = {}) {
      assertWritesEnabled(deps.env);
      assertWriteActor(companyId, actor);
      const operation = normaliseWriteOperation(input.operation);
      const connection = await loadWritableConnection(companyId, actor, input.connectionId, operation);
      const changes = sanitiseChanges(operation, input.changes);

      const key = input.idempotencyKey.trim();
      if (key === "" || [...key].length > 191) {
        throw new MarketplaceError("invalid_changes", "A bounded idempotency key is required.");
      }
      const actionHash = sha256Hex(
        canonicalJson({
          companyId,
          connectionId: connection.connectionId,
          externalListingId: input.externalListingId,
          operation,
          changesHash: changesHash(operation, changes),
          expectedSourceHash: input.expectedSourceHash,
        }),
      );

      const existing = await deps.store.findProposalByKey(companyId, connection.connectionId, key);
      if (existing) {
        if (!sameDigest(existing.actionHash, actionHash)) {
          throw new MarketplaceError("idempotency_conflict", "This idempotency key was already used for a different marketplace action.");
        }
        if (existing.status !== "prepared") return { proposal: existing, confirmationToken: null };
        const now = deps.clock();
        const token = await issueToken(existing, actor, now);
        existing.updatedAt = now;
        await deps.store.saveProposal(existing);
        return { proposal: existing, confirmationToken: token };
      }

      const listing = await deps.store.getListing(companyId, connection.connectionId, input.externalListingId);
      if (!listing || listing.companyId !== companyId) {
        throw new MarketplaceError("not_found", "Refresh this marketplace listing before preparing a write.");
      }

      if (operation === "update_price") {
        const current = listing.listing.priceMinor;
        const next = Number(changes.priceMinor);
        const exceeds = current === 0 ? next !== 0 : (Math.abs(next - current) * 10000) / current > config.maxPriceChangeBps;
        if (exceeds) {
          throw new MarketplaceError("spend_limit", "This price change is larger than the allowed limit. Make a smaller change.");
        }
      }

      const now = deps.clock();
      const internalAvailable =
        operation === "update_inventory" && deps.inventoryAvailable
          ? await deps.inventoryAvailable(companyId, connection.connectionId, input.externalListingId)
          : null;
      const assessment = assessConflicts({
        operation,
        changes,
        expectedSourceHash: input.expectedSourceHash,
        currentSourceHash: listing.sourceHash,
        lastSeenAt: listing.lastSeenAt,
        now,
        maximumSnapshotAgeSeconds: config.maxSnapshotAgeSeconds,
        internalAvailable,
        allowOversell: config.allowInventoryOversell,
      });

      const proposal: WriteProposalRecord = {
        id: newId(),
        companyId,
        connectionId: connection.connectionId,
        ownerUserId: actor.userId,
        provider: connection.provider,
        externalListingId: input.externalListingId,
        operation,
        status: assessment.blocking ? "conflict_blocked" : "prepared",
        idempotencyKey: key,
        actionHash,
        expectedSourceHash: input.expectedSourceHash,
        requestedChanges: changes,
        beforeState: stateForOperation(operation, listing.listing),
        afterState: null,
        afterSourceHash: null,
        rollbackState: stateForOperation(operation, listing.listing),
        conflicts: assessment.conflicts,
        warnings: assessment.warnings,
        approvalTokenHash: null,
        approvalExpiresAt: null,
        approvedBy: null,
        approvedAt: null,
        approvalSnapshot: null,
        batchId: options.batchId ?? null,
        errorCode: null,
        createdAt: now,
        updatedAt: now,
      };

      if (assessment.blocking || options.batchId !== undefined) {
        await deps.store.saveProposal(proposal);
        return { proposal, confirmationToken: null };
      }
      const token = await issueToken(proposal, actor, now);
      await deps.store.saveProposal(proposal);
      return { proposal, confirmationToken: token };
    },

    async confirm(companyId, actor, proposalId, token) {
      assertWritesEnabled(deps.env);
      assertWriteActor(companyId, actor);
      const proposal = await deps.store.getProposal(companyId, proposalId);
      if (!proposal) throw new MarketplaceError("not_found", "The marketplace write was not found.");
      assertOwner(proposal, actor);
      if (proposal.status === "approved") return proposal;
      if (proposal.status !== "prepared") {
        throw new MarketplaceError("invalid_state", "Only a conflict-free prepared write can be confirmed.");
      }
      const now = deps.clock();
      if (proposal.approvalTokenHash === null || proposal.approvalExpiresAt === null || proposal.approvalExpiresAt.getTime() <= now.getTime()) {
        throw new MarketplaceError("confirmation_expired", "The confirmation has expired. Prepare the action again.");
      }
      if (!sameDigest(proposal.approvalTokenHash, hashToken(token))) {
        throw new MarketplaceError("confirmation_invalid", "The confirmation token is invalid.");
      }
      const payload = signer.verify(token, now.getTime());
      if (
        payload.kind !== "write" ||
        payload.subjectId !== proposal.id ||
        payload.actionHash !== proposal.actionHash ||
        payload.companyId !== companyId ||
        payload.userId !== actor.userId
      ) {
        throw new MarketplaceError("confirmation_invalid", "The confirmation token does not match this action.");
      }
      moveTo(proposal, "approved", now);
      proposal.approvedBy = actor.userId;
      proposal.approvedAt = now;
      proposal.approvalTokenHash = null;
      proposal.approvalSnapshot = { jtiHash: sha256Hex(payload.jti), actionHash: proposal.actionHash, expectedSourceHash: proposal.expectedSourceHash };
      await deps.store.saveProposal(proposal);
      return proposal;
    },

    async approveForBatch(companyId, actor, proposalId, batchId, batchHash) {
      assertWritesEnabled(deps.env);
      assertWriteActor(companyId, actor);
      const proposal = await deps.store.getProposal(companyId, proposalId);
      if (!proposal) throw new MarketplaceError("not_found", "The marketplace write was not found.");
      if (proposal.status === "approved") return proposal;
      if (proposal.status !== "prepared" || proposal.ownerUserId !== actor.userId || proposal.batchId !== batchId) {
        throw new MarketplaceError("invalid_state", "Only an owned, prepared marketplace write in this batch can be approved.");
      }
      const now = deps.clock();
      moveTo(proposal, "approved", now);
      proposal.approvedBy = actor.userId;
      proposal.approvedAt = now;
      proposal.approvalTokenHash = null;
      proposal.approvalSnapshot = { mode: "bulk_batch", batchId, batchHash, actionHash: proposal.actionHash, expectedSourceHash: proposal.expectedSourceHash };
      await deps.store.saveProposal(proposal);
      return proposal;
    },

    async execute(companyId, actor, proposalId) {
      assertWritesEnabled(deps.env);
      assertWriteActor(companyId, actor);
      const proposal = await deps.store.getProposal(companyId, proposalId);
      if (!proposal) throw new MarketplaceError("not_found", "The marketplace write was not found.");
      assertOwner(proposal, actor);
      if (proposal.status === "executed") return proposal;
      if (proposal.status !== "approved" && proposal.status !== "failed") {
        throw new MarketplaceError("confirmation_required", "Marketplace write must be confirmed before execution.");
      }
      const connection = await loadWritableConnection(companyId, actor, proposal.connectionId, proposal.operation);
      const capability = capabilityForOperation(proposal.operation);
      const ref = { companyId, connectionId: connection.connectionId, provider: connection.provider };

      const now = deps.clock();
      const snapshot = await freshListing(companyId, connection, proposal.externalListingId, now);
      const internalAvailable =
        proposal.operation === "update_inventory" && deps.inventoryAvailable
          ? await deps.inventoryAvailable(companyId, connection.connectionId, proposal.externalListingId)
          : null;
      const assessment = assessConflicts({
        operation: proposal.operation,
        changes: proposal.requestedChanges,
        expectedSourceHash: proposal.expectedSourceHash,
        currentSourceHash: snapshot.sourceHash,
        lastSeenAt: snapshot.lastSeenAt,
        now,
        maximumSnapshotAgeSeconds: config.maxSnapshotAgeSeconds,
        internalAvailable,
        allowOversell: config.allowInventoryOversell,
      });
      if (assessment.blocking) {
        proposal.conflicts = assessment.conflicts;
        moveTo(proposal, "conflict_blocked", now);
        await deps.store.saveProposal(proposal);
        return proposal;
      }

      // Consumes a rate-limit slot. A denied call leaves the proposal approved, so it can be retried later.
      const decision = await deps.rateLimit.acquire(companyId, connection.provider, capability);
      if (!decision.allowed) {
        throw new MarketplaceError("rate_limited", "The marketplace write limit has been reached. Try again later.", decision.retryAfterMs);
      }

      if (proposal.status === "failed") moveTo(proposal, "approved", now); // a retry starts from approved
      moveTo(proposal, "executing", now);
      await deps.store.saveProposal(proposal);

      let result;
      try {
        const request: ProviderWriteRequest = {
          externalListingId: proposal.externalListingId,
          operation: capability,
          providerOperation: proposal.operation,
          changes: proposal.requestedChanges,
          expectedSourceHash: proposal.expectedSourceHash,
          idempotencyKey: proposal.idempotencyKey,
        };
        result = await deps.writeRegistry.get(connection.provider).execute(ref, request, deps.http);
      } catch {
        // The outcome at the provider is unknown. The idempotency key lets a retry resume safely.
        await deps.rateLimit.recordFailure(companyId, connection.provider, capability, "write_failed");
        proposal.status = "failed";
        proposal.errorCode = "provider_unavailable";
        proposal.updatedAt = deps.clock();
        await deps.store.saveProposal(proposal);
        return proposal;
      }

      const done = deps.clock();
      if (result.status === "applied") {
        proposal.status = "executed";
        proposal.afterState = afterStateFor(proposal.operation, proposal.requestedChanges);
        proposal.afterSourceHash = result.sourceHash;
        proposal.rollbackState = result.rollbackState;
        proposal.errorCode = null;
      } else if (result.status === "conflict") {
        const finding: ConflictFinding = {
          code: "source_version_changed",
          message: "The marketplace listing changed while the write was running.",
          details: { expectedSourceHash: proposal.expectedSourceHash, actualSourceHash: result.currentSourceHash },
        };
        proposal.conflicts = [finding];
        proposal.status = "conflict_blocked";
      } else {
        proposal.status = "failed";
        proposal.errorCode = result.errorCode.slice(0, 64);
      }
      proposal.updatedAt = done;
      await deps.store.saveProposal(proposal);
      return proposal;
    },

    async rollback(companyId, actor, proposalId) {
      assertWritesEnabled(deps.env);
      assertWriteActor(companyId, actor);
      const proposal = await deps.store.getProposal(companyId, proposalId);
      if (!proposal) throw new MarketplaceError("not_found", "The marketplace write was not found.");
      assertOwner(proposal, actor);
      if (proposal.status === "rolled_back") return proposal;
      if (proposal.status !== "executed" && proposal.status !== "rollback_failed") {
        throw new MarketplaceError("invalid_state", "Only an executed marketplace write can be rolled back.");
      }
      if (proposal.afterSourceHash === null) {
        throw new MarketplaceError("invalid_state", "The write has no recorded result to roll back from.");
      }
      const connection = await loadWritableConnection(companyId, actor, proposal.connectionId, proposal.operation);
      const capability = capabilityForOperation(proposal.operation);
      const now = deps.clock();
      const snapshot = await freshListing(companyId, connection, proposal.externalListingId, now);
      if (!sameDigest(proposal.afterSourceHash, snapshot.sourceHash)) {
        throw new MarketplaceError("stale_or_conflict", "The listing changed after this action. Review the newer state before rollback.");
      }
      const decision = await deps.rateLimit.acquire(companyId, connection.provider, capability);
      if (!decision.allowed) {
        throw new MarketplaceError("rate_limited", "The marketplace write limit has been reached. Try again later.", decision.retryAfterMs);
      }

      let result;
      try {
        const request: ProviderRollbackRequest = {
          externalListingId: proposal.externalListingId,
          operation: capability,
          providerOperation: proposal.operation,
          changes: {},
          expectedSourceHash: proposal.afterSourceHash,
          idempotencyKey: `rollback:${proposal.idempotencyKey}`,
          rollbackState: proposal.rollbackState,
        };
        result = await deps.writeRegistry.get(connection.provider).rollback(
          { companyId, connectionId: connection.connectionId, provider: connection.provider },
          request,
          deps.http,
        );
      } catch {
        await deps.rateLimit.recordFailure(companyId, connection.provider, capability, "rollback_failed");
        proposal.status = "rollback_failed";
        proposal.errorCode = "provider_unavailable";
        proposal.updatedAt = deps.clock();
        await deps.store.saveProposal(proposal);
        return proposal;
      }

      const done = deps.clock();
      if (result.status === "applied") {
        moveTo(proposal, "rolled_back", done);
        proposal.errorCode = null;
      } else {
        proposal.status = "rollback_failed";
        proposal.errorCode = result.status === "conflict" ? "stale_or_conflict" : result.errorCode.slice(0, 64);
        proposal.updatedAt = done;
      }
      await deps.store.saveProposal(proposal);
      return proposal;
    },
  };
}
