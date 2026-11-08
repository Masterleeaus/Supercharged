/*
 * Drizzle tables for the commerce order-ops slice: marketplace inventory reconciliation, marketplace order
 * import, the unified order projection, order exceptions and their audit trail, workbench actions, and
 * settlement. DRAFT. Not added to shared/schema.ts and no migration is applied. The SQL draft is
 * db/migrations-draft/0310_commerce_order_ops.sql. Record shapes live in commerce/order-ops/types.ts.
 *
 * Every table carries company_id (NOT NULL) with an index. Primary keys are (company_id, id), so an id is only
 * unique inside a company. Every unique constraint includes company_id. Money is bigint in integer minor units.
 * The audit tables (inventory conflict events, exception events) are append-only. The application issues INSERT
 * and SELECT only. Promotion should add a trigger that rejects UPDATE and DELETE.
 *
 * The outbox is not defined here. The runtime owns OutboxStorage, and this slice writes to it through a port.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

const id = () => varchar("id", { length: 191 }).notNull().default(sql`gen_random_uuid()::text`);
const companyId = () => uuid("company_id").notNull();
const money = (name: string) => bigint(name, { mode: "number" });
const json = <T>(name: string, fallback: string) => jsonb(name).$type<T>().notNull().default(sql.raw(fallback));

export const chatbotCommerceInventoryPolicies = pgTable(
  "chatbot_commerce_inventory_policies",
  {
    id: id(),
    companyId: companyId(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    connectionId: varchar("connection_id", { length: 191 }),
    active: boolean("active").notNull().default(true),
    sourceOfTruth: varchar("source_of_truth", { length: 16 }).notNull().default("internal"),
    resolutionMode: varchar("resolution_mode", { length: 24 }).notNull().default("suggest_only"),
    allocationMode: varchar("allocation_mode", { length: 24 }).notNull().default("equal_share"),
    allocationBps: integer("allocation_bps").notNull().default(10000),
    bufferQuantity: integer("buffer_quantity").notNull().default(0),
    minimumQuantity: integer("minimum_quantity").notNull().default(0),
    maximumQuantity: integer("maximum_quantity"),
    maximumSyncAgeSeconds: integer("maximum_sync_age_seconds").notNull().default(300),
    quantityTolerance: integer("quantity_tolerance").notNull().default(0),
    maximumAutoDelta: integer("maximum_auto_delta").notNull().default(0),
    requireFreshSnapshot: boolean("require_fresh_snapshot").notNull().default(true),
    autoMapBySku: boolean("auto_map_by_sku").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_inventory_policies_pk", columns: [t.companyId, t.id] }),
    index("chatbot_commerce_inventory_policies_company_chatbot_idx").on(t.companyId, t.chatbotId),
  ],
);

export const chatbotCommerceListingSnapshots = pgTable(
  "chatbot_commerce_listing_snapshots",
  {
    id: id(),
    companyId: companyId(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    connectionId: varchar("connection_id", { length: 191 }).notNull(),
    provider: varchar("provider", { length: 24 }).notNull(),
    externalListingId: varchar("external_listing_id", { length: 191 }).notNull(),
    sourceHash: varchar("source_hash", { length: 64 }).notNull(),
    snapshot: json<Record<string, unknown>>("snapshot", "'{}'::jsonb"),
    firstSeenAt: timestamp("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_listing_snapshots_pk", columns: [t.companyId, t.id] }),
    uniqueIndex("chatbot_commerce_listing_snapshots_company_listing_uidx").on(t.companyId, t.connectionId, t.externalListingId),
    index("chatbot_commerce_listing_snapshots_company_chatbot_idx").on(t.companyId, t.chatbotId),
  ],
);

export const chatbotCommerceInventoryMappings = pgTable(
  "chatbot_commerce_inventory_mappings",
  {
    id: id(),
    companyId: companyId(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    connectionId: varchar("connection_id", { length: 191 }).notNull(),
    listingSnapshotId: varchar("listing_snapshot_id", { length: 191 }),
    variantId: varchar("variant_id", { length: 191 }).notNull(),
    locationId: varchar("location_id", { length: 191 }),
    externalListingId: varchar("external_listing_id", { length: 191 }).notNull(),
    sku: varchar("sku", { length: 191 }),
    active: boolean("active").notNull().default(true),
    verified: boolean("verified").notNull().default(false),
    allocationMode: varchar("allocation_mode", { length: 24 }),
    allocationBps: integer("allocation_bps"),
    bufferQuantity: integer("buffer_quantity"),
    minimumQuantity: integer("minimum_quantity"),
    maximumQuantity: integer("maximum_quantity"),
    lastExternalQuantity: integer("last_external_quantity"),
    lastTargetQuantity: integer("last_target_quantity"),
    lastSourceHash: varchar("last_source_hash", { length: 64 }),
    lastScannedAt: timestamp("last_scanned_at"),
    lastInSyncAt: timestamp("last_in_sync_at"),
    metadata: json<Record<string, unknown>>("metadata", "'{}'::jsonb"),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_inventory_mappings_pk", columns: [t.companyId, t.id] }),
    uniqueIndex("chatbot_commerce_inventory_mappings_company_listing_uidx").on(t.companyId, t.connectionId, t.externalListingId),
    index("chatbot_commerce_inventory_mappings_company_variant_idx").on(t.companyId, t.variantId),
  ],
);

export const chatbotCommerceInventoryScanRuns = pgTable(
  "chatbot_commerce_inventory_scan_runs",
  {
    id: id(),
    companyId: companyId(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    connectionId: varchar("connection_id", { length: 191 }).notNull(),
    ownerUserId: varchar("owner_user_id", { length: 191 }),
    status: varchar("status", { length: 16 }).notNull(),
    mappingCount: integer("mapping_count").notNull().default(0),
    inSyncCount: integer("in_sync_count").notNull().default(0),
    conflictCount: integer("conflict_count").notNull().default(0),
    criticalCount: integer("critical_count").notNull().default(0),
    correctionsPrepared: integer("corrections_prepared").notNull().default(0),
    failureHash: varchar("failure_hash", { length: 64 }),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
    metadata: json<Record<string, unknown>>("metadata", "'{}'::jsonb"),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_inventory_scan_runs_pk", columns: [t.companyId, t.id] }),
    index("chatbot_commerce_inventory_scan_runs_company_connection_idx").on(t.companyId, t.connectionId),
  ],
);

export const chatbotCommerceInventoryConflicts = pgTable(
  "chatbot_commerce_inventory_conflicts",
  {
    id: id(),
    companyId: companyId(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    connectionId: varchar("connection_id", { length: 191 }).notNull(),
    mappingId: varchar("mapping_id", { length: 191 }).notNull(),
    scanRunId: varchar("scan_run_id", { length: 191 }),
    provider: varchar("provider", { length: 24 }).notNull(),
    externalListingId: varchar("external_listing_id", { length: 191 }).notNull(),
    code: varchar("code", { length: 40 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    canonicalQuantity: integer("canonical_quantity").notNull(),
    targetQuantity: integer("target_quantity").notNull(),
    externalQuantity: integer("external_quantity").notNull(),
    delta: integer("delta").notNull(),
    oversellExposure: integer("oversell_exposure").notNull().default(0),
    canonicalVersion: integer("canonical_version").notNull().default(0),
    sourceHash: varchar("source_hash", { length: 64 }).notNull(),
    observedAt: timestamp("observed_at").notNull(),
    firstDetectedAt: timestamp("first_detected_at").notNull(),
    lastDetectedAt: timestamp("last_detected_at").notNull(),
    assessment: json<Record<string, unknown>>("assessment", "'{}'::jsonb"),
    resolutionMode: varchar("resolution_mode", { length: 24 }),
    acknowledgedByUserId: varchar("acknowledged_by_user_id", { length: 191 }),
    acknowledgedAt: timestamp("acknowledged_at"),
    ignoredByUserId: varchar("ignored_by_user_id", { length: 191 }),
    ignoredAt: timestamp("ignored_at"),
    ignoredUntil: timestamp("ignored_until"),
    ignoreReason: varchar("ignore_reason", { length: 500 }),
    resolvedByUserId: varchar("resolved_by_user_id", { length: 191 }),
    resolvedAt: timestamp("resolved_at"),
    writeProposalId: varchar("write_proposal_id", { length: 191 }),
    metadata: json<Record<string, unknown>>("metadata", "'{}'::jsonb"),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_inventory_conflicts_pk", columns: [t.companyId, t.id] }),
    index("chatbot_commerce_inventory_conflicts_company_connection_status_idx").on(t.companyId, t.connectionId, t.status),
    index("chatbot_commerce_inventory_conflicts_company_mapping_idx").on(t.companyId, t.mappingId),
  ],
);

export const chatbotCommerceInventoryConflictEvents = pgTable(
  "chatbot_commerce_inventory_conflict_events",
  {
    id: id(),
    companyId: companyId(),
    conflictId: varchar("conflict_id", { length: 191 }).notNull(),
    eventType: varchar("event_type", { length: 40 }).notNull(),
    actorType: varchar("actor_type", { length: 16 }).notNull(),
    actorUserId: varchar("actor_user_id", { length: 191 }),
    statusBefore: varchar("status_before", { length: 24 }),
    statusAfter: varchar("status_after", { length: 24 }),
    payload: json<Record<string, unknown>>("payload", "'{}'::jsonb"),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_inventory_conflict_events_pk", columns: [t.companyId, t.id] }),
    index("chatbot_commerce_inventory_conflict_events_company_conflict_idx").on(t.companyId, t.conflictId),
  ],
);

export const chatbotCommerceSyncCursors = pgTable(
  "chatbot_commerce_sync_cursors",
  {
    id: id(),
    companyId: companyId(),
    connectionId: varchar("connection_id", { length: 191 }).notNull(),
    scope: varchar("scope", { length: 40 }).notNull(),
    cursor: json<Record<string, unknown>>("cursor", "'{}'::jsonb"),
    lastSyncedAt: timestamp("last_synced_at"),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_sync_cursors_pk", columns: [t.companyId, t.id] }),
    uniqueIndex("chatbot_commerce_sync_cursors_company_connection_scope_uidx").on(t.companyId, t.connectionId, t.scope),
  ],
);

export const chatbotCommerceImportRuns = pgTable(
  "chatbot_commerce_import_runs",
  {
    id: id(),
    companyId: companyId(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    connectionId: varchar("connection_id", { length: 191 }).notNull(),
    scope: varchar("scope", { length: 40 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    cursorBefore: json<Record<string, unknown>>("cursor_before", "'{}'::jsonb"),
    cursorAfter: jsonb("cursor_after").$type<Record<string, unknown>>(),
    recordsRead: integer("records_read").notNull().default(0),
    recordsRejected: integer("records_rejected").notNull().default(0),
    recordsCreated: integer("records_created").notNull().default(0),
    recordsUpdated: integer("records_updated").notNull().default(0),
    failureReason: varchar("failure_reason", { length: 500 }),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_import_runs_pk", columns: [t.companyId, t.id] }),
    index("chatbot_commerce_import_runs_company_connection_idx").on(t.companyId, t.connectionId),
  ],
);

export const chatbotCommerceMarketplaceOrders = pgTable(
  "chatbot_commerce_marketplace_orders",
  {
    id: id(),
    companyId: companyId(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    connectionId: varchar("connection_id", { length: 191 }).notNull(),
    provider: varchar("provider", { length: 24 }).notNull(),
    externalOrderId: varchar("external_order_id", { length: 191 }).notNull(),
    status: varchar("status", { length: 40 }).notNull(),
    fulfillmentStatus: varchar("fulfillment_status", { length: 40 }),
    currency: varchar("currency", { length: 3 }).notNull(),
    totalAmount: money("total_amount").notNull(),
    buyerDisplayName: varchar("buyer_display_name", { length: 191 }),
    sourceHash: varchar("source_hash", { length: 64 }).notNull(),
    snapshot: json<Record<string, unknown>>("snapshot", "'{}'::jsonb"),
    placedAt: timestamp("placed_at"),
    providerUpdatedAt: timestamp("provider_updated_at"),
    firstImportedAt: timestamp("first_imported_at").notNull().defaultNow(),
    lastImportedAt: timestamp("last_imported_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_marketplace_orders_pk", columns: [t.companyId, t.id] }),
    uniqueIndex("chatbot_commerce_marketplace_orders_company_external_uidx").on(t.companyId, t.connectionId, t.externalOrderId),
    index("chatbot_commerce_marketplace_orders_company_chatbot_idx").on(t.companyId, t.chatbotId),
  ],
);

export const chatbotCommerceMarketplaceOrderLines = pgTable(
  "chatbot_commerce_marketplace_order_lines",
  {
    id: id(),
    companyId: companyId(),
    orderId: varchar("order_id", { length: 191 }).notNull(),
    externalLineId: varchar("external_line_id", { length: 191 }).notNull(),
    sku: varchar("sku", { length: 191 }),
    title: varchar("title", { length: 500 }).notNull(),
    quantity: integer("quantity").notNull(),
    unitAmount: money("unit_amount").notNull(),
    taxAmount: money("tax_amount").notNull().default(0),
    snapshot: json<Record<string, unknown>>("snapshot", "'{}'::jsonb"),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_marketplace_order_lines_pk", columns: [t.companyId, t.id] }),
    uniqueIndex("chatbot_commerce_marketplace_order_lines_company_line_uidx").on(t.companyId, t.orderId, t.externalLineId),
  ],
);

export const chatbotCommerceUnifiedOrders = pgTable(
  "chatbot_commerce_unified_orders",
  {
    id: id(),
    companyId: companyId(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    sourceType: varchar("source_type", { length: 40 }).notNull(),
    sourceScope: varchar("source_scope", { length: 191 }).notNull(),
    sourceOrderId: varchar("source_order_id", { length: 191 }).notNull(),
    nativeOrderId: varchar("native_order_id", { length: 191 }),
    marketplaceOrderId: varchar("marketplace_order_id", { length: 191 }),
    connectionId: varchar("connection_id", { length: 191 }),
    externalAuthoritative: boolean("external_authoritative").notNull(),
    status: varchar("status", { length: 40 }).notNull(),
    fulfillmentStatus: varchar("fulfillment_status", { length: 40 }).notNull(),
    paymentStatus: varchar("payment_status", { length: 40 }).notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    grossTotal: money("gross_total").notNull().default(0),
    discountTotal: money("discount_total").notNull().default(0),
    taxTotal: money("tax_total").notNull().default(0),
    shippingTotal: money("shipping_total").notNull().default(0),
    refundTotal: money("refund_total").notNull().default(0),
    chargebackTotal: money("chargeback_total").notNull().default(0),
    feeTotal: money("fee_total").notNull().default(0),
    shippingCostTotal: money("shipping_cost_total").notNull().default(0),
    expectedNetPayout: money("expected_net_payout").notNull().default(0),
    reportedNetPayout: money("reported_net_payout").notNull().default(0),
    settlementVariance: money("settlement_variance").notNull().default(0),
    reconciliationStatus: varchar("reconciliation_status", { length: 24 }).notNull().default("unreconciled"),
    buyerDisplayName: varchar("buyer_display_name", { length: 191 }),
    shippingAddress: json<Record<string, unknown>>("shipping_address", "'{}'::jsonb"),
    placedAt: timestamp("placed_at"),
    sourceUpdatedAt: timestamp("source_updated_at"),
    sourceSnapshot: json<Record<string, unknown>>("source_snapshot", "'{}'::jsonb"),
    sourceHash: varchar("source_hash", { length: 64 }).notNull(),
    metadata: json<Record<string, unknown>>("metadata", "'{}'::jsonb"),
    lastProjectedAt: timestamp("last_projected_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_unified_orders_pk", columns: [t.companyId, t.id] }),
    uniqueIndex("chatbot_commerce_unified_orders_company_source_uidx").on(t.companyId, t.chatbotId, t.sourceType, t.sourceScope, t.sourceOrderId),
    index("chatbot_commerce_unified_orders_company_chatbot_placed_idx").on(t.companyId, t.chatbotId, t.placedAt),
  ],
);

export const chatbotCommerceUnifiedOrderSnapshots = pgTable(
  "chatbot_commerce_unified_order_snapshots",
  {
    id: id(),
    companyId: companyId(),
    unifiedOrderId: varchar("unified_order_id", { length: 191 }).notNull(),
    sequence: integer("sequence").notNull(),
    sourceHash: varchar("source_hash", { length: 64 }).notNull(),
    snapshot: json<Record<string, unknown>>("snapshot", "'{}'::jsonb"),
    capturedAt: timestamp("captured_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_unified_order_snapshots_pk", columns: [t.companyId, t.id] }),
    uniqueIndex("chatbot_commerce_unified_order_snapshots_company_hash_uidx").on(t.companyId, t.unifiedOrderId, t.sourceHash),
  ],
);

export const chatbotCommerceOrderExceptions = pgTable(
  "chatbot_commerce_order_exceptions",
  {
    id: id(),
    companyId: companyId(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    unifiedOrderId: varchar("unified_order_id", { length: 191 }).notNull(),
    exceptionType: varchar("exception_type", { length: 40 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    severity: varchar("severity", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    title: varchar("title", { length: 191 }).notNull(),
    summary: varchar("summary", { length: 500 }).notNull(),
    evidence: json<Record<string, unknown>>("evidence", "'{}'::jsonb"),
    firstDetectedAt: timestamp("first_detected_at").notNull(),
    lastDetectedAt: timestamp("last_detected_at").notNull(),
    assignedUserId: varchar("assigned_user_id", { length: 191 }),
    acknowledgedByUserId: varchar("acknowledged_by_user_id", { length: 191 }),
    acknowledgedAt: timestamp("acknowledged_at"),
    resolvedByUserId: varchar("resolved_by_user_id", { length: 191 }),
    resolvedAt: timestamp("resolved_at"),
    metadata: json<Record<string, unknown>>("metadata", "'{}'::jsonb"),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_order_exceptions_pk", columns: [t.companyId, t.id] }),
    uniqueIndex("chatbot_commerce_order_exceptions_company_fingerprint_uidx").on(t.companyId, t.unifiedOrderId, t.fingerprint),
    index("chatbot_commerce_order_exceptions_company_status_idx").on(t.companyId, t.chatbotId, t.status),
  ],
);

export const chatbotCommerceOrderExceptionEvents = pgTable(
  "chatbot_commerce_order_exception_events",
  {
    id: id(),
    companyId: companyId(),
    exceptionId: varchar("exception_id", { length: 191 }).notNull(),
    eventType: varchar("event_type", { length: 40 }).notNull(),
    actorType: varchar("actor_type", { length: 16 }),
    actorUserId: varchar("actor_user_id", { length: 191 }),
    beforeState: json<Record<string, unknown>>("before_state", "'{}'::jsonb"),
    afterState: json<Record<string, unknown>>("after_state", "'{}'::jsonb"),
    metadata: json<Record<string, unknown>>("metadata", "'{}'::jsonb"),
    occurredAt: timestamp("occurred_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_order_exception_events_pk", columns: [t.companyId, t.id] }),
    index("chatbot_commerce_order_exception_events_company_exception_idx").on(t.companyId, t.exceptionId),
  ],
);

export const chatbotCommerceWorkbenchActions = pgTable(
  "chatbot_commerce_workbench_actions",
  {
    id: id(),
    companyId: companyId(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    unifiedOrderId: varchar("unified_order_id", { length: 191 }).notNull(),
    exceptionId: varchar("exception_id", { length: 191 }),
    actionType: varchar("action_type", { length: 40 }).notNull(),
    status: varchar("status", { length: 24 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    requestedByUserId: varchar("requested_by_user_id", { length: 191 }).notNull(),
    assignedToUserId: varchar("assigned_to_user_id", { length: 191 }),
    amount: money("amount"),
    currency: varchar("currency", { length: 3 }),
    sourceHash: varchar("source_hash", { length: 64 }).notNull(),
    proposal: json<Record<string, unknown>>("proposal", "'{}'::jsonb"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    expiresAt: timestamp("expires_at"),
    executedAt: timestamp("executed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_workbench_actions_pk", columns: [t.companyId, t.id] }),
    uniqueIndex("chatbot_commerce_workbench_actions_company_chatbot_key_uidx").on(t.companyId, t.chatbotId, t.idempotencyKey),
    index("chatbot_commerce_workbench_actions_company_order_idx").on(t.companyId, t.unifiedOrderId),
  ],
);

export const chatbotCommerceSettlementEntries = pgTable(
  "chatbot_commerce_settlement_entries",
  {
    id: id(),
    companyId: companyId(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    unifiedOrderId: varchar("unified_order_id", { length: 191 }).notNull(),
    provider: varchar("provider", { length: 40 }).notNull(),
    sourceScope: varchar("source_scope", { length: 191 }).notNull(),
    externalEntryId: varchar("external_entry_id", { length: 191 }).notNull(),
    sourceBatchId: varchar("source_batch_id", { length: 191 }),
    entryType: varchar("entry_type", { length: 40 }).notNull(),
    amount: money("amount").notNull(),
    currency: varchar("currency", { length: 3 }).notNull(),
    sourceHash: varchar("source_hash", { length: 64 }).notNull(),
    sourceSnapshot: json<Record<string, unknown>>("source_snapshot", "'{}'::jsonb"),
    occurredAt: timestamp("occurred_at"),
    importedAt: timestamp("imported_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_settlement_entries_pk", columns: [t.companyId, t.id] }),
    uniqueIndex("chatbot_commerce_settlement_entries_company_external_uidx").on(t.companyId, t.chatbotId, t.provider, t.sourceScope, t.externalEntryId),
    index("chatbot_commerce_settlement_entries_company_order_idx").on(t.companyId, t.unifiedOrderId),
  ],
);

export const chatbotCommerceSettlementReconciliations = pgTable(
  "chatbot_commerce_settlement_reconciliations",
  {
    id: id(),
    companyId: companyId(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    unifiedOrderId: varchar("unified_order_id", { length: 191 }).notNull(),
    calculationHash: varchar("calculation_hash", { length: 64 }).notNull(),
    calculation: json<Record<string, unknown>>("calculation", "'{}'::jsonb"),
    report: json<Record<string, unknown>>("report", "'{}'::jsonb"),
    evidence: json<Record<string, unknown>>("evidence", "'{}'::jsonb"),
    reconciledAt: timestamp("reconciled_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_settlement_reconciliations_pk", columns: [t.companyId, t.id] }),
    uniqueIndex("chatbot_commerce_settlement_reconciliations_company_hash_uidx").on(t.companyId, t.unifiedOrderId, t.calculationHash),
  ],
);
