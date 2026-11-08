/*
 * DRAFT - not wired into shared/schema.ts and not applied to any database.
 * Matching SQL is in migrations/DRAFT_approvals.sql. Review both before
 * promoting either one.
 */
import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * approval_rules: one row per policy. Each row maps to a Policy object that the
 * policy engine evaluates (see ./types.ts). Tenant-scoped by company_id.
 */
export const approvalRules = pgTable(
  "approval_rules",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: varchar("company_id").notNull(),
    name: text("name").notNull(),
    priority: integer("priority").notNull().default(100), // lower = evaluated first
    enabled: boolean("enabled").notNull().default(true),
    scope: varchar("scope", { length: 16 }).notNull().default("global"), // global | per_agent | per_tool
    agentIds: jsonb("agent_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    toolIds: jsonb("tool_ids").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    rules: jsonb("rules").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`), // PolicyRule[]
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("approval_rules_company_name_uidx").on(table.companyId, table.name),
    index("approval_rules_company_enabled_idx").on(table.companyId, table.enabled, table.priority),
  ]
);

/**
 * approvals: one row per gated agent action. status follows the state machine
 * pending -> approved | rejected | expired; executed_at is set once the caller
 * reports that the gated action ran.
 */
export const approvals = pgTable(
  "approvals",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    companyId: varchar("company_id").notNull(),
    requestedBy: varchar("requested_by"), // user or agent id from the verified caller
    agentId: varchar("agent_id"),
    action: text("action").notNull(),
    urgency: varchar("urgency", { length: 16 }).notNull().default("normal"),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`), // redacted copy
    context: jsonb("context").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    decision: varchar("decision", { length: 24 }), // policy decision that produced this row
    policyId: varchar("policy_id"),
    decidedBy: text("decided_by"), // namespaced: policy:<id> | dashboard:<user> | api:<id>
    decisionReason: text("decision_reason"),
    expiresAt: timestamp("expires_at").notNull(),
    decidedAt: timestamp("decided_at"),
    executedAt: timestamp("executed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("approvals_company_status_idx").on(table.companyId, table.status, table.createdAt),
    index("approvals_company_created_idx").on(table.companyId, table.createdAt),
  ]
);

export type ApprovalRow = typeof approvals.$inferSelect;
export type ApprovalInsert = typeof approvals.$inferInsert;
export type ApprovalRuleRow = typeof approvalRules.$inferSelect;
export type ApprovalRuleInsert = typeof approvalRules.$inferInsert;
