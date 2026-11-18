import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mintStreamToken,
  verifyStreamToken,
  withStreamToken,
  streamTokenFromUrl,
  redactStreamToken,
  checkStreamTokenAtUpgrade,
  STREAM_TOKEN_TTL_SECONDS,
} from "./stream-token.ts";

const SECRET = "test-secret-for-stream-tokens";
const NOW = 1_800_000_000;
const CALL_A = "CA00000000000000000000000000000001";
const CALL_B = "CA00000000000000000000000000000002";

let savedSecret: string | undefined;

beforeEach(() => {
  savedSecret = process.env.STREAM_TOKEN_SECRET;
  process.env.STREAM_TOKEN_SECRET = SECRET;
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.STREAM_TOKEN_SECRET;
  else process.env.STREAM_TOKEN_SECRET = savedSecret;
});

test("correct token for the same call is accepted", () => {
  const token = mintStreamToken({ callId: CALL_A }, NOW);
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_A }, NOW + 1), { ok: true });
});

test("token issued for call A is refused for call B", () => {
  const token = mintStreamToken({ callId: CALL_A }, NOW);
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_B }, NOW + 1), { ok: false, reason: "wrong_call" });
});

test("missing token is refused", () => {
  assert.deepEqual(verifyStreamToken(null, { callId: CALL_A }, NOW), { ok: false, reason: "missing" });
  assert.deepEqual(verifyStreamToken("", { callId: CALL_A }, NOW), { ok: false, reason: "missing" });
  assert.deepEqual(verifyStreamToken(undefined, { callId: CALL_A }, NOW), { ok: false, reason: "missing" });
});

test("expired token is refused", () => {
  const token = mintStreamToken({ callId: CALL_A }, NOW);
  const at = NOW + STREAM_TOKEN_TTL_SECONDS;
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_A }, at), { ok: false, reason: "expired" });
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_A }, at - 1), { ok: true });
});

test("missing secret refuses verification and minting", () => {
  const token = mintStreamToken({ callId: CALL_A }, NOW);
  delete process.env.STREAM_TOKEN_SECRET;
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_A }, NOW + 1), { ok: false, reason: "no_secret" });
  assert.throws(() => mintStreamToken({ callId: CALL_A }, NOW), /STREAM_TOKEN_SECRET/);
});

test("token minted under a different secret is refused", () => {
  const token = mintStreamToken({ callId: CALL_A }, NOW);
  process.env.STREAM_TOKEN_SECRET = "another-secret";
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_A }, NOW + 1), { ok: false, reason: "bad_signature" });
});

test("tampered payload is refused", () => {
  const token = mintStreamToken({ callId: CALL_A }, NOW);
  const [, sig] = token.split(".");
  const forgedPayload = Buffer.from(JSON.stringify({ cid: CALL_B, exp: NOW + 120 }), "utf8").toString("base64url");
  assert.deepEqual(verifyStreamToken(`${forgedPayload}.${sig}`, { callId: CALL_B }, NOW + 1), {
    ok: false,
    reason: "bad_signature",
  });
});

test("malformed token is refused", () => {
  assert.deepEqual(verifyStreamToken("no-dot-here", { callId: CALL_A }, NOW), { ok: false, reason: "malformed" });
  assert.deepEqual(verifyStreamToken("a.b.c", { callId: CALL_A }, NOW), { ok: false, reason: "malformed" });
});

test("agent binding: token bound to an agent is refused for another agent or none", () => {
  const token = mintStreamToken({ callId: CALL_A, agentId: "agent-1" }, NOW);
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_A, agentId: "agent-1" }, NOW + 1), { ok: true });
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_A, agentId: "agent-2" }, NOW + 1), {
    ok: false,
    reason: "wrong_agent",
  });
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_A }, NOW + 1), { ok: false, reason: "wrong_agent" });
});

test("withStreamToken appends a token that streamTokenFromUrl reads back", () => {
  const url = withStreamToken("wss://example.test/api/plivo/stream/" + CALL_A, { callId: CALL_A });
  const token = streamTokenFromUrl(url);
  assert.ok(token);
  assert.deepEqual(verifyStreamToken(token, { callId: CALL_A }), { ok: true });
});

test("streamTokenFromUrl returns null when there is no token", () => {
  assert.equal(streamTokenFromUrl("/api/plivo/stream/CA1"), null);
  assert.equal(streamTokenFromUrl("/api/plivo/stream/CA1?other=1"), null);
  assert.equal(streamTokenFromUrl(undefined), null);
});

test("redactStreamToken hides the token value in logged text", () => {
  const text = '<Stream url="wss://h/api/x/CA1?t=abc.def">';
  assert.equal(redactStreamToken(text), '<Stream url="wss://h/api/x/CA1?t=[redacted]">');
});

test("JWT_SECRET is not a fallback: with only JWT_SECRET set, minting and verifying refuse", () => {
  delete process.env.STREAM_TOKEN_SECRET;
  process.env.JWT_SECRET = "jwt-only-secret";
  assert.throws(() => mintStreamToken({ callId: CALL_A }, NOW), /STREAM_TOKEN_SECRET/);
  assert.deepEqual(verifyStreamToken("abc.def", { callId: CALL_A }, NOW), { ok: false, reason: "no_secret" });
  assert.deepEqual(checkStreamTokenAtUpgrade("abc.def", NOW), { ok: false, reason: "no_secret" });
  delete process.env.JWT_SECRET;
});

test("upgrade-time check accepts a valid token without knowing the call", () => {
  const token = mintStreamToken({ callId: CALL_A, agentId: "agent-1" }, NOW);
  assert.deepEqual(checkStreamTokenAtUpgrade(token, NOW + 1), { ok: true });
});

test("upgrade-time check refuses missing, malformed, forged and expired tokens", () => {
  const token = mintStreamToken({ callId: CALL_A }, NOW);
  assert.deepEqual(checkStreamTokenAtUpgrade(null, NOW), { ok: false, reason: "missing" });
  assert.deepEqual(checkStreamTokenAtUpgrade("no-dot", NOW), { ok: false, reason: "malformed" });
  const [, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ cid: CALL_B, exp: NOW + 120 }), "utf8").toString("base64url");
  assert.deepEqual(checkStreamTokenAtUpgrade(`${forged}.${sig}`, NOW + 1), { ok: false, reason: "bad_signature" });
  assert.deepEqual(checkStreamTokenAtUpgrade(token, NOW + STREAM_TOKEN_TTL_SECONDS), { ok: false, reason: "expired" });
});
