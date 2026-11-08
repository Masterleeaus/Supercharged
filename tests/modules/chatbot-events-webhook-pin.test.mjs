// Webhook send pin (audit item C5). The dispatcher and the pinned client connect to the address they checked.
// Covers: DNS rebind between subscribe and send, a private address in the answer, 301 refused, 307 followed to a
// public host (with the Host header, servername and signature kept), 307 back to a name that now resolves private,
// and the hop limit. No network: DNS is a stub resolver and the socket layer is a fake requester.
//
// Run: NODE_OPTIONS="--import /home/claude/integration-scratch/hook/register.mjs" node --test --experimental-transform-types tests/modules/chatbot-events-webhook-pin.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";
import { createMemoryEventsStore } from "../../server/modules/chatbot/events/memory-store.ts";
import { createWebhookDispatcher, createWebhookSubscriptionService, WEBHOOK_MAX_REDIRECTS } from "../../server/modules/chatbot/events/webhooks.ts";
import { createPinnedWebhookHttp } from "../../server/modules/chatbot/events/pinned-webhook.ts";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const HOOK = "https://hooks.example.test/chatbot";
const SECRET = "whsec_pin_test_0123456789abcdef0123456";
const PUBLIC_IP = "93.184.216.34";
const OTHER_PUBLIC_IP = "151.101.1.69";
const METADATA_IP = "169.254.169.254";
const ENABLED = { [CONTRACT_FLAGS.OUTBOUND_WEBHOOKS_ENABLED]: "true" };
const START = new Date("2026-11-09T10:00:00.000Z");

function makeSecretBox() {
  const key = randomBytes(32);
  return {
    async encrypt(companyId, plaintext) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(companyId, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return {
        v: 1,
        alg: "aes-256-gcm",
        keyId: "v1",
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      };
    },
    async decrypt(companyId, sealed) {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
      decipher.setAAD(Buffer.from(companyId, "utf8"));
      decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64")), decipher.final()]).toString("utf8");
    },
  };
}

/** Resolver stub. Each call returns the next answer in the list, then keeps returning the last one. */
function scriptedResolver(...answers) {
  const seen = [];
  const resolve = async (hostname) => {
    seen.push(hostname);
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { resolve, seen };
}

/**
 * Name-keyed resolver. Each name keeps a list of answers, one per lookup of that name, and the last answer repeats.
 * An answer is a single address, returned as a one-item list.
 */
function mapResolver(map) {
  const seen = [];
  const counts = new Map();
  const resolve = async (hostname) => {
    seen.push(hostname);
    const list = map[hostname] ?? [PUBLIC_IP];
    const n = counts.get(hostname) ?? 0;
    counts.set(hostname, n + 1);
    return [list[Math.min(n, list.length - 1)]];
  };
  return { resolve, seen };
}

/**
 * Fake node:https request. respond(call) returns { status, headers, body } or { error: true }. Every call is
 * recorded with its options and body. The socket goes to options.host, which is what the test checks.
 */
function fakeHttps(respond) {
  const calls = [];
  const requester = (options, onResponse) => {
    const call = { options, body: undefined };
    calls.push(call);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = (body) => {
      call.body = body;
      setImmediate(() => {
        const out = respond(call);
        if (out.error) {
          req.emit("error", new Error("socket reset"));
          return;
        }
        const res = new EventEmitter();
        res.statusCode = out.status;
        res.headers = out.headers ?? {};
        res.destroy = () => {};
        onResponse(res);
        if (out.body !== undefined) res.emit("data", Buffer.from(out.body, "utf8"));
        res.emit("end");
      });
    };
    return req;
  };
  return { requester, calls };
}

const OK = { status: 200, headers: {}, body: "" };
const redirect = (status, location) => ({ status, headers: { location }, body: "" });

/**
 * Builds the dispatcher on a memory store with the pinned client and a fake socket layer. The subscription is
 * saved first with `subscribeResolve`, so the dispatch-time lookups start after it.
 */
async function world({ resolve, respond = () => OK, url = HOOK }) {
  let seq = 0;
  const events = { now: () => new Date(START), newId: () => `id-${++seq}` };
  const store = createMemoryEventsStore();
  const secretBox = makeSecretBox();
  const socket = fakeHttps(respond);
  const subscriptions = createWebhookSubscriptionService(store, secretBox, events, resolve);
  const webhooks = createWebhookDispatcher({
    secretBox,
    store,
    env: ENABLED,
    events,
    resolve,
    transport: { https: socket.requester },
  });
  await subscriptions.subscribe(COMPANY, { url, topics: ["*"], signingSecret: SECRET });
  const event = { id: "evt-1", companyId: COMPANY, topic: "conversation.handoff", payload: { conversationId: "c1" } };
  return { webhooks, socket, event };
}

test("DNS rebind after subscribe: the send re-checks, sees the private answer, and opens no socket to it", async () => {
  // Call 1 is the subscribe-time check (public). Call 2 is the send-time check (metadata). The send is refused.
  const { resolve, seen } = scriptedResolver([PUBLIC_IP], [METADATA_IP]);
  const w = await world({ resolve });
  const [delivery] = await w.webhooks.dispatch(COMPANY, w.event);

  assert.equal(seen.length, 2);
  assert.equal(delivery.ok, false);
  assert.equal(delivery.errorMessage, "Address refused.");
  assert.equal(w.socket.calls.length, 0, "nothing is connected to the rebound address");
});

test("a private address anywhere in the answer refuses the send and opens no socket", async () => {
  const { resolve } = scriptedResolver([PUBLIC_IP], [PUBLIC_IP, "10.0.0.5"]);
  const w = await world({ resolve });
  const [delivery] = await w.webhooks.dispatch(COMPANY, w.event);
  assert.equal(delivery.errorMessage, "Address refused.");
  assert.equal(w.socket.calls.length, 0);
});

test("a single send connects to the checked address even when the resolver would now answer differently", async () => {
  // The pinned client resolves once per request. A second answer inside that request is never read.
  const { resolve, seen } = scriptedResolver([PUBLIC_IP], [METADATA_IP]);
  const socket = fakeHttps(() => OK);
  const pinned = createPinnedWebhookHttp({ resolve, transport: { https: socket.requester } });
  await pinned({ method: "POST", url: HOOK, body: "{}", timeoutMs: 1000 });
  assert.equal(seen.length, 1, "one lookup per request");
  assert.equal(socket.calls[0].options.host, PUBLIC_IP);
  assert.equal(socket.calls[0].options.servername, "hooks.example.test");
});

test("a 301 is not followed: the delivery fails and the Location target is never requested", async () => {
  const { resolve } = mapResolver({ "hooks.example.test": [PUBLIC_IP], "other.example.test": [OTHER_PUBLIC_IP] });
  const w = await world({ resolve, respond: () => redirect(301, "https://other.example.test/next") });
  const [delivery] = await w.webhooks.dispatch(COMPANY, w.event);
  assert.equal(delivery.ok, false);
  assert.equal(delivery.httpStatus, 301);
  assert.equal(delivery.errorMessage, "Redirect not followed.");
  assert.equal(w.socket.calls.length, 1);
});

test("a 307 is followed to a public host, keeping method, body, signature and the per-host Host and servername", async () => {
  const { resolve } = mapResolver({ "hooks.example.test": [PUBLIC_IP], "other.example.test": [OTHER_PUBLIC_IP] });
  const w = await world({
    resolve,
    respond: (call) => (call.options.host === PUBLIC_IP ? redirect(307, "https://other.example.test/next") : OK),
  });
  const [delivery] = await w.webhooks.dispatch(COMPANY, w.event);

  assert.equal(delivery.ok, true);
  assert.equal(delivery.httpStatus, 200);
  assert.equal(w.socket.calls.length, 2);
  const [first, second] = w.socket.calls;
  assert.equal(first.options.host, PUBLIC_IP);
  assert.equal(first.options.headers.host, "hooks.example.test");
  assert.equal(second.options.host, OTHER_PUBLIC_IP, "the second hop connects to its own checked address");
  assert.equal(second.options.headers.host, "other.example.test");
  assert.equal(second.options.servername, "other.example.test");
  assert.equal(second.options.method, "POST");
  assert.equal(second.options.path, "/next");
  assert.equal(second.body, first.body, "the same body bytes are sent on the followed hop");
  assert.equal(second.options.headers["X-Chatbot-Signature"], first.options.headers["X-Chatbot-Signature"]);
});

test("a 307 back to the same name that now resolves private is refused before a second socket is opened", async () => {
  // The redirect is a second send-time lookup of the same name, which the rebind moved to a private address.
  const { resolve, seen } = scriptedResolver([PUBLIC_IP], [PUBLIC_IP], [METADATA_IP]);
  const w = await world({ resolve, respond: () => redirect(307, HOOK) });
  const [delivery] = await w.webhooks.dispatch(COMPANY, w.event);

  assert.equal(seen.length, 3, "subscribe, first send, redirect hop");
  assert.equal(delivery.ok, false);
  assert.equal(delivery.errorMessage, "Redirect target refused.");
  assert.equal(w.socket.calls.length, 1, "only the first public hop was connected");
});

test("redirects stop after the hop limit", async () => {
  const { resolve } = mapResolver({ "hooks.example.test": [PUBLIC_IP], "next.example.test": [OTHER_PUBLIC_IP] });
  const w = await world({ resolve, respond: () => redirect(308, "https://next.example.test/again") });
  const [delivery] = await w.webhooks.dispatch(COMPANY, w.event);
  assert.equal(delivery.errorMessage, "Too many redirects.");
  assert.equal(w.socket.calls.length, WEBHOOK_MAX_REDIRECTS + 1);
});
