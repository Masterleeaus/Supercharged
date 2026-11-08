/**
 * Webhook signing secrets: a new subscription stores the versioned string in the JSON column, and the dispatcher signs
 * with it. A subscription row written as the older contract object still signs with the same secret.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  WEBHOOK_HEADERS,
  createWebhookDispatcher,
  createWebhookSubscriptionService,
  signWebhookBody,
} from "./webhooks.ts";
import { createMemoryEventsStore } from "./memory-store.ts";
import { SECRET_KEY_ENV, createSecretBox } from "../secrets/secret-box.ts";
import type { HttpRequest, HttpResponse, WebhookSubscription } from "../contracts/index.ts";

const env = { [SECRET_KEY_ENV]: randomBytes(32).toString("base64") };
const box = createSecretBox({ env });
const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const URL_IN = "https://hooks.example.com/inbound";
const SECRET = `whsec_${randomBytes(24).toString("hex")}`;
const resolve = async () => ["93.184.216.34"];
const clock = () => new Date("2026-11-01T00:00:00Z");
let ids = 0;
const deps = { now: clock, newId: () => `sub-${++ids}` };
const ENABLED = { CHATBOT_OUTBOUND_WEBHOOKS_ENABLED: "true" };

test("subscribe stores the signing secret as the versioned string, never the plaintext", async () => {
  const store = createMemoryEventsStore();
  const service = createWebhookSubscriptionService(store, box, deps, resolve);
  await service.subscribe(COMPANY_A, { url: URL_IN, topics: ["conversation.created"], signingSecret: SECRET });
  const [row] = await store.listSubscriptions(COMPANY_A);
  assert.equal(typeof row.signingSecret, "string");
  assert.match(String(row.signingSecret), /^v1:/);
  assert.equal(JSON.stringify(row).includes(SECRET), false);
});

test("dispatch signs with the stored string secret", async () => {
  const store = createMemoryEventsStore();
  await createWebhookSubscriptionService(store, box, deps, resolve).subscribe(COMPANY_A, {
    url: URL_IN,
    topics: ["conversation.created"],
    signingSecret: SECRET,
  });
  const sent: HttpRequest[] = [];
  const http = async (request: HttpRequest): Promise<HttpResponse> => {
    sent.push(request);
    return { status: 200, headers: {}, body: "" };
  };
  const dispatcher = createWebhookDispatcher({ http, secretBox: box, store, env: ENABLED, events: deps, resolve });
  const results = await dispatcher.dispatch(COMPANY_A, {
    id: "evt-1",
    companyId: COMPANY_A,
    topic: "conversation.created",
    payload: { conversation_id: "c-1" },
  } as never);
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  const request = sent[0];
  assert.ok(request.body);
  assert.equal(request.headers?.[WEBHOOK_HEADERS.signature], signWebhookBody(SECRET, request.body));
});

test("dispatch still signs for a subscription row stored as the contract object", async () => {
  const store = createMemoryEventsStore();
  const legacy = await box.encrypt(COMPANY_A, SECRET);
  const subscription: WebhookSubscription = {
    id: "sub-legacy",
    companyId: COMPANY_A,
    url: URL_IN,
    topics: ["*"],
    active: true,
    signingSecret: legacy,
  };
  await store.insertSubscription(COMPANY_A, subscription);
  const sent: HttpRequest[] = [];
  const http = async (request: HttpRequest): Promise<HttpResponse> => {
    sent.push(request);
    return { status: 204, headers: {}, body: "" };
  };
  const dispatcher = createWebhookDispatcher({ http, secretBox: box, store, env: ENABLED, events: deps, resolve });
  const results = await dispatcher.dispatch(COMPANY_A, {
    id: "evt-2",
    companyId: COMPANY_A,
    topic: "conversation.updated",
    payload: {},
  } as never);
  assert.equal(results[0].ok, true);
  const request = sent[0];
  assert.equal(request.headers?.[WEBHOOK_HEADERS.signature], signWebhookBody(SECRET, request.body ?? ""));
});

test("a subscription whose secret cannot be opened is not sent to", async () => {
  const store = createMemoryEventsStore();
  await store.insertSubscription(COMPANY_A, {
    id: "sub-bad",
    companyId: COMPANY_A,
    url: URL_IN,
    topics: ["*"],
    active: true,
    signingSecret: "v1:broken:broken:broken" as never,
  });
  let calls = 0;
  const http = async (): Promise<HttpResponse> => {
    calls += 1;
    return { status: 200, headers: {}, body: "" };
  };
  const dispatcher = createWebhookDispatcher({ http, secretBox: box, store, env: ENABLED, events: deps, resolve });
  const results = await dispatcher.dispatch(COMPANY_A, {
    id: "evt-3",
    companyId: COMPANY_A,
    topic: "conversation.created",
    payload: {},
  } as never);
  assert.equal(calls, 0);
  assert.equal(results[0].ok, false);
});
