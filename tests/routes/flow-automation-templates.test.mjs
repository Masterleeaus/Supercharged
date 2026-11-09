/**
 * Built-in flow templates against the FlowNode and NodeConfig types in shared/schema.ts.
 * The repo has no zod schema for FlowNode, so the schema below mirrors those interfaces. Every config
 * object is strict, so a key the type does not allow fails the test.
 *
 * Run: node --test --experimental-transform-types tests/routes/flow-automation-templates.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { flowTemplates, templateNodesForStorage } from "../../server/services/flow-templates.ts";

const FLOW_NODE_TYPES = [
  "message", "question", "condition", "appointment", "form", "webhook",
  "transfer", "delay", "play_audio", "send_email", "send_whatsapp", "end",
];

const googleSheet = {
  googleSheetId: z.string().optional(),
  googleSheetName: z.string().optional(),
  googleSheetTitle: z.string().optional(),
};

const NodeConfig = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), message: z.string(), waitForResponse: z.boolean().optional() }).strict(),
  z.object({
    type: z.literal("question"),
    question: z.string(),
    variableName: z.string(),
    expectedResponseType: z.enum(["text", "number", "yes_no"]).optional(),
    waitForResponse: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal("condition"),
    conditions: z.array(z.object({
      type: z.enum(["keyword", "sentiment", "yes_no"]),
      value: z.string(),
      targetNodeId: z.string(),
      label: z.string(),
    }).strict()),
    defaultTargetNodeId: z.string().optional(),
  }).strict(),
  z.object({
    type: z.literal("appointment"),
    confirmMessage: z.string(),
    serviceName: z.string().optional(),
    duration: z.number(),
    waitForResponse: z.boolean().optional(),
    ...googleSheet,
  }).strict(),
  z.object({
    type: z.literal("form"),
    formId: z.string(),
    message: z.string().optional(),
    waitForResponse: z.boolean().optional(),
    ...googleSheet,
  }).strict(),
  z.object({
    type: z.literal("webhook"),
    url: z.string(),
    method: z.enum(["POST", "PUT", "PATCH"]),
    headers: z.record(z.string(), z.string()).optional(),
    payload: z.record(z.string(), z.any()),
  }).strict(),
  z.object({ type: z.literal("transfer"), transferNumber: z.string(), message: z.string() }).strict(),
  z.object({ type: z.literal("delay"), seconds: z.number(), waitForResponse: z.boolean().optional() }).strict(),
  z.object({
    type: z.literal("play_audio"),
    audioUrl: z.string(),
    audioFileName: z.string().optional(),
    interruptible: z.boolean().optional(),
    waitForComplete: z.boolean().optional(),
  }).strict(),
  z.object({
    type: z.literal("send_email"),
    message: z.string(),
    templateName: z.string(),
    recipientEmail: z.string(),
  }).strict(),
  z.object({
    type: z.literal("send_whatsapp"),
    message: z.string(),
    templateName: z.string(),
    language: z.string(),
    templateVariables: z.array(z.object({ position: z.number(), value: z.string() }).strict()),
  }).strict(),
  z.object({ type: z.literal("end"), message: z.string().optional(), waitForResponse: z.boolean().optional() }).strict(),
]);

const FlowNode = z.object({
  id: z.string(),
  type: z.enum(FLOW_NODE_TYPES),
  position: z.object({ x: z.number(), y: z.number() }).strict(),
  data: z.object({ label: z.string(), config: NodeConfig }).strict(),
}).strict().refine((node) => node.type === node.data.config.type, {
  message: "node.type must equal data.config.type",
});

const FlowEdge = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  label: z.string().optional(),
  sourceHandle: z.string().optional(),
  targetHandle: z.string().optional(),
}).strict();

test("every built-in template parses as a valid FlowNode set", () => {
  assert.ok(flowTemplates.length > 0, "there must be at least one template");
  for (const template of flowTemplates) {
    const nodes = z.array(FlowNode).safeParse(template.nodes);
    assert.equal(nodes.success, true, `${template.id}: ${nodes.success ? "" : JSON.stringify(nodes.error.issues.slice(0, 3))}`);

    const ids = new Set(template.nodes.map((node) => node.id));
    assert.equal(ids.size, template.nodes.length, `${template.id}: node ids must be unique`);

    const edges = z.array(FlowEdge).safeParse(template.edges);
    assert.equal(edges.success, true, `${template.id}: edges must match FlowEdge`);
    for (const edge of template.edges) {
      assert.ok(ids.has(edge.source), `${template.id}: edge ${edge.id} source ${edge.source} is not a node`);
      assert.ok(ids.has(edge.target), `${template.id}: edge ${edge.id} target ${edge.target} is not a node`);
    }
  }
});

test("cloned template nodes carry data.type, which the flow builder reads", () => {
  for (const template of flowTemplates) {
    const stored = templateNodesForStorage(template.nodes);
    assert.equal(stored.length, template.nodes.length);
    stored.forEach((node, i) => {
      const original = template.nodes[i];
      assert.equal(node.data.type, original.type, `${template.id}/${node.id}: data.type must equal node.type`);
      assert.deepEqual(node.data.config, original.data.config, `${template.id}/${node.id}: config must be unchanged`);
      assert.equal(node.data.label, original.data.label);
      assert.deepEqual(node.position, original.position);
    });
  }
});
