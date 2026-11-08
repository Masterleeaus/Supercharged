/**
 * Record shapes for the order-ops slice: marketplace inventory reconciliation, marketplace order import,
 * the unified order projection, order exceptions, the workbench, and settlement.
 *
 * Every record carries companyId. Storage reads and writes only rows whose companyId matches the caller.
 * Money is an integer in minor units. Percentages are basis points. Ids are strings (uuid or varchar).
 */
import type { MarketplaceProviderKey } from "../../contracts/index.ts";

export type Id = string;

/** Thrown for validation failures (422) and for rows that are absent or belong to another company (404). */
export class OrderOpsError extends Error {
  readonly status: number;

  constructor(message: string, status = 422) {
    super(message);
    this.name = "OrderOpsError";
    this.status = status;
  }
}

/** Identifies one marketplace connection for one chatbot. The credentials are loaded elsewhere. */
export interface ConnectionScope {
  companyId: string;
  chatbotId: string;
  connectionId: string;
  provider: MarketplaceProviderKey;
  ownerUserId: string;
}

// ---------------------------------------------------------------------------
// Inventory reconciliation
// ---------------------------------------------------------------------------

export const INVENTORY_CONFLICT_CODES = ["in_sync", "external_state_stale", "external_above_target", "external_below_target"] as const;
export type InventoryConflictCode = (typeof INVENTORY_CONFLICT_CODES)[number];

export const INVENTORY_CONFLICT_STATUSES = ["open", "acknowledged", "resolution_prepared", "ignored", "resolved"] as const;
export type InventoryConflictStatus = (typeof INVENTORY_CONFLICT_STATUSES)[number];

export interface InventoryPolicy {
  id: Id;
  companyId: string;
  chatbotId: string;
  /** Null applies the policy to every connection of the chatbot. */
  connectionId: string | null;
  active: boolean;
  sourceOfTruth: "internal" | "external";
  resolutionMode: "suggest_only" | "auto_prepare";
  allocationMode: "mirror" | "equal_share" | "percentage" | "percentage_cap" | "fixed_cap";
  allocationBps: number;
  bufferQuantity: number;
  minimumQuantity: number;
  maximumQuantity: number | null;
  maximumSyncAgeSeconds: number;
  quantityTolerance: number;
  maximumAutoDelta: number;
  requireFreshSnapshot: boolean;
  autoMapBySku: boolean;
}

export interface ListingSnapshot {
  id: Id;
  companyId: string;
  chatbotId: string;
  connectionId: string;
  provider: MarketplaceProviderKey;
  externalListingId: string;
  sourceHash: string;
  snapshot: Record<string, unknown>;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface InventoryMapping {
  id: Id;
  companyId: string;
  chatbotId: string;
  connectionId: string;
  listingSnapshotId: Id | null;
  variantId: Id;
  locationId: Id | null;
  externalListingId: string;
  sku: string | null;
  active: boolean;
  verified: boolean;
  /** Per-mapping overrides of the policy allocation. Null means use the policy value. */
  allocationMode: string | null;
  allocationBps: number | null;
  bufferQuantity: number | null;
  minimumQuantity: number | null;
  maximumQuantity: number | null;
  lastExternalQuantity: number | null;
  lastTargetQuantity: number | null;
  lastSourceHash: string | null;
  lastScannedAt: Date | null;
  lastInSyncAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface ScanRun {
  id: Id;
  companyId: string;
  chatbotId: string;
  connectionId: string;
  ownerUserId: string | null;
  status: "running" | "completed" | "failed";
  mappingCount: number;
  inSyncCount: number;
  conflictCount: number;
  criticalCount: number;
  correctionsPrepared: number;
  failureHash: string | null;
  startedAt: Date;
  completedAt: Date | null;
  metadata: Record<string, unknown>;
}

export interface InventoryConflict {
  id: Id;
  companyId: string;
  chatbotId: string;
  connectionId: string;
  mappingId: Id;
  scanRunId: Id | null;
  provider: MarketplaceProviderKey;
  externalListingId: string;
  code: InventoryConflictCode;
  severity: "none" | "warning" | "critical";
  status: InventoryConflictStatus;
  canonicalQuantity: number;
  targetQuantity: number;
  externalQuantity: number;
  delta: number;
  oversellExposure: number;
  canonicalVersion: number;
  sourceHash: string;
  observedAt: Date;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  assessment: Record<string, unknown>;
  resolutionMode: string | null;
  acknowledgedByUserId: string | null;
  acknowledgedAt: Date | null;
  ignoredByUserId: string | null;
  ignoredAt: Date | null;
  ignoredUntil: Date | null;
  ignoreReason: string | null;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  writeProposalId: Id | null;
  metadata: Record<string, unknown>;
}

/** Append-only. Every status change, observation and correction is one event. Never updated or deleted. */
export interface InventoryConflictEvent {
  id: Id;
  companyId: string;
  conflictId: Id;
  eventType: string;
  actorType: "system" | "seller";
  actorUserId: string | null;
  statusBefore: string | null;
  statusAfter: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

// ---------------------------------------------------------------------------
// Marketplace order import
// ---------------------------------------------------------------------------

export interface SyncCursor {
  id: Id;
  companyId: string;
  connectionId: string;
  scope: string;
  cursor: Record<string, unknown>;
  lastSyncedAt: Date | null;
}

export interface ImportRun {
  id: Id;
  companyId: string;
  chatbotId: string;
  connectionId: string;
  scope: string;
  status: "running" | "completed" | "failed";
  cursorBefore: Record<string, unknown>;
  cursorAfter: Record<string, unknown> | null;
  recordsRead: number;
  recordsRejected: number;
  recordsCreated: number;
  recordsUpdated: number;
  failureReason: string | null;
  startedAt: Date;
  completedAt: Date | null;
}

export interface MarketplaceOrder {
  id: Id;
  companyId: string;
  chatbotId: string;
  connectionId: string;
  provider: MarketplaceProviderKey;
  externalOrderId: string;
  status: string;
  fulfillmentStatus: string | null;
  currency: string;
  totalAmount: number;
  buyerDisplayName: string | null;
  sourceHash: string;
  snapshot: Record<string, unknown>;
  placedAt: Date | null;
  providerUpdatedAt: Date | null;
  firstImportedAt: Date;
  lastImportedAt: Date;
}

export interface MarketplaceOrderLine {
  id: Id;
  companyId: string;
  orderId: Id;
  externalLineId: string;
  sku: string | null;
  title: string;
  quantity: number;
  unitAmount: number;
  taxAmount: number;
  snapshot: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Unified order projection
// ---------------------------------------------------------------------------

export interface UnifiedOrder {
  id: Id;
  companyId: string;
  chatbotId: string;
  sourceType: string;
  sourceScope: string;
  sourceOrderId: string;
  nativeOrderId: string | null;
  marketplaceOrderId: Id | null;
  connectionId: string | null;
  externalAuthoritative: boolean;
  status: string;
  fulfillmentStatus: string;
  paymentStatus: string;
  currency: string;
  grossTotal: number;
  discountTotal: number;
  taxTotal: number;
  shippingTotal: number;
  refundTotal: number;
  chargebackTotal: number;
  feeTotal: number;
  shippingCostTotal: number;
  expectedNetPayout: number;
  reportedNetPayout: number;
  settlementVariance: number;
  reconciliationStatus: string;
  buyerDisplayName: string | null;
  shippingAddress: Record<string, unknown>;
  placedAt: Date | null;
  sourceUpdatedAt: Date | null;
  sourceSnapshot: Record<string, unknown>;
  sourceHash: string;
  metadata: Record<string, unknown>;
  lastProjectedAt: Date;
}

export interface UnifiedSourceSnapshot {
  id: Id;
  companyId: string;
  unifiedOrderId: Id;
  sequence: number;
  sourceHash: string;
  snapshot: Record<string, unknown>;
  capturedAt: Date;
}

// ---------------------------------------------------------------------------
// Order exceptions
// ---------------------------------------------------------------------------

export const EXCEPTION_TYPES = [
  "invalid_address",
  "payment_failure",
  "fulfillment_delay",
  "stock_conflict",
  "disputed_return",
  "settlement_variance",
] as const;
export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

export interface OrderException {
  id: Id;
  companyId: string;
  chatbotId: string;
  unifiedOrderId: Id;
  exceptionType: ExceptionType;
  fingerprint: string;
  severity: "warning" | "high" | "critical";
  status: "open" | "acknowledged" | "resolved";
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  assignedUserId: string | null;
  acknowledgedByUserId: string | null;
  acknowledgedAt: Date | null;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  metadata: Record<string, unknown>;
}

/** Audit trail for exceptions. Append-only. Holds the state before and after each change. */
export interface OrderExceptionEvent {
  id: Id;
  companyId: string;
  exceptionId: Id;
  eventType: string;
  actorType: "system" | "user" | null;
  actorUserId: string | null;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

// ---------------------------------------------------------------------------
// Workbench actions
// ---------------------------------------------------------------------------

export interface WorkbenchAction {
  id: Id;
  companyId: string;
  chatbotId: string;
  unifiedOrderId: Id;
  exceptionId: Id | null;
  actionType: string;
  status: "processing" | "completed" | "awaiting_approval" | "prepared";
  idempotencyKey: string;
  requestHash: string;
  requestedByUserId: string;
  assignedToUserId: string | null;
  amount: number | null;
  currency: string | null;
  sourceHash: string;
  proposal: Record<string, unknown>;
  result: Record<string, unknown> | null;
  expiresAt: Date | null;
  executedAt: Date | null;
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export interface SettlementEntry {
  id: Id;
  companyId: string;
  chatbotId: string;
  unifiedOrderId: Id;
  provider: string;
  sourceScope: string;
  externalEntryId: string;
  sourceBatchId: string | null;
  entryType: string;
  amount: number;
  currency: string;
  sourceHash: string;
  sourceSnapshot: Record<string, unknown>;
  occurredAt: Date | null;
  importedAt: Date;
}

export interface SettlementReconciliation {
  id: Id;
  companyId: string;
  chatbotId: string;
  unifiedOrderId: Id;
  calculationHash: string;
  calculation: Record<string, unknown>;
  report: SettlementReport;
  evidence: Record<string, unknown>;
  reconciledAt: Date;
}

export interface SettlementReportLine {
  kind: "expected" | "reported";
  entryType: string;
  label: string;
  amountMinor: number;
}

export interface SettlementReport {
  currency: string;
  lines: SettlementReportLine[];
  /** Sum of the expected lines. Equals the sum of lines, checked when the report is built. */
  expectedNetMinor: number;
  /** Sum of the reported (payout) lines. */
  reportedNetMinor: number;
  varianceMinor: number;
  status: "awaiting_payout" | "reconciled" | "variance";
}

// ---------------------------------------------------------------------------
// Outbox (state changes are recorded in the same transaction as the change)
// ---------------------------------------------------------------------------

export interface OrderOpsOutboxRow {
  id: Id;
  companyId: string;
  topic: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  status: "pending" | "published" | "failed";
  attempts: number;
  availableAt: Date;
  publishedAt: Date | null;
  createdAt: Date;
}
