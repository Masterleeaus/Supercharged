// Contracts change-request tests: the new flag names, the flag rule, and the widened commerce unions (node:test).
// Pure checks only. No network, no storage.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-contracts.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_FLAGS, readFlag, PRICING_SCOPES, PRICING_RULE_TYPES } from "../../server/modules/chatbot/contracts/index.ts";

test("new change-request flags use the names the slices expect", () => {
  assert.equal(CONTRACT_FLAGS.INSTAGRAM_ENABLED, "CHATBOT_INSTAGRAM_ENABLED");
  assert.equal(CONTRACT_FLAGS.REVIEWS_ENABLED, "CHATBOT_REVIEWS_ENABLED");
  assert.equal(CONTRACT_FLAGS.WHATSAPP_CHANNEL, "CHATBOT_WHATSAPP_CHANNEL_ENABLED");
  assert.equal(CONTRACT_FLAGS.ATTACHMENTS_ENABLED, "CHATBOT_ATTACHMENTS_ENABLED");
  assert.equal(CONTRACT_FLAGS.ANALYTICS_EXPORT_ENABLED, "CHATBOT_ANALYTICS_EXPORT_ENABLED");
});

test("every new flag is off unless its value is exactly \"true\"", () => {
  for (const name of [
    CONTRACT_FLAGS.INSTAGRAM_ENABLED,
    CONTRACT_FLAGS.REVIEWS_ENABLED,
    CONTRACT_FLAGS.WHATSAPP_CHANNEL,
    CONTRACT_FLAGS.TELEGRAM_CHANNEL,
    CONTRACT_FLAGS.ATTACHMENTS_ENABLED,
    CONTRACT_FLAGS.ANALYTICS_EXPORT_ENABLED,
  ]) {
    assert.equal(readFlag(name, {}), false, `${name} defaults off`);
    for (const value of ["1", "yes", "on", "TRUE", ""]) {
      assert.equal(readFlag(name, { [name]: value }), false, `${name}=${JSON.stringify(value)} is off`);
    }
    assert.equal(readFlag(name, { [name]: "true" }), true, `${name}=true is on`);
  }
});

test("widened commerce unions include the change-request members", () => {
  assert.ok(PRICING_SCOPES.includes("shipping"));
  assert.ok(PRICING_RULE_TYPES.includes("free_shipping"));
  assert.deepEqual([...PRICING_SCOPES], ["line", "cart", "shipping"]);
});

test("existing flag names are unchanged", () => {
  assert.equal(CONTRACT_FLAGS.KNOWLEDGE_ENABLED, "CHATBOT_KNOWLEDGE_ENABLED");
  assert.equal(CONTRACT_FLAGS.GEMINI_ENABLED, "CHATBOT_GEMINI_ENABLED");
  assert.equal(CONTRACT_FLAGS.OUTBOUND_WEBHOOKS_ENABLED, "CHATBOT_OUTBOUND_WEBHOOKS_ENABLED");
});
