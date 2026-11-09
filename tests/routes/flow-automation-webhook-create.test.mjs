/**
 * Flow-automation webhook create input. The route parses req.body with createWebhookSchema and returns 400
 * when safeParse fails. This test checks the schema that route uses; the route itself is not imported because
 * it pulls in the database and delivery services.
 *
 * Run: node --test --experimental-transform-types tests/routes/flow-automation-webhook-create.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createWebhookSchema } from "../../shared/schema.ts";

const base = {
  name: "CRM hook",
  url: "https://example.test/hook",
  secret: "test-secret",
  events: ["call.ended"],
};

test("webhook create rejects a non-array campaignIds with a validation error", () => {
  for (const campaignIds of ["camp-1", 42, { id: "camp-1" }, true]) {
    const result = createWebhookSchema.safeParse({ ...base, campaignIds });
    assert.equal(result.success, false, `campaignIds ${JSON.stringify(campaignIds)} must be rejected`);
    assert.ok(
      result.error.issues.some((issue) => issue.path[0] === "campaignIds"),
      "the validation error must point at campaignIds",
    );
  }
});

test("webhook create accepts campaignIds as an array of strings or null", () => {
  for (const campaignIds of [["camp-1", "camp-2"], [], null]) {
    const result = createWebhookSchema.safeParse({ ...base, campaignIds });
    assert.equal(result.success, true, `campaignIds ${JSON.stringify(campaignIds)} must be accepted`);
    assert.deepEqual(result.data.campaignIds, campaignIds);
  }
});
