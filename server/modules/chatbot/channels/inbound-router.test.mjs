import { test } from "node:test";
import assert from "node:assert/strict";
import { handleInboundPost } from "./inbound-router.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";

/** A registry and credential source that accept every webhook, so the pipeline reaches onReceipt. */
const acceptingRegistry = {
  get: () => ({
    kind: "telegram",
    resolveAccount: () => "acc-1",
    verifyWebhook: async () => ({ ok: true }),
    parseInbound: () => [],
  }),
};
const credentials = { load: async () => ({ token: "unused" }) };

function fakeReq() {
  return { params: { companyId: COMPANY }, headers: {}, query: {}, rawBody: Buffer.from("{}") };
}

function fakeRes() {
  const res = { statusCode: 200, ended: false };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.end = () => {
    res.ended = true;
    return res;
  };
  return res;
}

test("a throwing onReceipt answers 500 and logs the error name and code, never the message", async () => {
  const events = [];
  const logger = {
    warn: (event, fields) => events.push({ level: "warn", event, fields }),
    error: (event, fields) => events.push({ level: "error", event, fields }),
  };
  const error = Object.assign(new RangeError("db password is hunter2"), { code: "23505" });
  let success = false;
  const res = fakeRes();

  await handleInboundPost(
    {
      registry: acceptingRegistry,
      credentials,
      onReceipt: async () => {
        throw error;
      },
      logger,
    },
    "telegram",
    fakeReq(),
    res,
    { pathAccountId: null, success: () => (success = true) },
  );

  assert.equal(res.statusCode, 500, "the platform is told to retry");
  assert.equal(success, false);
  const entry = events.find((e) => e.event === "chatbot.channels.on_receipt_failed");
  assert.ok(entry, "the failure is logged");
  assert.equal(entry.level, "error");
  assert.deepEqual(entry.fields, { kind: "telegram", companyId: COMPANY, errorName: "RangeError", errorCode: "23505" });
  assert.ok(!JSON.stringify(events).includes("hunter2"), "the message is never logged");
});
