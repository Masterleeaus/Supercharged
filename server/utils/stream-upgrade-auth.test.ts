import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mintStreamToken, streamTokenFromUrl, verifyStreamToken, withStreamToken } from "./stream-token.ts";

// Mirrors the upgrade checks in each route: take the identifier from the path (as the handler
// does with pathname.split(prefix)[1]), then verify the token carried on the request URL.
// The handlers themselves import the database, so they are not loaded here.

const SECRET = "upgrade-auth-test-secret";
const NOW = 1_800_000_000;
const CALL_A = "CA0000000000000000000000000000000a";
const CALL_B = "CA0000000000000000000000000000000b";

const ROUTES = [
  { name: "twilio-openai", prefix: "/api/twilio-openai/stream/", base: "wss://app.test/api/twilio-openai/stream/" },
  { name: "plivo", prefix: "/api/plivo/stream/", base: "wss://app.test/api/plivo/stream/" },
  { name: "plivo-elevenlabs", prefix: "/api/plivo-elevenlabs/stream/", base: "wss://app.test/api/plivo-elevenlabs/stream/" },
];

function identifierFromPath(requestUrl: string, prefix: string): string {
  const pathname = requestUrl.split("?")[0] || "";
  return pathname.split(prefix)[1] || "";
}

function checkUpgrade(requestUrl: string, prefix: string, now: number): { ok: boolean; reason?: string } {
  const callId = identifierFromPath(requestUrl, prefix);
  if (!callId) return { ok: false, reason: "no_identifier" };
  const result = verifyStreamToken(streamTokenFromUrl(requestUrl), { callId }, now);
  return result.ok ? { ok: true } : { ok: false, reason: result.reason };
}

let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.STREAM_TOKEN_SECRET;
  process.env.STREAM_TOKEN_SECRET = SECRET;
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.STREAM_TOKEN_SECRET;
  else process.env.STREAM_TOKEN_SECRET = savedSecret;
});

for (const route of ROUTES) {
  test(`${route.name}: URL issued for call A is accepted for call A`, () => {
    const url = withStreamToken(route.base + CALL_A, { callId: CALL_A });
    // withStreamToken mints from the real clock, so verify against the real clock too.
    assert.deepEqual(checkUpgrade(url, route.prefix, Date.now() / 1000), { ok: true });
  });

  test(`${route.name}: token issued for call A is refused on call B's path`, () => {
    const tokenForA = mintStreamToken({ callId: CALL_A }, NOW);
    const url = `${route.base}${CALL_B}?t=${tokenForA}`;
    assert.deepEqual(checkUpgrade(url, route.prefix, NOW + 1), { ok: false, reason: "wrong_call" });
  });

  test(`${route.name}: request with no token is refused`, () => {
    assert.deepEqual(checkUpgrade(route.base + CALL_A, route.prefix, NOW), { ok: false, reason: "missing" });
  });

  test(`${route.name}: expired token is refused`, () => {
    const url = withStreamToken(route.base + CALL_A, { callId: CALL_A });
    const token = streamTokenFromUrl(url);
    assert.ok(token);
    assert.deepEqual(checkUpgrade(`${route.base}${CALL_A}?t=${token}`, route.prefix, NOW + 10_000), {
      ok: false,
      reason: "expired",
    });
  });

  test(`${route.name}: no secret configured refuses the upgrade`, () => {
    const url = withStreamToken(route.base + CALL_A, { callId: CALL_A });
    delete process.env.STREAM_TOKEN_SECRET;
    assert.deepEqual(checkUpgrade(url, route.prefix, NOW), { ok: false, reason: "no_secret" });
  });
}

test("twilio + elevenlabs: token must match both callId and agentId from the start event", () => {
  const url = withStreamToken("wss://app.test/api/webhooks/twilio/stream", { callId: CALL_A, agentId: "agent-1" });
  const token = streamTokenFromUrl(url);
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_A, agentId: "agent-1" }), { ok: true });
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_B, agentId: "agent-1" }), { ok: false, reason: "wrong_call" });
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_A, agentId: "agent-2" }), { ok: false, reason: "wrong_agent" });
});

test("twilio + elevenlabs: request with no token is refused at upgrade", () => {
  assert.equal(streamTokenFromUrl("wss://app.test/api/webhooks/twilio/stream"), null);
});
