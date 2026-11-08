// Model provider tests (node:test). Covers OpenAI, Anthropic and Gemini request and response mapping, the
// registry, the failover policy, stream events, and secret handling. No network: every HTTP call goes through
// a scripted fake HttpClient. A call with no scripted response throws, and tests count calls per host.
import test from "node:test";
import assert from "node:assert/strict";
import {
  OpenAIModelProvider,
  OPENAI_CHAT_URL,
  OPENAI_EMBED_URL,
  AnthropicModelProvider,
  ANTHROPIC_MESSAGES_URL,
  GeminiModelProvider,
  GEMINI_BASE_URL,
  createProviderRegistry,
  createFailoverPolicy,
  validateFailoverPolicy,
  completeWithFailover,
  backoffDelayMs,
  ModelCallError,
  ModelCallFailure,
  streamWithFailover,
  scrubMessage,
} from "../../server/modules/chatbot/ai/index.ts";
import { DEFAULT_FAILOVER_POLICY, CONTRACT_FLAGS } from "../../server/modules/chatbot/contracts/index.ts";

// ---------- fixtures ----------

const COMPANY = "11111111-1111-4111-8111-111111111111";
const OPENAI_KEY = "sk-test-openai-SECRET-0001";
const ANTHROPIC_KEY = "sk-ant-test-anthropic-SECRET-0002";
const GEMINI_KEY = "AIzaSyTestGeminiSecret000003";
const KEYS_ENV = { OPENAI_API_KEY: OPENAI_KEY, ANTHROPIC_API_KEY: ANTHROPIC_KEY };
const GEMINI_ENV = { ...KEYS_ENV, GEMINI_API_KEY: GEMINI_KEY, [CONTRACT_FLAGS.GEMINI_ENABLED]: "true" };

const BASE_REQUEST = {
  model: "test-model",
  messages: [
    { role: "system", content: "Be brief." },
    { role: "user", content: "hello" },
  ],
  timeoutMs: 5000,
  purpose: "reply",
};

const openaiOk = (text = "Hi there") => ({
  id: "chatcmpl-1",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 3 },
});
const anthropicOk = (text = "Hi from Claude") => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text }],
  stop_reason: "end_turn",
  usage: { input_tokens: 8, output_tokens: 4 },
});
const geminiOk = (text = "Hi from Gemini") => ({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 },
});

const reply = (status, json, headers = {}) => ({ status, headers, body: typeof json === "string" ? json : JSON.stringify(json) });
const timeout = () => ({ throw: { kind: "timeout", message: "The operation timed out." } });
const network = (message) => ({ throw: { kind: "network", message } });

/**
 * Scripted fake HttpClient. script maps "openai" | "anthropic" | "gemini" to a queue of responses.
 * advanceMs moves the fake clock forward on every call, to test the shared budget.
 */
function scripted(script, { advanceMs = 0 } = {}) {
  const clock = { t: 0, now: () => clock.t };
  const calls = [];
  const queues = {
    openai: [...(script.openai ?? [])],
    anthropic: [...(script.anthropic ?? [])],
    gemini: [...(script.gemini ?? [])],
  };
  const hostKey = (url) => {
    if (url.startsWith("https://api.openai.com/")) return "openai";
    if (url.startsWith("https://api.anthropic.com/")) return "anthropic";
    if (url.startsWith("https://generativelanguage.googleapis.com/")) return "gemini";
    return "unknown";
  };
  const http = async (request) => {
    calls.push(request);
    clock.t += advanceMs;
    const key = hostKey(request.url);
    const queue = queues[key];
    if (!queue || queue.length === 0) {
      throw new Error(`unscripted call to ${key}`);
    }
    const next = queue.shift();
    if (next.throw) {
      const err = new Error("transport");
      err.kind = next.throw.kind;
      err.message = next.throw.message;
      throw err;
    }
    return next;
  };
  return {
    http,
    clock,
    calls,
    callsTo: (provider) => calls.filter((c) => hostKey(c.url) === provider),
  };
}

const noSleep = () => {
  const delays = [];
  return { delays, sleep: async (ms) => { delays.push(ms); } };
};

async function rejects(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail("expected the call to reject");
}

// ---------- failover order and retries ----------

test("failover order: OpenAI uses its attempts, then Anthropic answers", async () => {
  const h = scripted({ openai: [reply(503, {}), reply(503, {})], anthropic: [reply(200, anthropicOk())] });
  const s = noSleep();
  const registry = createProviderRegistry({ env: KEYS_ENV, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  const policy = createFailoverPolicy(KEYS_ENV);
  const result = await completeWithFailover(registry, policy, COMPANY, BASE_REQUEST, { sleep: s.sleep, now: h.clock.now });
  assert.equal(result.provider, "anthropic");
  assert.equal(result.text, "Hi from Claude");
  assert.equal(h.callsTo("openai").length, 2);
  assert.equal(h.callsTo("anthropic").length, 1);
  assert.deepEqual(s.delays, [250]);
});

test("retry on 503 stays on the same provider and does not fail over", async () => {
  const h = scripted({ openai: [reply(503, { error: { message: "busy" } }), reply(200, openaiOk())], anthropic: [] });
  const s = noSleep();
  const registry = createProviderRegistry({ env: KEYS_ENV, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  const result = await completeWithFailover(registry, createFailoverPolicy(KEYS_ENV), COMPANY, BASE_REQUEST, { sleep: s.sleep, now: h.clock.now });
  assert.equal(result.provider, "openai");
  assert.equal(h.callsTo("openai").length, 2);
  assert.equal(h.callsTo("anthropic").length, 0);
  assert.deepEqual(s.delays, [250]);
});

test("each listed failover status (429, 500, 502, 504) is retried on the same provider", async () => {
  for (const status of [429, 500, 502, 504]) {
    const h = scripted({ openai: [reply(status, {}), reply(200, openaiOk())], anthropic: [] });
    const s = noSleep();
    const registry = createProviderRegistry({ env: KEYS_ENV, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
    const result = await completeWithFailover(registry, createFailoverPolicy(KEYS_ENV), COMPANY, BASE_REQUEST, { sleep: s.sleep, now: h.clock.now });
    assert.equal(result.provider, "openai", `status ${status}`);
    assert.equal(h.callsTo("anthropic").length, 0, `status ${status}`);
  }
});

test("no failover on 400: the error goes straight back and Anthropic is never called", async () => {
  const h = scripted({ openai: [reply(400, { error: { message: "bad temperature" } })], anthropic: [] });
  const registry = createProviderRegistry({ env: KEYS_ENV, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  const err = await rejects(completeWithFailover(registry, createFailoverPolicy(KEYS_ENV), COMPANY, BASE_REQUEST, { sleep: noSleep().sleep, now: h.clock.now }));
  assert.ok(err instanceof ModelCallFailure);
  assert.equal(err.error.status, 400);
  assert.equal(err.error.code, "bad_request");
  assert.equal(err.error.retryable, false);
  assert.equal(err.attempts.length, 1);
  assert.equal(h.callsTo("openai").length, 1);
  assert.equal(h.callsTo("anthropic").length, 0);
});

test("no failover on 401: a bad key is reported, not hidden by the next provider", async () => {
  const h = scripted({ openai: [reply(401, { error: { message: "Incorrect API key" } })], anthropic: [] });
  const registry = createProviderRegistry({ env: KEYS_ENV, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  const err = await rejects(completeWithFailover(registry, createFailoverPolicy(KEYS_ENV), COMPANY, BASE_REQUEST, { sleep: noSleep().sleep, now: h.clock.now }));
  assert.equal(err.error.code, "auth");
  assert.equal(h.callsTo("anthropic").length, 0);
});

test("timeout fails over at once without retrying the same provider", async () => {
  const h = scripted({ openai: [timeout()], anthropic: [reply(200, anthropicOk())] });
  const s = noSleep();
  const registry = createProviderRegistry({ env: KEYS_ENV, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  const result = await completeWithFailover(registry, createFailoverPolicy(KEYS_ENV), COMPANY, BASE_REQUEST, { sleep: s.sleep, now: h.clock.now });
  assert.equal(result.provider, "anthropic");
  assert.equal(h.callsTo("openai").length, 1);
  assert.deepEqual(s.delays, []);
});

test("shared budget: failover gets only the time left on the call", async () => {
  // Each HTTP call takes 60 ms of fake time. Budget is 100 ms, so after the first 503 there is no room to wait 250 ms.
  const h = scripted({ openai: [reply(503, {})], anthropic: [reply(200, anthropicOk())] }, { advanceMs: 60 });
  const s = noSleep();
  const registry = createProviderRegistry({ env: KEYS_ENV, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  const result = await completeWithFailover(
    registry,
    createFailoverPolicy(KEYS_ENV),
    COMPANY,
    { ...BASE_REQUEST, timeoutMs: 100 },
    { sleep: s.sleep, now: h.clock.now },
  );
  assert.equal(result.provider, "anthropic");
  assert.equal(h.callsTo("openai").length, 1);
  assert.equal(h.callsTo("anthropic")[0].timeoutMs, 40);
  assert.deepEqual(s.delays, []);
});

test("all providers fail: the last error and every attempt are returned", async () => {
  const h = scripted({ openai: [reply(503, {}), reply(503, {})], anthropic: [reply(503, {}), reply(503, {})] });
  const s = noSleep();
  const registry = createProviderRegistry({ env: KEYS_ENV, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  const err = await rejects(completeWithFailover(registry, createFailoverPolicy(KEYS_ENV), COMPANY, BASE_REQUEST, { sleep: s.sleep, now: h.clock.now }));
  assert.equal(err.error.status, 503);
  assert.equal(err.error.message, "Anthropic returned HTTP 503.");
  assert.deepEqual(err.attempts.map((a) => a.provider), ["openai", "openai", "anthropic", "anthropic"]);
});

test("Gemini joins the failover order only when CHATBOT_GEMINI_ENABLED is exactly true", async () => {
  const h = scripted({
    openai: [reply(503, {}), reply(503, {})],
    anthropic: [reply(503, {}), reply(503, {})],
    gemini: [reply(200, geminiOk())],
  });
  const registry = createProviderRegistry({ env: GEMINI_ENV, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  const policy = createFailoverPolicy(GEMINI_ENV);
  assert.deepEqual(policy.order, ["openai", "anthropic", "gemini"]);
  const result = await completeWithFailover(registry, policy, COMPANY, BASE_REQUEST, { sleep: noSleep().sleep, now: h.clock.now });
  assert.equal(result.provider, "gemini");
  assert.equal(result.text, "Hi from Gemini");
});

test("backoff doubles from the base and stops at the cap", () => {
  const policy = createFailoverPolicy(KEYS_ENV);
  const delays = [1, 2, 3, 4, 5].map((n) => backoffDelayMs(policy, n));
  assert.deepEqual(delays, [250, 500, 1000, 2000, 2000]);
});

// ---------- keys and fail-closed behaviour ----------

test("registry: a provider with no key is absent, so failover skips it", async () => {
  const h = scripted({ anthropic: [reply(200, anthropicOk())], openai: [] });
  const registry = createProviderRegistry({ env: { ANTHROPIC_API_KEY: ANTHROPIC_KEY }, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  assert.deepEqual(registry.available(), ["anthropic"]);
  assert.equal(registry.get("openai"), null);
  assert.deepEqual(registry.resolve(createFailoverPolicy(KEYS_ENV)).map((p) => p.key), ["anthropic"]);
  const result = await completeWithFailover(registry, createFailoverPolicy(KEYS_ENV), COMPANY, BASE_REQUEST, { sleep: noSleep().sleep, now: h.clock.now });
  assert.equal(result.provider, "anthropic");
  assert.equal(h.callsTo("openai").length, 0);
});

test("a whitespace-only key counts as missing", () => {
  const registry = createProviderRegistry({ env: { OPENAI_API_KEY: "   ", ANTHROPIC_API_KEY: ANTHROPIC_KEY }, http: scripted({}).http, policy: DEFAULT_FAILOVER_POLICY });
  assert.deepEqual(registry.available(), ["anthropic"]);
});

test("direct call with a missing key fails closed, names the variable, and makes no request", async () => {
  const h = scripted({});
  const provider = new OpenAIModelProvider({ apiKey: undefined, http: h.http });
  const err = await rejects(provider.complete(COMPANY, BASE_REQUEST));
  assert.ok(err instanceof ModelCallError);
  assert.equal(err.providerError.code, "auth");
  assert.equal(err.providerError.status, null);
  assert.equal(err.providerError.retryable, false);
  assert.match(err.message, /OPENAI_API_KEY/);
  assert.equal(h.calls.length, 0);
});

test("no keys at all: failover fails closed, names both variables, and makes no request", async () => {
  const h = scripted({});
  const registry = createProviderRegistry({ env: {}, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  const err = await rejects(completeWithFailover(registry, createFailoverPolicy({}), COMPANY, BASE_REQUEST, { sleep: noSleep().sleep, now: h.clock.now }));
  assert.ok(err instanceof ModelCallFailure);
  assert.match(err.message, /OPENAI_API_KEY/);
  assert.match(err.message, /ANTHROPIC_API_KEY/);
  assert.equal(err.error.retryable, false);
  assert.deepEqual(err.attempts, []);
  assert.equal(h.calls.length, 0);
});

test("Gemini is off unless its flag is exactly the string true", () => {
  for (const flag of [undefined, "", "1", "yes", "on", "TRUE"]) {
    const env = { ...KEYS_ENV, GEMINI_API_KEY: GEMINI_KEY, [CONTRACT_FLAGS.GEMINI_ENABLED]: flag };
    const registry = createProviderRegistry({ env, http: scripted({}).http, policy: DEFAULT_FAILOVER_POLICY });
    assert.ok(!registry.available().includes("gemini"), `flag ${JSON.stringify(flag)} should be off`);
    assert.equal(registry.get("gemini"), null);
    assert.ok(!createFailoverPolicy(env).order.includes("gemini"), `policy for flag ${JSON.stringify(flag)}`);
  }
  const on = createProviderRegistry({ env: GEMINI_ENV, http: scripted({}).http, policy: DEFAULT_FAILOVER_POLICY });
  assert.ok(on.available().includes("gemini"));
});

test("the key never appears in an error, a serialised error, a stack, or the provider object", async () => {
  const h = scripted({
    // The transport error text carries a full URL with a key in it. The provider must not pass it on.
    openai: [network(`connect failed for https://api.openai.com/v1/chat/completions?key=${OPENAI_KEY}`)],
    // The Anthropic error body echoes both keys. Both must be scrubbed.
    anthropic: [reply(401, { error: { message: `bad key ${ANTHROPIC_KEY} (also ${OPENAI_KEY})` } })],
  });
  const registry = createProviderRegistry({ env: KEYS_ENV, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  const err = await rejects(completeWithFailover(registry, createFailoverPolicy(KEYS_ENV), COMPANY, BASE_REQUEST, { sleep: noSleep().sleep, now: h.clock.now }));
  const surfaces = [err.message, String(err), err.stack ?? "", JSON.stringify(err), JSON.stringify(err.error), JSON.stringify(err.attempts)];
  for (const text of surfaces) {
    assert.ok(!text.includes(OPENAI_KEY), "OpenAI key leaked");
    assert.ok(!text.includes(ANTHROPIC_KEY), "Anthropic key leaked");
  }
  const provider = new OpenAIModelProvider({ apiKey: OPENAI_KEY, http: h.http });
  assert.ok(!JSON.stringify(provider).includes(OPENAI_KEY));
  assert.ok(!String(provider).includes(OPENAI_KEY));
});

test("the key-shaped text is scrubbed even when the key is not one we hold", async () => {
  const h = scripted({ openai: [reply(400, { error: { message: "rejected sk-live-abcdefghijk123456" } })] });
  const provider = new OpenAIModelProvider({ apiKey: OPENAI_KEY, http: h.http });
  const err = await rejects(provider.complete(COMPANY, BASE_REQUEST));
  assert.match(err.message, /\[redacted\]/);
  assert.ok(!err.message.includes("sk-live-abcdefghijk123456"));
  assert.equal(scrubMessage(`x=${OPENAI_KEY}`, [OPENAI_KEY]), "x=[redacted]");
});

test("Gemini sends its key in a header, never in the URL", async () => {
  const h = scripted({ gemini: [reply(200, geminiOk())] });
  const provider = new GeminiModelProvider({ apiKey: GEMINI_KEY, http: h.http });
  const result = await provider.complete(COMPANY, { ...BASE_REQUEST, model: "gemini-test-flash" });
  assert.equal(result.text, "Hi from Gemini");
  const call = h.calls[0];
  assert.equal(call.url, `${GEMINI_BASE_URL}/models/gemini-test-flash:generateContent`);
  assert.ok(!call.url.includes(GEMINI_KEY));
  assert.equal(call.headers["x-goog-api-key"], GEMINI_KEY);
});

test("Gemini refuses a model id that could change the path, before any request", async () => {
  const h = scripted({});
  const provider = new GeminiModelProvider({ apiKey: GEMINI_KEY, http: h.http });
  const err = await rejects(provider.complete(COMPANY, { ...BASE_REQUEST, model: "../../evil?x=1" }));
  assert.equal(err.providerError.code, "bad_request");
  assert.equal(h.calls.length, 0);
});

// ---------- inputs and timeouts ----------

test("timeoutMs is passed to the HTTP client, and invalid values are refused before any request", async () => {
  const h = scripted({ openai: [reply(200, openaiOk())] });
  const provider = new OpenAIModelProvider({ apiKey: OPENAI_KEY, http: h.http });
  await provider.complete(COMPANY, { ...BASE_REQUEST, timeoutMs: 1234 });
  assert.equal(h.calls[0].timeoutMs, 1234);
  for (const bad of [0, -5, 1.5, Number.NaN]) {
    const err = await rejects(provider.complete(COMPANY, { ...BASE_REQUEST, timeoutMs: bad }));
    assert.equal(err.providerError.code, "bad_request");
  }
  assert.equal(h.calls.length, 1);
});

test("companyId is required and checked before any request", async () => {
  const h = scripted({});
  const provider = new OpenAIModelProvider({ apiKey: OPENAI_KEY, http: h.http });
  const err = await rejects(provider.complete("", BASE_REQUEST));
  assert.equal(err.providerError.code, "bad_request");
  assert.equal(h.calls.length, 0);
});

test("a 200 body that is not JSON is non-retryable and does not fail over", async () => {
  const h = scripted({ openai: [reply(200, "<html>oops</html>")], anthropic: [] });
  const registry = createProviderRegistry({ env: KEYS_ENV, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  const err = await rejects(completeWithFailover(registry, createFailoverPolicy(KEYS_ENV), COMPANY, BASE_REQUEST, { sleep: noSleep().sleep, now: h.clock.now }));
  assert.equal(err.error.code, "unknown");
  assert.equal(err.error.retryable, false);
  assert.equal(h.callsTo("anthropic").length, 0);
});

test("policy validation rejects a zero attempt count and an unknown provider", () => {
  assert.throws(() => validateFailoverPolicy({ ...DEFAULT_FAILOVER_POLICY, maxAttemptsPerProvider: 0 }), /maxAttemptsPerProvider/);
  assert.throws(() => validateFailoverPolicy({ ...DEFAULT_FAILOVER_POLICY, order: ["mystery"] }), /unknown provider/);
});

test("resolve keeps policy order and drops duplicates", () => {
  const registry = createProviderRegistry({ env: KEYS_ENV, http: scripted({}).http, policy: DEFAULT_FAILOVER_POLICY });
  const policy = { ...DEFAULT_FAILOVER_POLICY, order: ["anthropic", "openai", "anthropic"] };
  assert.deepEqual(registry.resolve(policy).map((p) => p.key), ["anthropic", "openai"]);
});

// ---------- OpenAI mapping ----------

test("OpenAI request: Bearer header, exact URL, tools, tool_call_id, json mode, token cap", async () => {
  const h = scripted({ openai: [reply(200, openaiOk())] });
  const provider = new OpenAIModelProvider({ apiKey: OPENAI_KEY, http: h.http });
  await provider.complete(COMPANY, {
    ...BASE_REQUEST,
    messages: [
      { role: "system", content: "S" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
      { role: "tool", content: "result", toolCallId: "call_1" },
    ],
    tools: [{ name: "lookup", description: "find", parameters: { type: "object" } }],
    responseFormat: "json",
    maxOutputTokens: 300,
    temperature: 0.2,
  });
  const call = h.calls[0];
  assert.equal(call.url, OPENAI_CHAT_URL);
  assert.equal(call.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(call.method, "POST");
  assert.equal(call.headers.Authorization, `Bearer ${OPENAI_KEY}`);
  const body = JSON.parse(call.body);
  assert.equal(body.model, "test-model");
  assert.deepEqual(body.messages[3], { role: "tool", content: "result", tool_call_id: "call_1" });
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "lookup");
  assert.equal(body.tool_choice, "auto");
  assert.equal(body.max_completion_tokens, 300);
  assert.equal(body.temperature, 0.2);
  assert.deepEqual(body.response_format, { type: "json_object" });
});

test("OpenAI response: tool calls parsed, malformed arguments become {}, request id kept", async () => {
  const h = scripted({
    openai: [
      reply(
        200,
        {
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  { id: "call_9", type: "function", function: { name: "lookup", arguments: '{"q":"pipes"}' } },
                  { id: "call_10", type: "function", function: { name: "lookup", arguments: "{broken" } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 5 },
        },
        { "x-request-id": "req_abc" },
      ),
    ],
  });
  const result = await new OpenAIModelProvider({ apiKey: OPENAI_KEY, http: h.http }).complete(COMPANY, BASE_REQUEST);
  assert.equal(result.finishReason, "tool_call");
  assert.equal(result.text, "");
  assert.deepEqual(result.toolCalls, [
    { id: "call_9", name: "lookup", arguments: { q: "pipes" } },
    { id: "call_10", name: "lookup", arguments: {} },
  ]);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 5 });
  assert.equal(result.providerRequestId, "req_abc");
});

test("OpenAI embed: vectors come back in input order, with dimensions and usage", async () => {
  const h = scripted({
    openai: [
      reply(200, {
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
        usage: { prompt_tokens: 4 },
      }),
    ],
  });
  const result = await new OpenAIModelProvider({ apiKey: OPENAI_KEY, http: h.http }).embed(COMPANY, {
    model: "embed-test",
    inputs: ["first", "second"],
    timeoutMs: 3000,
  });
  assert.equal(h.calls[0].url, OPENAI_EMBED_URL);
  assert.deepEqual(result.vectors, [[1, 0], [0, 1]]);
  assert.equal(result.dimensions, 2);
  assert.deepEqual(result.usage, { inputTokens: 4 });
});

test("OpenAI embed: a count mismatch is an error, not a short result", async () => {
  const h = scripted({ openai: [reply(200, { data: [{ index: 0, embedding: [1, 0] }] })] });
  const err = await rejects(new OpenAIModelProvider({ apiKey: OPENAI_KEY, http: h.http }).embed(COMPANY, {
    model: "embed-test",
    inputs: ["a", "b"],
    timeoutMs: 3000,
  }));
  assert.equal(err.providerError.code, "unknown");
});

// ---------- Anthropic mapping ----------

test("Anthropic request: system split out, consecutive turns merged, tool_result block, headers", async () => {
  const h = scripted({ anthropic: [reply(200, anthropicOk())] });
  const provider = new AnthropicModelProvider({ apiKey: ANTHROPIC_KEY, http: h.http });
  await provider.complete(COMPANY, {
    ...BASE_REQUEST,
    messages: [
      { role: "system", content: "S1" },
      { role: "system", content: "S2" },
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a1" },
      { role: "tool", content: "result text", toolCallId: "toolu_1" },
    ],
    responseFormat: "json",
  });
  const call = h.calls[0];
  assert.equal(call.url, ANTHROPIC_MESSAGES_URL);
  assert.equal(call.headers["x-api-key"], ANTHROPIC_KEY);
  assert.equal(call.headers["anthropic-version"], "2023-06-01");
  const body = JSON.parse(call.body);
  assert.match(body.system, /^S1\n\nS2\n\n/);
  assert.match(body.system, /single valid JSON object/);
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ type: "text", text: "u1" }, { type: "text", text: "u2" }] },
    { role: "assistant", content: [{ type: "text", text: "a1" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "result text" }] },
  ]);
});

test("Anthropic response: text joined, tool_use parsed, stop reason mapped", async () => {
  const h = scripted({
    anthropic: [
      reply(
        200,
        {
          content: [
            { type: "text", text: "Let me check. " },
            { type: "tool_use", id: "toolu_2", name: "lookup", input: { q: "x" } },
          ],
          stop_reason: "tool_use",
          usage: { input_tokens: 8, output_tokens: 4 },
        },
        { "request-id": "req_anth" },
      ),
    ],
  });
  const result = await new AnthropicModelProvider({ apiKey: ANTHROPIC_KEY, http: h.http }).complete(COMPANY, BASE_REQUEST);
  assert.equal(result.text, "Let me check. ");
  assert.equal(result.finishReason, "tool_call");
  assert.deepEqual(result.toolCalls, [{ id: "toolu_2", name: "lookup", arguments: { q: "x" } }]);
  assert.deepEqual(result.usage, { inputTokens: 8, outputTokens: 4 });
  assert.equal(result.providerRequestId, "req_anth");
});

test("Anthropic has no embeddings: embed fails without a request", async () => {
  const h = scripted({});
  const err = await rejects(new AnthropicModelProvider({ apiKey: ANTHROPIC_KEY, http: h.http }).embed(COMPANY, {
    model: "x",
    inputs: ["a"],
    timeoutMs: 1000,
  }));
  assert.equal(err.providerError.code, "bad_request");
  assert.equal(h.calls.length, 0);
});

// ---------- Gemini mapping ----------

test("Gemini request: systemInstruction, role mapping, tool declarations, generation config", async () => {
  const h = scripted({ gemini: [reply(200, geminiOk())] });
  const provider = new GeminiModelProvider({ apiKey: GEMINI_KEY, http: h.http });
  await provider.complete(COMPANY, {
    model: "gemini-test-flash",
    timeoutMs: 4000,
    purpose: "reply",
    messages: [
      { role: "system", content: "SYS" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "tool", content: "res", toolCallId: "lookup-0" },
    ],
    tools: [{ name: "lookup", description: "find", parameters: { type: "object" } }],
    temperature: 0.1,
    maxOutputTokens: 50,
    responseFormat: "json",
  });
  const body = JSON.parse(h.calls[0].body);
  assert.match(body.systemInstruction.parts[0].text, /^SYS\n\nRespond with a single valid JSON object/);
  assert.deepEqual(body.contents.map((c) => c.role), ["user", "model", "user"]);
  assert.equal(body.contents[2].parts[0].text, "Tool result (lookup-0): res");
  assert.equal(body.tools[0].functionDeclarations[0].name, "lookup");
  assert.deepEqual(body.generationConfig, { temperature: 0.1, maxOutputTokens: 50, responseMimeType: "application/json" });
});

test("Gemini response: function calls parsed, STOP with a call is a tool call, usage read", async () => {
  const h = scripted({
    gemini: [
      reply(200, {
        candidates: [{ content: { parts: [{ functionCall: { name: "lookup", args: { q: "a" } } }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      }),
    ],
  });
  const result = await new GeminiModelProvider({ apiKey: GEMINI_KEY, http: h.http }).complete(COMPANY, { ...BASE_REQUEST, model: "gemini-test-flash" });
  assert.equal(result.finishReason, "tool_call");
  assert.equal(result.toolCalls[0].name, "lookup");
  assert.deepEqual(result.toolCalls[0].arguments, { q: "a" });
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 2 });
});

test("Gemini: a blocked prompt with no candidates is a content_filter result", async () => {
  const h = scripted({ gemini: [reply(200, { promptFeedback: { blockReason: "SAFETY" } })] });
  const result = await new GeminiModelProvider({ apiKey: GEMINI_KEY, http: h.http }).complete(COMPANY, { ...BASE_REQUEST, model: "gemini-test-flash" });
  assert.equal(result.finishReason, "content_filter");
  assert.equal(result.text, "");
});

test("Gemini embed: one batch call, vectors in input order", async () => {
  const h = scripted({ gemini: [reply(200, { embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] })] });
  const result = await new GeminiModelProvider({ apiKey: GEMINI_KEY, http: h.http }).embed(COMPANY, {
    model: "text-embedding-test",
    inputs: ["a", "b"],
    timeoutMs: 2000,
  });
  assert.equal(h.calls.length, 1);
  assert.match(h.calls[0].url, /:batchEmbedContents$/);
  assert.ok(!h.calls[0].url.includes(GEMINI_KEY));
  assert.deepEqual(result.vectors, [[0.1, 0.2], [0.3, 0.4]]);
  assert.equal(result.dimensions, 2);
});

// ---------- streams ----------

test("stream yields text, usage and done events from one completion", async () => {
  const h = scripted({ openai: [reply(200, openaiOk("Streamed text"))] });
  const provider = new OpenAIModelProvider({ apiKey: OPENAI_KEY, http: h.http });
  const events = [];
  for await (const event of provider.stream(COMPANY, BASE_REQUEST)) events.push(event);
  assert.deepEqual(events.map((e) => e.type), ["text-delta", "usage", "done"]);
  assert.equal(events[0].text, "Streamed text");
  assert.equal(events[2].finishReason, "stop");
});

test("stream turns a provider error into an error event instead of a throw", async () => {
  const h = scripted({ openai: [reply(400, { error: { message: "bad" } })] });
  const provider = new OpenAIModelProvider({ apiKey: OPENAI_KEY, http: h.http });
  const events = [];
  for await (const event of provider.stream(COMPANY, BASE_REQUEST)) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
  assert.equal(events[0].error.status, 400);
});

test("streamWithFailover fails over before the first event, as the policy requires", async () => {
  const h = scripted({ openai: [reply(503, {}), reply(503, {})], anthropic: [reply(200, anthropicOk("From Claude"))] });
  const registry = createProviderRegistry({ env: KEYS_ENV, http: h.http, policy: DEFAULT_FAILOVER_POLICY });
  const events = [];
  for await (const event of streamWithFailover(registry, createFailoverPolicy(KEYS_ENV), COMPANY, BASE_REQUEST, {
    sleep: noSleep().sleep,
    now: h.clock.now,
  })) {
    events.push(event);
  }
  assert.equal(events[0].type, "text-delta");
  assert.equal(events[0].text, "From Claude");
  assert.equal(createFailoverPolicy(KEYS_ENV).failoverAfterFirstDelta, false);
});
