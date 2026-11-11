/**
 * Compile-time checks for insert-rows.ts. This file has no runtime effect and is not imported
 * by the app. Each @ts-expect-error line must fail to compile; if one stops failing, tsc reports
 * "Unused @ts-expect-error directive" and the check breaks.
 */
import { flowInsertRow, webhookInsertRow, type FlowCreateInput, type WebhookCreateInput } from "./insert-rows";
import type { FlowInsertRow, WebhookInsertRow } from "./insert-rows";
import type { FlowNode, FlowEdge } from "../../../shared/schema.ts";

const owner = { id: "f1", userId: "u1", companyId: "00000000-0000-0000-0000-000000000000" };
const node: FlowNode = {
  id: "n1",
  type: "end",
  position: { x: 0, y: 0 },
  data: { label: "End", config: { type: "end" } as FlowNode["data"]["config"] },
};
const edge: FlowEdge = { id: "e1", source: "n1", target: "n2" };

const flowInput: FlowCreateInput = { name: "Intake", nodes: [node], edges: [edge], isActive: true, isTemplate: false };

// Valid input builds a row (no error).
export const okFlowRow: FlowInsertRow = flowInsertRow(flowInput, owner);

// Required columns: name, nodes, edges are required in the input type.
// @ts-expect-error missing name
export const flowMissingName: FlowCreateInput = { nodes: [node], edges: [edge] };
// @ts-expect-error missing nodes
export const flowMissingNodes: FlowCreateInput = { name: "x", edges: [edge] };
// @ts-expect-error missing edges
export const flowMissingEdges: FlowCreateInput = { name: "x", nodes: [node] };

// Server-owned owner keys are required by the mapper signature.
// @ts-expect-error missing owner.companyId
flowInsertRow(flowInput, { id: "f1", userId: "u1" });
// @ts-expect-error missing owner.id
flowInsertRow(flowInput, { userId: "u1", companyId: "c" });

// Wrong jsonb element type is rejected.
// @ts-expect-error nodes must be FlowNode[]
export const flowBadNodes: FlowCreateInput = { name: "x", nodes: ["not a node"], edges: [] };

// Required webhook columns.
const webhookInput: WebhookCreateInput = {
  name: "Hook",
  url: "https://example.com/h",
  secret: "s".repeat(16),
  events: ["call.ended"],
  method: "POST",
  isActive: true,
};
export const okWebhookRow: WebhookInsertRow = webhookInsertRow(webhookInput, owner);

// @ts-expect-error missing url
export const webhookMissingUrl: WebhookCreateInput = { name: "h", secret: "s", events: [] };
// @ts-expect-error missing events
export const webhookMissingEvents: WebhookCreateInput = { name: "h", url: "u", secret: "s" };
// @ts-expect-error events must be strings
export const webhookBadEvents: WebhookCreateInput = { name: "h", url: "u", secret: "s", events: [1] };

// The mapper output carries no keys outside the table: an extra key on a literal is rejected.
// @ts-expect-error unknown column
export const flowExtraKey: FlowInsertRow = { id: "f", userId: "u", companyId: "c", name: "n", nodes: [], edges: [], bogus: 1 };
