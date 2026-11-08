import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createTelegramWebhookRouter } from "./router.ts";
import { createChannelRegistry } from "../framework.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const PATH = `/api/chatbot/channels/${COMPANY}/telegram/webhook/bot1`;

/** Mounts the router on a random local port, posts one update, and returns the status code. */
async function postUpdate(deps) {
  const app = express();
  app.use("/api/chatbot/channels/:companyId/telegram", createTelegramWebhookRouter(deps));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    return res.status;
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function baseDeps(extra = {}) {
  return {
    registry: createChannelRegistry(),
    credentials: { load: async () => null },
    onReceipt: async () => {},
    logger: { info() {}, warn() {}, error() {} },
    ...extra,
  };
}

test("telegram route answers 404 when CHATBOT_TELEGRAM_CHANNEL_ENABLED is not exactly true", async () => {
  assert.equal(await postUpdate(baseDeps({ env: {} })), 404);
  assert.equal(await postUpdate(baseDeps({ env: { CHATBOT_TELEGRAM_CHANNEL_ENABLED: "1" } })), 404);
  assert.equal(await postUpdate(baseDeps({ env: { CHATBOT_TELEGRAM_CHANNEL_ENABLED: "TRUE" } })), 404);
});

test("telegram route is reached when its flag is exactly true (empty registry refuses with 403)", async () => {
  assert.equal(await postUpdate(baseDeps({ env: { CHATBOT_TELEGRAM_CHANNEL_ENABLED: "true" } })), 403);
});

test("telegram route without env is not gated by the telegram flag (direct use)", async () => {
  const status = await postUpdate(baseDeps());
  assert.notEqual(status, 404);
});
