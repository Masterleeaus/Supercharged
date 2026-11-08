/**
 * Storage port for the marketplace slice, plus an in-memory implementation for tests and local runs.
 * Every method takes companyId. A row whose company differs from the argument is treated as absent.
 * The Drizzle implementation (db/commerce-marketplace.ts) follows the same rules; see DECISIONS.md.
 */
import type { MarketplaceCapability, MarketplaceListing, MarketplaceProviderKey } from "../../contracts/index.ts";
import type { MarketplaceWriteOperation, WriteProposalStatus, BulkBatchStatus, BulkItemStatus } from "./operations.ts";
import type { ConflictFinding } from "./conflicts.ts";

export interface ConnectionRecord {
  companyId: string;
  connectionId: string;
  provider: MarketplaceProviderKey;
  ownerUserId: string;
  active: boolean;
  writeEnabled: boolean;
  capabilities: MarketplaceCapability[];
}

export interface ListingRecord {
  companyId: string;
  connectionId: string;
  provider: MarketplaceProviderKey;
  externalListingId: string;
  sourceHash: string;
  listing: MarketplaceListing;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface WriteProposalRecord {
  id: string;
  companyId: string;
  connectionId: string;
  ownerUserId: string;
  provider: MarketplaceProviderKey;
  externalListingId: string;
  operation: MarketplaceWriteOperation;
  status: WriteProposalStatus;
  idempotencyKey: string;
  actionHash: string;
  expectedSourceHash: string;
  requestedChanges: Record<string, unknown>;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown> | null;
  afterSourceHash: string | null;
  rollbackState: Record<string, unknown>;
  conflicts: ConflictFinding[];
  warnings: ConflictFinding[];
  approvalTokenHash: string | null;
  approvalExpiresAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  approvalSnapshot: Record<string, unknown> | null;
  batchId: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BulkBatchRecord {
  id: string;
  companyId: string;
  connectionId: string;
  ownerUserId: string;
  provider: MarketplaceProviderKey;
  operation: MarketplaceWriteOperation;
  status: BulkBatchStatus;
  idempotencyKey: string;
  batchHash: string;
  selectionFilters: Record<string, unknown>;
  changeTemplate: Record<string, unknown>;
  selectedCount: number;
  eligibleCount: number;
  blockedCount: number;
  succeededCount: number;
  failedCount: number;
  rolledBackCount: number;
  impactSummary: Record<string, number>;
  approvalTokenHash: string | null;
  approvalExpiresAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BulkItemRecord {
  id: string;
  companyId: string;
  batchId: string;
  proposalId: string | null;
  externalListingId: string;
  status: BulkItemStatus;
  errorCode: string | null;
  proposedChanges: Record<string, unknown>;
  impact: Record<string, number>;
  conflicts: ConflictFinding[];
  updatedAt: Date;
}

export interface MarketplaceStore {
  getConnection(companyId: string, connectionId: string): Promise<ConnectionRecord | null>;
  listConnections(companyId: string): Promise<ConnectionRecord[]>;

  getListing(companyId: string, connectionId: string, externalListingId: string): Promise<ListingRecord | null>;
  /** Newest first by lastSeenAt. Limit is applied after company and connection filtering. */
  listListings(companyId: string, connectionId: string, limit: number): Promise<ListingRecord[]>;
  saveListing(record: ListingRecord): Promise<void>;

  getProposal(companyId: string, id: string): Promise<WriteProposalRecord | null>;
  findProposalByKey(companyId: string, connectionId: string, idempotencyKey: string): Promise<WriteProposalRecord | null>;
  saveProposal(record: WriteProposalRecord): Promise<void>;

  getBatch(companyId: string, id: string): Promise<BulkBatchRecord | null>;
  findBatchByKey(companyId: string, connectionId: string, idempotencyKey: string): Promise<BulkBatchRecord | null>;
  saveBatch(record: BulkBatchRecord): Promise<void>;
  listBatchItems(companyId: string, batchId: string): Promise<BulkItemRecord[]>;
  saveBatchItem(record: BulkItemRecord): Promise<void>;
}

/** In-memory store. Keys include companyId, and every read compares companyId, so tenants cannot cross. */
export interface MemoryMarketplaceStore extends MarketplaceStore {
  /** Seeds or replaces a connection. Used by the caller that owns connection setup, and by tests. */
  putConnection(record: ConnectionRecord): void;
}

export function createMemoryMarketplaceStore(): MemoryMarketplaceStore {
  const connections = new Map<string, ConnectionRecord>();
  const listings = new Map<string, ListingRecord>();
  const proposals = new Map<string, WriteProposalRecord>();
  const batches = new Map<string, BulkBatchRecord>();
  const items = new Map<string, BulkItemRecord>();
  const cKey = (companyId: string, id: string): string => `${companyId}\u0000${id}`;
  const lKey = (r: { companyId: string; connectionId: string; externalListingId: string }): string =>
    `${r.companyId}\u0000${r.connectionId}\u0000${r.externalListingId}`;

  const clone = <T>(value: T): T => structuredClone(value);

  return {
    putConnection(record) {
      connections.set(cKey(record.companyId, record.connectionId), clone(record));
    },
    async getConnection(companyId, connectionId) {
      const row = connections.get(cKey(companyId, connectionId));
      return row && row.companyId === companyId ? clone(row) : null;
    },
    async listConnections(companyId) {
      return [...connections.values()].filter((r) => r.companyId === companyId).map(clone);
    },
    async getListing(companyId, connectionId, externalListingId) {
      const row = listings.get(lKey({ companyId, connectionId, externalListingId }));
      return row && row.companyId === companyId && row.connectionId === connectionId ? clone(row) : null;
    },
    async listListings(companyId, connectionId, limit) {
      return [...listings.values()]
        .filter((r) => r.companyId === companyId && r.connectionId === connectionId)
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())
        .slice(0, limit)
        .map(clone);
    },
    async saveListing(record) {
      listings.set(lKey(record), clone(record));
    },
    async getProposal(companyId, id) {
      const row = proposals.get(cKey(companyId, id));
      return row && row.companyId === companyId ? clone(row) : null;
    },
    async findProposalByKey(companyId, connectionId, idempotencyKey) {
      const row = [...proposals.values()].find(
        (r) => r.companyId === companyId && r.connectionId === connectionId && r.idempotencyKey === idempotencyKey,
      );
      return row ? clone(row) : null;
    },
    async saveProposal(record) {
      proposals.set(cKey(record.companyId, record.id), clone(record));
    },
    async getBatch(companyId, id) {
      const row = batches.get(cKey(companyId, id));
      return row && row.companyId === companyId ? clone(row) : null;
    },
    async findBatchByKey(companyId, connectionId, idempotencyKey) {
      const row = [...batches.values()].find(
        (r) => r.companyId === companyId && r.connectionId === connectionId && r.idempotencyKey === idempotencyKey,
      );
      return row ? clone(row) : null;
    },
    async saveBatch(record) {
      batches.set(cKey(record.companyId, record.id), clone(record));
    },
    async listBatchItems(companyId, batchId) {
      return [...items.values()].filter((r) => r.companyId === companyId && r.batchId === batchId).map(clone);
    },
    async saveBatchItem(record) {
      items.set(cKey(record.companyId, record.id), clone(record));
    },
  };
}
