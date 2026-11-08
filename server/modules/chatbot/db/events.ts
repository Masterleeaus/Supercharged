/**
 * Drizzle tables for the events slice: workflow runs and their step records, structured actions, the
 * transactional outbox, webhook subscriptions and webhook delivery attempts. Not applied by any migration.
 *
 * Conventions follow db/cart.ts: chatbot_ prefix, snake_case columns, company_id on every table, composite
 * primary keys (company_id, id), and composite foreign keys to the parent conversation.
 * Webhook signing secrets are stored only as SealedSecret JSON (see secrets/ and contracts/secrets.ts).
 */
import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import { chatbotConversations } from "../../../../shared/schema.ts";

/** Constraint names the storage maps to errors. Keep them in step with drizzle-store.ts. */
export const EVENTS_CONSTRAINTS = {
  workflowIdempotency: "chatbot_workflow_runs_idempotency_uidx",
  actionIdempotency: "chatbot_structured_actions_idempotency_uidx",
  outboxDedupe: "chatbot_event_outbox_dedupe_uidx",
} as const;

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const chatbotWorkflowRuns = pgTable(
  "chatbot_workflow_runs",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    workflow: varchar("workflow", { length: 191 }).notNull(),
    conversationId: varchar("conversation_id", { length: 191 }),
    idempotencyKey: varchar("idempotency_key", { length: 191 }),
    status: varchar("status", { length: 16 }).notNull().default("queued"),
    attempt: integer("attempt").notNull().default(1),
    maxAttempts: integer("max_attempts").notNull().default(3),
    context: jsonb("context").notNull().default({}),
    output: jsonb("output"),
    error: text("error"),
    nextRunAt: tz("next_run_at"),
    lockedAt: tz("locked_at"),
    lockToken: varchar("lock_token", { length: 64 }),
    startedAt: tz("started_at"),
    finishedAt: tz("finished_at"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_workflow_runs_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(EVENTS_CONSTRAINTS.workflowIdempotency)
      .on(table.companyId, table.workflow, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("chatbot_workflow_runs_company_status_idx").on(table.companyId, table.status, table.nextRunAt),
    foreignKey({
      name: "chatbot_workflow_runs_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    check("chatbot_workflow_runs_status_check", sql`${table.status} IN ('queued', 'running', 'waiting', 'completed', 'failed', 'cancelled')`),
  ],
);

export const chatbotWorkflowSteps = pgTable(
  "chatbot_workflow_steps",
  {
    companyId: uuid("company_id").notNull(),
    runId: varchar("run_id", { length: 191 }).notNull(),
    stepKey: varchar("step_key", { length: 191 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("running"),
    lockToken: varchar("lock_token", { length: 64 }).notNull(),
    lockedAt: tz("locked_at").notNull().defaultNow(),
    output: jsonb("output"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_workflow_steps_pk", columns: [table.companyId, table.runId, table.stepKey] }),
    foreignKey({
      name: "chatbot_workflow_steps_company_run_fk",
      columns: [table.companyId, table.runId],
      foreignColumns: [chatbotWorkflowRuns.companyId, chatbotWorkflowRuns.id],
    }),
    check("chatbot_workflow_steps_status_check", sql`${table.status} IN ('running', 'completed')`),
  ],
);

export const chatbotStructuredActions = pgTable(
  "chatbot_structured_actions",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    conversationId: varchar("conversation_id", { length: 191 }).notNull(),
    kind: varchar("kind", { length: 64 }).notNull(),
    args: jsonb("args").notNull(),
    presentation: jsonb("presentation"),
    status: varchar("status", { length: 16 }).notNull().default("proposed"),
    requiresApproval: boolean("requires_approval").notNull(),
    approvedBy: varchar("approved_by", { length: 191 }),
    resultRef: varchar("result_ref", { length: 191 }),
    failureReason: text("failure_reason"),
    expiresAt: tz("expires_at"),
    idempotencyKey: varchar("idempotency_key", { length: 191 }),
    executionToken: varchar("execution_token", { length: 64 }),
    executionStartedAt: tz("execution_started_at"),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_structured_actions_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(EVENTS_CONSTRAINTS.actionIdempotency)
      .on(table.companyId, table.conversationId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
    index("chatbot_structured_actions_company_conv_status_idx").on(table.companyId, table.conversationId, table.status),
    foreignKey({
      name: "chatbot_structured_actions_company_conversation_fk",
      columns: [table.companyId, table.conversationId],
      foreignColumns: [chatbotConversations.companyId, chatbotConversations.id],
    }),
    check("chatbot_structured_actions_status_check", sql`${table.status} IN ('proposed', 'approved', 'rejected', 'executed', 'failed', 'expired')`),
  ],
);

export const chatbotEventOutbox = pgTable(
  "chatbot_event_outbox",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    topic: varchar("topic", { length: 191 }).notNull(),
    aggregateId: varchar("aggregate_id", { length: 191 }).notNull(),
    payload: jsonb("payload").notNull(),
    dedupeKey: varchar("dedupe_key", { length: 191 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: tz("available_at").notNull().defaultNow(),
    lockedAt: tz("locked_at"),
    lockedBy: varchar("locked_by", { length: 191 }),
    realtimePublishedAt: tz("realtime_published_at"),
    publishedAt: tz("published_at"),
    failedAt: tz("failed_at"),
    lastError: text("last_error"),
    createdAt: tz("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_event_outbox_pk", columns: [table.companyId, table.id] }),
    uniqueIndex(EVENTS_CONSTRAINTS.outboxDedupe).on(table.companyId, table.dedupeKey),
    index("chatbot_event_outbox_company_status_idx").on(table.companyId, table.status, table.availableAt),
    check("chatbot_event_outbox_status_check", sql`${table.status} IN ('pending', 'published', 'failed')`),
  ],
);

export const chatbotWebhookSubscriptions = pgTable(
  "chatbot_webhook_subscriptions",
  {
    companyId: uuid("company_id").notNull(),
    id: varchar("id", { length: 191 }).notNull(),
    url: text("url").notNull(),
    topics: jsonb("topics").notNull(),
    active: boolean("active").notNull().default(true),
    signingSecret: jsonb("signing_secret").notNull(),
    createdAt: tz("created_at").notNull().defaultNow(),
    updatedAt: tz("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_webhook_subscriptions_pk", columns: [table.companyId, table.id] }),
    index("chatbot_webhook_subscriptions_company_idx").on(table.companyId, table.active),
  ],
);

export const chatbotWebhookDeliveries = pgTable(
  "chatbot_webhook_deliveries",
  {
    companyId: uuid("company_id").notNull(),
    eventId: varchar("event_id", { length: 191 }).notNull(),
    subscriptionId: varchar("subscription_id", { length: 191 }).notNull(),
    attempt: integer("attempt").notNull(),
    httpStatus: integer("http_status"),
    ok: boolean("ok").notNull(),
    errorMessage: text("error_message"),
    deliveredAt: tz("delivered_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "chatbot_webhook_deliveries_pk", columns: [table.companyId, table.eventId, table.subscriptionId, table.attempt] }),
    foreignKey({
      name: "chatbot_webhook_deliveries_company_event_fk",
      columns: [table.companyId, table.eventId],
      foreignColumns: [chatbotEventOutbox.companyId, chatbotEventOutbox.id],
    }),
    foreignKey({
      name: "chatbot_webhook_deliveries_company_subscription_fk",
      columns: [table.companyId, table.subscriptionId],
      foreignColumns: [chatbotWebhookSubscriptions.companyId, chatbotWebhookSubscriptions.id],
    }),
  ],
);
