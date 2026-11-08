/**
 * Workforce runtime adapter tests. Uses a fake fetch only. No network, no database.
 * The adapter is TypeScript (.ts). Node 22.18+ strips types natively, so the test imports it
 * directly. The pure logic lives in server/integrations/workforce-runtime/wire.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkforceRuntime } from '../../server/integrations/workforce-runtime/index.ts';
import { DisabledWorkforceRuntime } from '../../server/integrations/workforce-runtime/disabled-runtime.ts';
import { HttpWorkforceRuntime } from '../../server/integrations/workforce-runtime/http-runtime.ts';
import {
  resolveRuntimeConfig, parseRuntimeUrl, signWorkforceRequest, verifyWorkforceRequest,
  TIMESTAMP_HEADER, SIGNATURE_HEADER, ENDPOINTS,
} from '../../server/integrations/workforce-runtime/wire.mjs';

const SECRET = 'TEST-WORKFORCE-SECRET-NOT-REAL-0123456789-ABCDEF';
const ORIGIN = 'https://runtime.example';
const TASK_ID = 'task_123';
const NOW = Date.parse('2026-11-02T00:00:00Z');

const SUBMIT = {
  idempotency_key: 'idem-0001',
  company_id: 'co_1',
  workflow: 'lead_followup',
  requested_by: 'user_7',
  resource: { kind: 'booking_request', reference: 'br_42' },
  payload: { note: 'follow up' },
};

function taskRecord(overrides = {}) {
  return { id: TASK_ID, status: 'pending', workflow: 'lead_followup', company_id: 'co_1', ...overrides };
}

/** Fake fetch that records every call and answers with the given handler. */
function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return handler({ url, init, calls });
  };
  return { fetchImpl, calls };
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function runtimeWith(handler, options = {}) {
  const fake = fakeFetch(handler);
  const runtime = new HttpWorkforceRuntime({
    baseUrl: options.baseUrl ?? ORIGIN,
    secret: SECRET,
    timeoutMs: 1000,
    fetchImpl: fake.fetchImpl,
  });
  return { runtime, calls: fake.calls };
}

async function assertCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}`);
    return true;
  });
}

// ---- Disabled runtime: fail-closed default ----

test('disabled runtime refuses every method with runtime_not_configured', async () => {
  const runtime = createWorkforceRuntime({});
  assert.equal(runtime.kind, 'disabled');
  assert.ok(runtime instanceof DisabledWorkforceRuntime);
  await assertCode(runtime.submitTask(SUBMIT), 'runtime_not_configured');
  await assertCode(runtime.getTask(TASK_ID), 'runtime_not_configured');
  await assertCode(runtime.cancelTask(TASK_ID), 'runtime_not_configured');
  await assertCode(runtime.health(), 'runtime_not_configured');
});

test('disabled runtime needs no network: calls are refused before any I/O', async () => {
  const runtime = new DisabledWorkforceRuntime('runtime_url_missing');
  assert.equal(runtime.reason, 'runtime_url_missing');
  await assertCode(runtime.health(), 'runtime_not_configured');
});

// ---- Config: invalid values fall back to disabled ----

test('invalid config falls back to disabled and never exposes the secret', () => {
  const cases = [
    [{}, 'runtime_url_missing'],
    [{ TITAN_WORKFORCE_URL: ORIGIN }, 'runtime_secret_missing'],
    [{ TITAN_WORKFORCE_SECRET: SECRET }, 'runtime_url_missing'],
    [{ TITAN_WORKFORCE_URL: ORIGIN, TITAN_WORKFORCE_SECRET: 'short-secret' }, 'runtime_secret_invalid'],
    [{ TITAN_WORKFORCE_URL: ORIGIN, TITAN_WORKFORCE_SECRET: ` ${SECRET}` }, 'runtime_secret_invalid'],
    [{ TITAN_WORKFORCE_URL: 'http://example.com', TITAN_WORKFORCE_SECRET: SECRET }, 'runtime_url_insecure'],
    [{ TITAN_WORKFORCE_URL: 'not a url', TITAN_WORKFORCE_SECRET: SECRET }, 'runtime_url_invalid'],
  ];
  for (const [env, reason] of cases) {
    const runtime = createWorkforceRuntime(env);
    assert.equal(runtime.kind, 'disabled', `should be disabled for ${reason}`);
    assert.equal(runtime.reason, reason);
    assert.ok(!JSON.stringify(runtime).includes(SECRET), 'secret must not appear in the fallback');
  }
});

test('valid config builds the HTTP client, including loopback http', () => {
  const remote = createWorkforceRuntime({ TITAN_WORKFORCE_URL: ORIGIN, TITAN_WORKFORCE_SECRET: SECRET });
  assert.equal(remote.kind, 'http');
  assert.ok(remote instanceof HttpWorkforceRuntime);
  for (const url of ['http://127.0.0.1:4010', 'http://localhost:4010']) {
    const local = createWorkforceRuntime({ TITAN_WORKFORCE_URL: url, TITAN_WORKFORCE_SECRET: SECRET });
    assert.equal(local.kind, 'http', `loopback ${url} should be allowed`);
  }
});

test('a 32-byte secret is accepted and 31 bytes is refused', () => {
  const ok = resolveRuntimeConfig({ TITAN_WORKFORCE_URL: ORIGIN, TITAN_WORKFORCE_SECRET: 'a'.repeat(32) });
  assert.equal(ok.ok, true);
  const bad = resolveRuntimeConfig({ TITAN_WORKFORCE_URL: ORIGIN, TITAN_WORKFORCE_SECRET: 'a'.repeat(31) });
  assert.deepEqual(bad, { ok: false, reason: 'runtime_secret_invalid' });
});

// ---- URL rules ----

test('non-HTTPS remote URL is refused, both by config and by the client constructor', () => {
  assert.throws(() => parseRuntimeUrl('http://runtime.example'), (e) => e.code === 'runtime_url_insecure');
  assert.throws(() => parseRuntimeUrl('http://10.0.0.5:4010'), (e) => e.code === 'runtime_url_insecure');
  assert.throws(
    () => new HttpWorkforceRuntime({ baseUrl: 'http://runtime.example', secret: SECRET, fetchImpl: fakeFetch(() => json(200, {})).fetchImpl }),
    (e) => e.code === 'runtime_url_insecure',
  );
});

test('URLs with credentials, paths or queries are refused', () => {
  for (const url of ['https://user:pw@runtime.example', 'https://runtime.example/api', 'https://runtime.example/?x=1']) {
    assert.throws(() => parseRuntimeUrl(url), (e) => e.code === 'runtime_url_invalid' || e.code === 'runtime_url_not_origin', url);
  }
});

test('https origin is accepted and normalised to its origin', () => {
  assert.equal(parseRuntimeUrl('https://runtime.example/'), 'https://runtime.example');
});

// ---- Client behaviour ----

test('redirects are not followed: fetch is asked for manual handling and a 3xx is refused', async () => {
  const { runtime, calls } = runtimeWith(() =>
    new Response(null, { status: 302, headers: { location: 'https://attacker.example/steal' } }));
  await assertCode(runtime.getTask(TASK_ID), 'runtime_redirect_refused');
  assert.equal(calls.length, 1, 'exactly one request, no follow-up');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.notEqual(calls[0].init.redirect, 'follow');
});

test('the secret never appears in thrown errors, messages, or stacks', async () => {
  const scenarios = [
    () => { throw new Error(`socket failed for ${SECRET}`); },
    () => json(500, { leaked: SECRET }),
    () => new Response(`not json ${SECRET}`, { status: 200 }),
    () => { const e = new Error(`timed out ${SECRET}`); e.name = 'TimeoutError'; throw e; },
    () => new Response(null, { status: 302, headers: { location: `https://x.example/?s=${SECRET}` } }),
  ];
  for (const scenario of scenarios) {
    const { runtime } = runtimeWith(() => scenario());
    let caught;
    try { await runtime.health(); } catch (error) { caught = error; }
    assert.ok(caught, 'a scenario should throw');
    assert.ok(!String(caught.message).includes(SECRET), 'message');
    assert.ok(!String(caught.stack ?? '').includes(SECRET), 'stack');
    assert.ok(!JSON.stringify(caught).includes(SECRET), 'serialised');
    assert.ok(!String(caught.code).includes(SECRET), 'code');
  }
});

test('the signature header is present and verifies against the exact body sent', async () => {
  const { runtime, calls } = runtimeWith(() => json(202, taskRecord()));
  await runtime.submitTask(SUBMIT);
  const { init } = calls[0];
  const timestamp = init.headers[TIMESTAMP_HEADER];
  const signature = init.headers[SIGNATURE_HEADER];
  assert.match(timestamp, /^\d{10}$/);
  assert.match(signature, /^sha256=[a-f0-9]{64}$/);
  assert.equal(verifyWorkforceRequest({
    secret: SECRET, method: 'POST', path: ENDPOINTS.submitTask.path, timestamp,
    body: init.body, signature, now: Number(timestamp) * 1000,
  }), true);
  // A changed body or path must fail verification.
  assert.throws(() => verifyWorkforceRequest({
    secret: SECRET, method: 'POST', path: ENDPOINTS.submitTask.path, timestamp,
    body: init.body.replace('follow up', 'changed'), signature, now: Number(timestamp) * 1000,
  }), (e) => e.code === 'runtime_signature_rejected');
  assert.throws(() => verifyWorkforceRequest({
    secret: SECRET, method: 'POST', path: '/v1/tasks/x/cancel', timestamp,
    body: init.body, signature, now: Number(timestamp) * 1000,
  }), (e) => e.code === 'runtime_signature_rejected');
});

test('a signature from a different secret or outside the skew window is rejected', () => {
  const timestamp = String(Math.floor(NOW / 1000));
  const signature = signWorkforceRequest({ secret: SECRET, method: 'GET', path: '/v1/health', timestamp });
  assert.throws(() => verifyWorkforceRequest({
    secret: 'OTHER-SECRET-THAT-IS-ALSO-LONG-ENOUGH-0000000', method: 'GET', path: '/v1/health',
    timestamp, signature, now: NOW,
  }), (e) => e.code === 'runtime_signature_rejected');
  assert.throws(() => verifyWorkforceRequest({
    secret: SECRET, method: 'GET', path: '/v1/health', timestamp, signature, now: NOW + 600_000,
  }), (e) => e.code === 'runtime_signature_rejected');
});

test('endpoints follow the ASSUMED paths and methods', async () => {
  const { runtime, calls } = runtimeWith(({ url }) => {
    if (url.endsWith('/v1/health')) return json(200, { ok: true });
    if (url.endsWith('/cancel')) return json(200, taskRecord({ status: 'cancelled' }));
    return json(200, taskRecord());
  });
  await runtime.submitTask(SUBMIT);
  await runtime.getTask(TASK_ID);
  await runtime.cancelTask(TASK_ID);
  await runtime.health();
  assert.deepEqual(calls.map((c) => [c.init.method, c.url]), [
    ['POST', `${ORIGIN}/v1/tasks`],
    ['GET', `${ORIGIN}/v1/tasks/${TASK_ID}`],
    ['POST', `${ORIGIN}/v1/tasks/${TASK_ID}/cancel`],
    ['GET', `${ORIGIN}/v1/health`],
  ]);
});

test('task ids are validated before any request is sent', async () => {
  const { runtime, calls } = runtimeWith(() => json(200, taskRecord()));
  await assertCode(runtime.getTask('../admin'), 'runtime_invalid_input');
  await assertCode(runtime.cancelTask('a/b'), 'runtime_invalid_input');
  assert.equal(calls.length, 0);
});

test('a response with an unknown status or a different id is refused as bad_response', async () => {
  const unknownStatus = runtimeWith(() => json(200, taskRecord({ status: 'paused' })));
  await assertCode(unknownStatus.runtime.getTask(TASK_ID), 'runtime_bad_response');
  const wrongId = runtimeWith(() => json(200, taskRecord({ id: 'other_9' })));
  await assertCode(wrongId.runtime.getTask(TASK_ID), 'runtime_bad_response');
});

test('awaiting_approval is accepted and carries an approval reference, with no approve method', async () => {
  const { runtime } = runtimeWith(() => json(200, taskRecord({ status: 'awaiting_approval', approval_reference: 'appr_9' })));
  const task = await runtime.getTask(TASK_ID);
  assert.equal(task.status, 'awaiting_approval');
  assert.equal(task.approval_reference, 'appr_9');
  assert.equal(typeof runtime.approveTask, 'undefined');
});

test('HTTP errors are reported by code and status, with retryable set for 5xx', async () => {
  const { runtime } = runtimeWith(() => json(503, { error: 'busy' }));
  await assert.rejects(runtime.health(), (e) => e.code === 'runtime_http_error' && e.status === 503 && e.retryable === true);
});

test('timeouts map to runtime_timeout', async () => {
  // AbortSignal.timeout is unref'd, so hold the event loop open with a ref'd timer while waiting.
  const keepAlive = setTimeout(() => {}, 2000);
  try {
    const fetchImpl = (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'TimeoutError';
        reject(e);
      });
    });
    const runtime = new HttpWorkforceRuntime({ baseUrl: ORIGIN, secret: SECRET, timeoutMs: 100, fetchImpl });
    await assertCode(runtime.health(), 'runtime_timeout');
  } finally {
    clearTimeout(keepAlive);
  }
});

test('submit payload is validated: unknown keys and oversized payloads are refused before fetch', async () => {
  const { runtime, calls } = runtimeWith(() => json(202, taskRecord()));
  await assertCode(runtime.submitTask({ ...SUBMIT, extra: true }), 'runtime_invalid_input');
  await assertCode(runtime.submitTask({ ...SUBMIT, payload: { blob: 'x'.repeat(70000) } }), 'runtime_invalid_input');
  assert.equal(calls.length, 0);
});

test('constructing the client does not touch the network', () => {
  const { fetchImpl, calls } = fakeFetch(() => json(200, {}));
  new HttpWorkforceRuntime({ baseUrl: ORIGIN, secret: SECRET, fetchImpl });
  assert.equal(calls.length, 0);
});
