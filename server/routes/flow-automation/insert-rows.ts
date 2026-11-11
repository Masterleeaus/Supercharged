/**
 * Typed insert-row helpers for the flow-automation routes.
 *
 * Each route validates the request body with a Zod input schema first. The mappers then build
 * the Drizzle insert row column by column: no spreading of request data, no casts. A missing
 * required column is a compile error in the `satisfies` check, and a missing required input
 * field fails in Zod before any mapper or insert runs.
 *
 * Server-owned keys (id, userId, companyId, timestamps) are never read from the request body.
 * Zod strips unknown keys, and the mappers take them from a separate `owner` argument.
 */
import { z } from "zod";
import {
  createFlowSchema,
  createWebhookSchema,
  flows,
  webhooks,
  type ExecutionConfig,
  type FlowEdge,
  type FlowNode,
  type VoiceSettings,
} from "../../../shared/schema.ts";

export type FlowInsertRow = typeof flows.$inferInsert;
export type WebhookInsertRow = typeof webhooks.$inferInsert;

/**
 * Zod's output for jsonb columns is looser than the Drizzle `$type` generics, so these
 * containers are checked at runtime and typed to the domain shape. Element-level shape of the
 * flow graph is not validated here, same as before this change.
 */
function jsonArray<T>() {
  return z.custom<T[]>((value) => Array.isArray(value));
}

function jsonObject<T>() {
  return z.custom<T>((value) => typeof value === "object" && value !== null && !Array.isArray(value));
}

/** Validated input for creating a flow. Server-owned keys (id, userId, companyId) are stripped. */
export const flowCreateInputSchema = createFlowSchema.extend({
  nodes: jsonArray<FlowNode>(),
  edges: jsonArray<FlowEdge>(),
  voiceSettings: jsonObject<VoiceSettings>().nullish(),
  executionConfig: jsonObject<ExecutionConfig>().nullish(),
});
export type FlowCreateInput = z.output<typeof flowCreateInputSchema>;

/** Validated input for creating a webhook subscription. Server-owned keys are stripped. */
export const webhookCreateInputSchema = createWebhookSchema.extend({
  events: z.array(z.string()),
  campaignIds: z.array(z.string()).nullish(),
});
export type WebhookCreateInput = z.output<typeof webhookCreateInputSchema>;

/** Keys the server sets on every row. These never come from the request body. */
export interface FlowRowOwner {
  id: string;
  userId: string;
  companyId: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface WebhookRowOwner {
  id: string;
  userId: string;
  companyId: string;
}

/** Builds a flows insert row from validated input plus server-owned keys. */
export function flowInsertRow(input: FlowCreateInput, owner: FlowRowOwner): FlowInsertRow {
  return {
    id: owner.id,
    userId: owner.userId,
    companyId: owner.companyId,
    name: input.name,
    description: input.description,
    nodes: input.nodes,
    edges: input.edges,
    agentId: input.agentId,
    voiceSettings: input.voiceSettings,
    executionConfig: input.executionConfig,
    isActive: input.isActive,
    isTemplate: input.isTemplate,
    createdAt: owner.createdAt,
    updatedAt: owner.updatedAt,
  } satisfies FlowInsertRow;
}

/** Builds a webhook_subscriptions insert row from validated input plus server-owned keys. */
export function webhookInsertRow(input: WebhookCreateInput, owner: WebhookRowOwner): WebhookInsertRow {
  return {
    id: owner.id,
    userId: owner.userId,
    companyId: owner.companyId,
    name: input.name,
    description: input.description,
    url: input.url,
    method: input.method,
    headers: input.headers,
    secret: input.secret,
    authType: input.authType,
    authCredentials: input.authCredentials,
    events: input.events,
    campaignIds: input.campaignIds,
    isActive: input.isActive,
  } satisfies WebhookInsertRow;
}
