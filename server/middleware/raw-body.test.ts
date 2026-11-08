import { test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { NextFunction, Request, Response } from "express";
import { captureChatbotWebhookRawBody, isChatbotWebhookPath, WEBHOOK_RAW_BODY_LIMIT_BYTES } from "./raw-body.ts";

const COMPANY = "11111111-2222-4333-8444-555555555555";
const TELEGRAM = `/api/chatbot/channels/${COMPANY}/telegram/webhook/acct-1`;

function fakeRequest(url: string, method: string, body: string | null): Request {
  const stream = body === null ? Readable.from([]) : Readable.from([Buffer.from(body, "utf8")]);
  return Object.assign(stream, {
    method,
    url,
    originalUrl: url,
    headers: { "content-type": "application/json" },
  }) as unknown as Request;
}

function runMiddleware(req: Request): Promise<{ nextArg: unknown; called: boolean }> {
  const handler = captureChatbotWebhookRawBody();
  return new Promise((resolve) => {
    const next: NextFunction = (arg?: unknown) => {
      resolve({ nextArg: arg, called: true });
    };
    handler(req, {} as Response, next);
  });
}

test("matches the webhook path served for every channel kind (companyId segment included)", () => {
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/whatsapp/webhook`), true);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/whatsapp/webhook/`), true);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/whatsapp/webhook/?x=1`), true);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/telegram/webhook/acct-1`), true);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/telegram/webhook/acct-1/?x=1`), true);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/messenger/webhook/page-1`), true);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/instagram/webhook/ig-1`), true);
});

test("fixed path segments match case-insensitively, company and account segments keep their case", () => {
  const upperCompany = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
  assert.equal(isChatbotWebhookPath(`/API/Chatbot/Channels/${upperCompany}/Telegram/Webhook/Acct-1`), true);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${upperCompany}/WHATSAPP/WEBHOOK`), true);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/Messenger/webhook/PAGE-1/?x=1`), true);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/instagram/WEBHOOK/ig-1`), true);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/Voice/webhook/acct-1`), false);
});

test("does not match channel paths without the company segment or with extra segments", () => {
  // Without the company segment the kind would be read as the company id, so these must not match.
  assert.equal(isChatbotWebhookPath("/api/chatbot/channels/telegram/webhook/acct-1"), false);
  assert.equal(isChatbotWebhookPath("/api/chatbot/channels/whatsapp/webhook"), false);
  assert.equal(isChatbotWebhookPath("/api/chatbot/channels/messenger/webhook/page-1"), false);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/telegram/webhook`), false);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/instagram/webhook/`), false);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/whatsapp/webhook/acct-1`), false);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/voice/webhook/acct-1`), false);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/telegram/webhook/a/b`), false);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/telegram/webhooks/acct-1`), false);
  assert.equal(isChatbotWebhookPath(`/x/api/chatbot/channels/${COMPANY}/telegram/webhook/acct-1`), false);
  assert.equal(isChatbotWebhookPath(`/api/chatbot/channels/${COMPANY}/x/telegram/webhook/acct-1`), false);
  assert.equal(isChatbotWebhookPath("/api/chatbot/conversations"), false);
  assert.equal(isChatbotWebhookPath("/api/crm/webhook"), false);
  assert.equal(isChatbotWebhookPath(undefined), false);
});

test("webhook path stores the exact bytes on req.rawBody and exposes the same text on req.body", async () => {
  const payload = '{"a":  1,\n"b":"x"}';
  const req = fakeRequest(TELEGRAM, "POST", payload);
  const result = await runMiddleware(req);

  assert.equal(result.called, true);
  assert.equal(result.nextArg, undefined);
  const raw = (req as Request & { rawBody?: unknown }).rawBody;
  assert.ok(Buffer.isBuffer(raw));
  assert.equal((raw as Buffer).toString("utf8"), payload);
  // The same text is on req.body, marked as parsed, so the route-level express.text is skipped.
  assert.equal((req as Request & { body?: unknown }).body, payload);
  assert.equal((req as Request & { _body?: boolean })._body, true);
});

test("POST to a per-account channel webhook captures the raw body, ignoring the query string", async () => {
  const payload = '{"update_id":1}';
  const req = fakeRequest(`${TELEGRAM}?x=1`, "POST", payload);
  const result = await runMiddleware(req);

  assert.equal(result.called, true);
  assert.equal(result.nextArg, undefined);
  assert.equal(((req as Request & { rawBody?: unknown }).rawBody as Buffer).toString("utf8"), payload);
});

test("normal path is left alone: next() runs and the stream is not read", async () => {
  const req = fakeRequest("/api/chatbot/conversations", "POST", '{"x":1}');
  const result = await runMiddleware(req);

  assert.equal(result.called, true);
  assert.equal(result.nextArg, undefined);
  assert.equal((req as Request & { rawBody?: unknown }).rawBody, undefined);
  assert.equal(req.readableEnded, false);
});

test("channel path without the company segment is left alone", async () => {
  const req = fakeRequest("/api/chatbot/channels/telegram/webhook/acct-1", "POST", '{"x":1}');
  const result = await runMiddleware(req);

  assert.equal(result.called, true);
  assert.equal((req as Request & { rawBody?: unknown }).rawBody, undefined);
  assert.equal(req.readableEnded, false);
});

test("non-POST on the webhook path is left alone", async () => {
  const req = fakeRequest(TELEGRAM, "GET", null);
  const result = await runMiddleware(req);

  assert.equal(result.called, true);
  assert.equal((req as Request & { rawBody?: unknown }).rawBody, undefined);
});

test("already-consumed body keeps the rawBody set by the earlier parser", async () => {
  const req = fakeRequest(TELEGRAM, "POST", "{}");
  const earlier = Buffer.from("{}");
  (req as Request & { rawBody?: unknown }).rawBody = earlier;
  (req as Request & { _body?: boolean })._body = true;
  const result = await runMiddleware(req);

  assert.equal(result.called, true);
  assert.equal((req as Request & { rawBody?: unknown }).rawBody, earlier);
});

test("body already parsed by the global JSON parser over 1 MB fails with 413 before the route", async () => {
  const req = fakeRequest(TELEGRAM, "POST", null);
  const parsed = Buffer.alloc(WEBHOOK_RAW_BODY_LIMIT_BYTES + 1, 0x61);
  (req as Request & { rawBody?: unknown }).rawBody = parsed;
  (req as Request & { _body?: boolean })._body = true;
  const result = await runMiddleware(req);

  const err = result.nextArg as Error & { status?: number };
  assert.ok(err instanceof Error);
  assert.equal(err.status, 413);
});

test("body already parsed by the global JSON parser at or under 1 MB passes through", async () => {
  const req = fakeRequest(TELEGRAM, "POST", null);
  const parsed = Buffer.alloc(WEBHOOK_RAW_BODY_LIMIT_BYTES, 0x61);
  (req as Request & { rawBody?: unknown }).rawBody = parsed;
  (req as Request & { _body?: boolean })._body = true;
  const result = await runMiddleware(req);

  assert.equal(result.nextArg, undefined);
  assert.equal((req as Request & { rawBody?: unknown }).rawBody, parsed);
});

test("oversized body parsed on a non-webhook path is not capped here", async () => {
  const req = fakeRequest("/api/chatbot/conversations", "POST", null);
  (req as Request & { rawBody?: unknown }).rawBody = Buffer.alloc(WEBHOOK_RAW_BODY_LIMIT_BYTES + 1, 0x61);
  (req as Request & { _body?: boolean })._body = true;
  const result = await runMiddleware(req);

  assert.equal(result.nextArg, undefined);
});

test("oversized webhook body fails with 413 and does not set rawBody", async () => {
  const big = "a".repeat(WEBHOOK_RAW_BODY_LIMIT_BYTES + 1);
  const req = fakeRequest(TELEGRAM, "POST", big);
  const result = await runMiddleware(req);

  const err = result.nextArg as Error & { status?: number };
  assert.ok(err instanceof Error);
  assert.equal(err.status, 413);
  assert.equal((req as Request & { rawBody?: unknown }).rawBody, undefined);
});
