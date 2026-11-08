/**
 * Drizzle tables for the marketplace slice: listing snapshots, write proposals, bulk batches and bulk items.
 * Not applied by any migration. The draft SQL is in db/migrations-draft/0040_commerce_marketplace.sql.
 *
 * Conventions (CONVENTIONS.md section 7):
 * - Every table has company_id, indexed. Primary keys start with company_id, so an upsert cannot overwrite
 *   another tenant's row. Every unique constraint includes company_id.
 * - Parent tables (chatbots, connections) are not referenced yet. The connection table belongs to the
 *   credentials area and is promoted with it. Foreign keys can be added at promotion.
 * - Money is integer minor units. Timestamps are timestamptz.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, primaryKey, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

/** Constraint names. Keep them in step with the Drizzle store and the migration draft. */
export const MARKETPLACE_CONSTRAINTS = {
  proposalIdempotency: "chatbot_marketplace_write_proposals_company_connection_key_uidx",
  batchIdempotency: "chatbot_marketplace_bulk_batches_company_connection_key_uidx",
  bulkItemPerListing: "chatbot_marketplace_bulk_items_batch_listing_uidx",
} as const;

export const chatbotMarketplaceListings = pgTable(
  "chatbot_marketplace_listings",
  {
    companyId: uuid("company_id").notNull(),
    connectionId: varchar("connection_id", { length: 191 }).notNull(),
    externalListingId: varchar("external_listing_id", { length: 191 }).notNull(),
    provider: varchar("provider", { length: 16 }).notNull(),
    sourceHash: varchar("source_hash", { length: 64 }).notNull(),
    snapshot: jsonb("snapshot").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_marketplace_listings_pk", columns: [table.companyId, table.connectionId, table.externalListingId] }),
    index("chatbot_marketplace_listings_company_seen_idx").on(table.companyId, table.connectionId, table.lastSeenAt),
    check("chatbot_marketplace_listings_provider_check", sql`${table.provider} IN ('ebay', 'amazon', 'etsy', 'generic')`),
  ],
);

export const chatbotMarketplaceWriteProposals = pgTable(
  "chatbot_marketplace_write_proposals",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    connectionId: varchar("connection_id", { length: 191 }).notNull(),
    ownerUserId: varchar("owner_user_id", { length: 191 }).notNull(),
    provider: varchar("provider", { length: 16 }).notNull(),
    externalListingId: varchar("external_listing_id", { length: 191 }).notNull(),
    operation: varchar("operation", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    actionHash: varchar("action_hash", { length: 64 }).notNull(),
    expectedSourceHash: varchar("expected_source_hash", { length: 64 }).notNull(),
    requestedChanges: jsonb("requested_changes").notNull(),
    beforeState: jsonb("before_state").notNull(),
    afterState: jsonb("after_state"),
    afterSourceHash: varchar("after_source_hash", { length: 64 }),
    rollbackState: jsonb("rollback_state").notNull(),
    conflicts: jsonb("conflicts").notNull(),
    warnings: jsonb("warnings").notNull(),
    approvalTokenHash: varchar("approval_token_hash", { length: 64 }),
    approvalExpiresAt: timestamp("approval_expires_at", { withTimezone: true }),
    approvedBy: varchar("approved_by", { length: 191 }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvalSnapshot: jsonb("approval_snapshot"),
    batchId: varchar("batch_id", { length: 191 }),
    errorCode: varchar("error_code", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_marketplace_write_proposals_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(MARKETPLACE_CONSTRAINTS.proposalIdempotency).on(table.companyId, table.connectionId, table.idempotencyKey),
    index("chatbot_marketplace_write_proposals_batch_idx").on(table.companyId, table.batchId),
    check(
      "chatbot_marketplace_write_proposals_status_check",
      sql`${table.status} IN ('prepared', 'conflict_blocked', 'approved', 'queued', 'executing', 'executed', 'failed', 'cancelled', 'rolled_back', 'rollback_failed')`,
    ),
  ],
);

export const chatbotMarketplaceBulkBatches = pgTable(
  "chatbot_marketplace_bulk_batches",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    connectionId: varchar("connection_id", { length: 191 }).notNull(),
    ownerUserId: varchar("owner_user_id", { length: 191 }).notNull(),
    provider: varchar("provider", { length: 16 }).notNull(),
    operation: varchar("operation", { length: 32 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    batchHash: varchar("batch_hash", { length: 64 }).notNull(),
    selectionFilters: jsonb("selection_filters").notNull(),
    changeTemplate: jsonb("change_template").notNull(),
    selectedCount: integer("selected_count").notNull().default(0),
    eligibleCount: integer("eligible_count").notNull().default(0),
    blockedCount: integer("blocked_count").notNull().default(0),
    succeededCount: integer("succeeded_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    rolledBackCount: integer("rolled_back_count").notNull().default(0),
    impactSummary: jsonb("impact_summary").notNull(),
    approvalTokenHash: varchar("approval_token_hash", { length: 64 }),
    approvalExpiresAt: timestamp("approval_expires_at", { withTimezone: true }),
    approvedBy: varchar("approved_by", { length: 191 }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_marketplace_bulk_batches_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(MARKETPLACE_CONSTRAINTS.batchIdempotency).on(table.companyId, table.connectionId, table.idempotencyKey),
    check("chatbot_marketplace_bulk_batches_selected_check", sql`${table.selectedCount} >= 0`),
  ],
);

export const chatbotMarketplaceBulkItems = pgTable(
  "chatbot_marketplace_bulk_items",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    batchId: varchar("batch_id", { length: 191 }).notNull(),
    proposalId: varchar("proposal_id", { length: 191 }),
    externalListingId: varchar("external_listing_id", { length: 191 }).notNull(),
    status: varchar("status", { length: 32 }).notNull(),
    errorCode: varchar("error_code", { length: 64 }),
    proposedChanges: jsonb("proposed_changes").notNull(),
    impact: jsonb("impact").notNull(),
    conflicts: jsonb("conflicts").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_marketplace_bulk_items_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(MARKETPLACE_CONSTRAINTS.bulkItemPerListing).on(table.companyId, table.batchId, table.externalListingId),
    check(
      "chatbot_marketplace_bulk_items_status_check",
      sql`${table.status} IN ('ready', 'blocked', 'failed', 'succeeded', 'rolled_back', 'rollback_failed')`,
    ),
  ],
);

