/**
 * Drizzle tables for conversational commerce: approval actions (shopping and customer-communication), commerce
 * credentials (sealed), customer-communication threads, messages, policies and escalations, listing proposals and
 * compliance rules, and shopping session state. Not applied by any migration. The SQL draft is in
 * migrations-draft/0002_commerce_conversational.sql.
 *
 * Conventions (as in db/cart.ts): snake_case columns, company_id on every table, every unique key includes
 * company_id, money as integer minor units, confidence as basis points (1000 = 0.1000 is stored as 1000 of 10000).
 * Credentials are stored only as a SealedSecret JSON value. There is no plaintext column.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, char, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";

export const COMMERCE_CONVERSATIONAL_CONSTRAINTS = {
  actionIdempotency: "chatbot_commerce_actions_company_idem_uidx",
  credentialPerProvider: "chatbot_commerce_credentials_company_provider_uidx",
  threadExternal: "chatbot_commerce_comm_threads_company_external_uidx",
  messageExternal: "chatbot_commerce_comm_messages_company_external_uidx",
  listingProposalHash: "chatbot_commerce_listing_proposals_company_hash_uidx",
} as const;

export const chatbotCommerceApprovalActions = pgTable(
  "chatbot_commerce_approval_actions",
  {
    companyId: uuid("company_id").notNull(),
    id: uuid("id").notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    scope: varchar("scope", { length: 20 }).notNull(),
    subjectId: varchar("subject_id", { length: 191 }).notNull(),
    actionType: varchar("action_type", { length: 100 }).notNull(),
    status: varchar("status", { length: 30 }).notNull(),
    authorityLevel: varchar("authority_level", { length: 40 }).notNull(),
    amountMinor: bigint("amount_minor", { mode: "number" }),
    currency: char("currency", { length: 3 }),
    idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
    approvalTokenHash: char("approval_token_hash", { length: 64 }),
    approvedBy: varchar("approved_by", { length: 191 }),
    executedBy: varchar("executed_by", { length: 191 }),
    payload: jsonb("payload").notNull().default({}),
    result: jsonb("result"),
    failureReason: text("failure_reason"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_approval_actions_pk", columns: [t.companyId, t.id] }),
    uniqueIndex(COMMERCE_CONVERSATIONAL_CONSTRAINTS.actionIdempotency).on(t.companyId, t.chatbotId, t.scope, t.idempotencyKey),
    index("chatbot_commerce_approval_actions_company_subject_idx").on(t.companyId, t.subjectId),
    index("chatbot_commerce_approval_actions_company_status_idx").on(t.companyId, t.status, t.expiresAt),
    check("chatbot_commerce_approval_actions_scope_check", sql`${t.scope} IN ('conversational', 'communication')`),
    check("chatbot_commerce_approval_actions_status_check", sql`${t.status} IN ('awaiting_approval', 'ready', 'approved', 'executed', 'failed', 'expired')`),
  ],
);

export const chatbotCommerceCredentials = pgTable(
  "chatbot_commerce_credentials",
  {
    companyId: uuid("company_id").notNull(),
    id: uuid("id").notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    ownerUserId: varchar("owner_user_id", { length: 191 }).notNull(),
    provider: varchar("provider", { length: 40 }).notNull(),
    sealed: jsonb("sealed"),
    configuration: jsonb("configuration").notNull().default({}),
    fingerprint: char("fingerprint", { length: 64 }),
    status: varchar("status", { length: 20 }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    lastTestSucceeded: boolean("last_test_succeeded"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_credentials_pk", columns: [t.companyId, t.id] }),
    uniqueIndex(COMMERCE_CONVERSATIONAL_CONSTRAINTS.credentialPerProvider).on(t.companyId, t.chatbotId, t.provider),
    check("chatbot_commerce_credentials_provider_check", sql`${t.provider} IN ('shopify', 'woocommerce')`),
    check("chatbot_commerce_credentials_status_check", sql`${t.status} IN ('active', 'revoked')`),
  ],
);

export const chatbotCommerceCommThreads = pgTable(
  "chatbot_commerce_comm_threads",
  {
    companyId: uuid("company_id").notNull(),
    id: uuid("id").notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    channel: varchar("channel", { length: 60 }).notNull(),
    externalThreadId: varchar("external_thread_id", { length: 191 }),
    customerId: bigint("customer_id", { mode: "number" }),
    sessionId: varchar("session_id", { length: 191 }),
    identityVerified: boolean("identity_verified").notNull().default(false),
    intent: varchar("intent", { length: 100 }),
    confidenceBps: integer("confidence_bps"),
    priority: varchar("priority", { length: 20 }).notNull().default("normal"),
    sentiment: varchar("sentiment", { length: 20 }).notNull().default("neutral"),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_comm_threads_pk", columns: [t.companyId, t.id] }),
    uniqueIndex(COMMERCE_CONVERSATIONAL_CONSTRAINTS.threadExternal).on(t.companyId, t.chatbotId, t.channel, t.externalThreadId),
    index("chatbot_commerce_comm_threads_company_session_idx").on(t.companyId, t.sessionId),
    check("chatbot_commerce_comm_threads_status_check", sql`${t.status} IN ('open', 'handoff', 'closed')`),
  ],
);

export const chatbotCommerceCommMessages = pgTable(
  "chatbot_commerce_comm_messages",
  {
    companyId: uuid("company_id").notNull(),
    id: uuid("id").notNull(),
    threadId: uuid("thread_id").notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    channel: varchar("channel", { length: 60 }).notNull(),
    externalMessageId: varchar("external_message_id", { length: 191 }),
    direction: varchar("direction", { length: 20 }).notNull(),
    actorType: varchar("actor_type", { length: 40 }).notNull(),
    body: text("body").notNull().default(""),
    intent: varchar("intent", { length: 100 }),
    confidenceBps: integer("confidence_bps"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_comm_messages_pk", columns: [t.companyId, t.id] }),
    uniqueIndex(COMMERCE_CONVERSATIONAL_CONSTRAINTS.messageExternal).on(t.companyId, t.chatbotId, t.channel, t.externalMessageId),
    index("chatbot_commerce_comm_messages_company_thread_idx").on(t.companyId, t.threadId, t.receivedAt),
    check("chatbot_commerce_comm_messages_direction_check", sql`${t.direction} IN ('inbound', 'outbound')`),
  ],
);

export const chatbotCommerceCommPolicies = pgTable(
  "chatbot_commerce_comm_policies",
  {
    companyId: uuid("company_id").notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    autoReplyEnabled: boolean("auto_reply_enabled").notNull().default(false),
    autoReplyConfidenceBps: integer("auto_reply_confidence_bps").notNull().default(9000),
    automaticRefundLimitMinor: bigint("automatic_refund_limit_minor", { mode: "number" }).notNull().default(0),
    automaticDiscountLimitMinor: bigint("automatic_discount_limit_minor", { mode: "number" }).notNull().default(0),
    automaticStoreCreditLimitMinor: bigint("automatic_store_credit_limit_minor", { mode: "number" }).notNull().default(0),
    automaticReplacementLimitMinor: bigint("automatic_replacement_limit_minor", { mode: "number" }).notNull().default(0),
    automaticCancellationLimitMinor: bigint("automatic_cancellation_limit_minor", { mode: "number" }).notNull().default(0),
    currency: char("currency", { length: 3 }).notNull().default("USD"),
    active: boolean("active").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "chatbot_commerce_comm_policies_pk", columns: [t.companyId, t.chatbotId] })],
);

export const chatbotCommerceEscalations = pgTable(
  "chatbot_commerce_escalations",
  {
    companyId: uuid("company_id").notNull(),
    id: uuid("id").notNull(),
    threadId: uuid("thread_id").notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    reason: varchar("reason", { length: 100 }).notNull(),
    severity: varchar("severity", { length: 20 }).notNull(),
    status: varchar("status", { length: 20 }).notNull().default("open"),
    summary: text("summary").notNull(),
    recommendedAction: text("recommended_action"),
    contextSnapshot: jsonb("context_snapshot").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_escalations_pk", columns: [t.companyId, t.id] }),
    index("chatbot_commerce_escalations_company_thread_idx").on(t.companyId, t.threadId),
  ],
);

export const chatbotCommerceListingRules = pgTable(
  "chatbot_commerce_listing_rules",
  {
    companyId: uuid("company_id").notNull(),
    id: uuid("id").notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }),
    provider: varchar("provider", { length: 40 }).notNull(),
    code: varchar("code", { length: 100 }).notNull(),
    severity: varchar("severity", { length: 20 }).notNull(),
    terms: jsonb("terms").notNull().default([]),
    fieldScopes: jsonb("field_scopes").notNull().default([]),
    message: text("message").notNull(),
    remediation: text("remediation").notNull(),
    priority: integer("priority").notNull().default(100),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_listing_rules_pk", columns: [t.companyId, t.id] }),
    index("chatbot_commerce_listing_rules_company_provider_idx").on(t.companyId, t.provider, t.active),
    check("chatbot_commerce_listing_rules_severity_check", sql`${t.severity} IN ('info', 'warning', 'block')`),
  ],
);

export const chatbotCommerceListingProposals = pgTable(
  "chatbot_commerce_listing_proposals",
  {
    companyId: uuid("company_id").notNull(),
    id: uuid("id").notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    provider: varchar("provider", { length: 40 }).notNull(),
    productId: bigint("product_id", { mode: "number" }),
    sourceHash: char("source_hash", { length: 64 }).notNull(),
    status: varchar("status", { length: 20 }).notNull(),
    proposedContent: jsonb("proposed_content").notNull(),
    findings: jsonb("findings").notNull().default([]),
    proposalHash: char("proposal_hash", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chatbot_commerce_listing_proposals_pk", columns: [t.companyId, t.id] }),
    uniqueIndex(COMMERCE_CONVERSATIONAL_CONSTRAINTS.listingProposalHash).on(t.companyId, t.chatbotId, t.proposalHash),
    check("chatbot_commerce_listing_proposals_status_check", sql`${t.status} IN ('ready', 'blocked')`),
  ],
);

export const chatbotCommerceShoppingSessions = pgTable(
  "chatbot_commerce_shopping_sessions",
  {
    companyId: uuid("company_id").notNull(),
    chatbotId: varchar("chatbot_id", { length: 191 }).notNull(),
    sessionId: varchar("session_id", { length: 191 }).notNull(),
    customerId: bigint("customer_id", { mode: "number" }),
    currentProductIds: jsonb("current_product_ids").notNull().default([]),
    selectedProductId: bigint("selected_product_id", { mode: "number" }),
    selectedVariantId: bigint("selected_variant_id", { mode: "number" }),
    lastQuery: text("last_query"),
    contextVersion: integer("context_version").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ name: "chatbot_commerce_shopping_sessions_pk", columns: [t.companyId, t.chatbotId, t.sessionId] })],
);
