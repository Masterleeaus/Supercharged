// Signature guard for the Plivo-ElevenLabs SIP trunk webhooks (issue #126).
// Covers the four HTTP routes: /voice/answer, /voice/:callId, /voice/status, /incoming.
// Fakes only: a resolve hook swaps the db, schema, drizzle and service modules for in-memory stubs.
// No server, database or network is started.
// Run: node --test --experimental-transform-types tests/security/plivo-elevenlabs-signature.test.mjs

// Test files must not write to stdout (it breaks the runner's IPC).
for (const method of ['log', 'info', 'warn', 'error', 'debug']) console[method] = () => {};

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { createHmac } from 'node:crypto';

const HOOK = `
const DATA = (src) => 'data:text/javascript,' + encodeURIComponent(src);
const TABLES = ['agents', 'plivoPhoneNumbers', 'sipPhoneNumbers', 'users', 'flowExecutions', 'plivoCalls', 'plivoCredentials', 'sipTrunks'];
const SCHEMA = TABLES.map((t) => 'export const ' + t + ' = { __t: "' + t + '" };').join('\\n');
const STUBS = {
  schema: SCHEMA,
  drizzle: 'export const eq = (a, b) => ({ op: "eq", a, b }); export const and = (...c) => ({ op: "and", c }); export function sql(strings, ...vals) { return { op: "sql", strings, vals }; }',
  config: 'export function getSipStreamUrl(u) { return "wss://stream.test/" + u; } export function getSipWebhookUrl(p) { return "https://app.test/api/plivo-elevenlabs" + p; }',
  bridge: 'export const ElevenLabsBridgeService = { createSession: async () => {}, endSession: async (id) => { globalThis.__sbx.ended.push(id); return { duration: 0, transcript: [] }; } };',
  credit: 'export async function deductCallCredits(args) { globalThis.__sbx.credits.push(args); return { success: true, creditsDeducted: 1, newBalance: 0, alreadyDeducted: false }; }',
  logger: 'export const logger = { info() {}, warn() {}, error() {}, debug() {} };',
  pool: 'export const ElevenLabsPoolService = { getCredentialForAgent: async () => null };',
  db: [
    'const rowsFor = (name) => { const s = globalThis.__sbx; return ({ plivoCredentials: s.accounts, sipTrunks: s.trunks, plivoCalls: s.calls })[name] || []; };',
    'function builder(name, op) {',
    '  const self = new Proxy({}, {',
    '    get(_, k) {',
    '      if (k === "then") return (ok, err) => Promise.resolve(op === "select" ? [...rowsFor(name)] : []).then(ok, err);',
    '      if (k === "from") return (t) => { name = t.__t; return self; };',
    '      return () => self;',
    '    },',
    '  });',
    '  return self;',
    '}',
    'export const db = {',
    '  select: () => builder(null, "select"),',
    '  update: (t) => { globalThis.__sbx.writes.push("update:" + t.__t); return builder(t.__t, "update"); },',
    '  insert: (t) => { globalThis.__sbx.writes.push("insert:" + t.__t); return builder(t.__t, "insert"); },',
    '};',
  ].join('\\n'),
};

export async function resolve(specifier, context, nextResolve) {
  const data = (src) => ({ url: DATA(src), shortCircuit: true });
  if (specifier === '@shared/schema') return data(STUBS.schema);
  if (specifier === 'drizzle-orm') return data(STUBS.drizzle);
  if (specifier.endsWith('/config/config')) return data(STUBS.config);
  if (specifier.endsWith('elevenlabs-bridge.service')) return data(STUBS.bridge);
  if (specifier.endsWith('credit-service')) return data(STUBS.credit);
  if (specifier.endsWith('utils/logger')) return data(STUBS.logger);
  if (specifier.endsWith('elevenlabs-pool')) return data(STUBS.pool);
  if (specifier === 'db' || specifier.endsWith('/db')) return data(STUBS.db);
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    // The app bundles extensionless relative imports; plain Node ESM needs the .ts file name.
    if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(specifier + '.ts', context);
    throw err;
  }
}
`;
register('data:text/javascript,' + encodeURIComponent(HOOK), import.meta.url);

const { requirePlivoV2Signature } = await import(
  new URL('../../server/engines/plivo/plivo-signature.ts', import.meta.url).href
);
const { loadPlivoElevenLabsAuthTokens } = await import(
  new URL('../../server/engines/plivo-elevenlabs/webhook-auth-tokens.ts', import.meta.url).href
);
const { setupPlivoElevenLabsWebhooks } = await import(
  new URL('../../server/engines/plivo-elevenlabs/routes/webhooks.ts', import.meta.url).href
);

const BASE = 'https://app.example.test';
const ACCOUNT_TOKEN = 'fake_account_auth_token';
const TRUNK_TOKEN = 'fake_trunk_auth_token';
const NONCE = 'nonce-0001';
const ANSWER = '/api/plivo-elevenlabs/voice/answer';
const CALL_ID = '/api/plivo-elevenlabs/voice/:callId';
const STATUS = '/api/plivo-elevenlabs/voice/status';
const INCOMING = '/api/plivo-elevenlabs/incoming';

const ANSWER_BODY = { CallUUID: 'call-1', From: '+61400000001', To: '+61400000002', Direction: 'inbound' };
const STATUS_BODY = { CallUUID: 'call-1', CallStatus: 'completed', Duration: '60', HangupCause: 'NORMAL_CLEARING' };

// Independent signer used only to build test signatures (does not call the code under test).
function sign(url, nonce, body, token) {
  let base = url + nonce;
  for (const key of Object.keys(body).sort()) base += key + String(body[key]);
  return createHmac('sha256', token).update(base, 'utf8').digest('base64');
}

function fakeRes() {
  return {
    code: 200, sent: false, body: null, headers: {},
    status(c) { this.code = c; return this; },
    set(k, v) { this.headers[k] = v; return this; },
    send(b) { this.sent = true; this.body = b; return this; },
    sendStatus(c) { this.code = c; this.sent = true; this.body = String(c); return this; },
  };
}

function signedReq(path, body, { token = ACCOUNT_TOKEN, nonce = NONCE, params = {} } = {}) {
  return {
    headers: {
      'x-plivo-signature-v2': sign(BASE + path, nonce, body, token),
      'x-plivo-signature-v2-nonce': nonce,
    },
    body,
    originalUrl: path,
    params,
  };
}

// Plivo's own callbacks put the signature on the request. A missing one is the unsigned case.
const unsignedReq = (path, body, params = {}) => ({ headers: {}, body, originalUrl: path, params });

// Set up the real router with a capturing app, then run each route's handler chain the way Express would.
const routes = new Map();
setupPlivoElevenLabsWebhooks({ post: (path, ...handlers) => routes.set(path, handlers) }, BASE);

// Runs middleware in order, then the handler. Stops at the first middleware that does not call next.
async function run(routeKey, req) {
  const handlers = routes.get(routeKey);
  assert.ok(handlers, `route not registered: ${routeKey}`);
  const res = fakeRes();
  for (const mw of handlers.slice(0, -1)) {
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    if (!nextCalled) return { res, reachedHandler: false };
  }
  await handlers[handlers.length - 1](req, res);
  return { res, reachedHandler: true };
}

beforeEach(() => {
  globalThis.__sbx = {
    accounts: [{ authToken: ACCOUNT_TOKEN, isPrimary: true }],
    trunks: [],
    calls: [],
    writes: [],
    credits: [],
    ended: [],
  };
});

afterEach(() => {
  delete globalThis.__sbx;
});

// ---- Verifier -----------------------------------------------------------------

test('valid V2 signature passes the guard', async () => {
  const mw = requirePlivoV2Signature(BASE, loadPlivoElevenLabsAuthTokens);
  const res = fakeRes();
  let nextCalled = false;
  await mw(signedReq(ANSWER, ANSWER_BODY), res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.sent, false);
});

test('missing signature header is rejected with 403', async () => {
  const mw = requirePlivoV2Signature(BASE, loadPlivoElevenLabsAuthTokens);
  const res = fakeRes();
  let nextCalled = false;
  await mw(unsignedReq(ANSWER, ANSWER_BODY), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.code, 403);
});

test('invalid signature (wrong token) is rejected with 403', async () => {
  const mw = requirePlivoV2Signature(BASE, loadPlivoElevenLabsAuthTokens);
  const res = fakeRes();
  let nextCalled = false;
  await mw(signedReq(ANSWER, ANSWER_BODY, { token: 'not_a_real_token' }), res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.code, 403);
});

test('signature over a different body is rejected with 403', async () => {
  const mw = requirePlivoV2Signature(BASE, loadPlivoElevenLabsAuthTokens);
  const req = signedReq(ANSWER, ANSWER_BODY);
  req.body = { ...ANSWER_BODY, From: '+61400000999' };
  const res = fakeRes();
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.code, 403);
});

test('a signature made with a SIP trunk token passes', async () => {
  globalThis.__sbx.accounts = [];
  globalThis.__sbx.trunks = [{ password: TRUNK_TOKEN }];
  const { res, reachedHandler } = await run(ANSWER, signedReq(ANSWER, ANSWER_BODY, { token: TRUNK_TOKEN }));
  assert.equal(reachedHandler, true);
  assert.match(String(res.body), /<Stream/);
});

test('no configured tokens at all fails closed with 403', async () => {
  globalThis.__sbx.accounts = [];
  globalThis.__sbx.trunks = [];
  const { res, reachedHandler } = await run(ANSWER, signedReq(ANSWER, ANSWER_BODY));
  assert.equal(reachedHandler, false);
  assert.equal(res.code, 403);
});

// ---- Routes -------------------------------------------------------------------

test('answer: valid signature reaches the handler and gets the stream XML', async () => {
  const { res, reachedHandler } = await run(ANSWER, signedReq(ANSWER, ANSWER_BODY));
  assert.equal(reachedHandler, true);
  assert.match(String(res.body), /<Stream bidirectional="true"/);
});

test('answer: missing signature gets 403 and no XML', async () => {
  const { res, reachedHandler } = await run(ANSWER, unsignedReq(ANSWER, ANSWER_BODY));
  assert.equal(reachedHandler, false);
  assert.equal(res.code, 403);
  assert.equal(res.body, 'Forbidden');
});

test('answer-with-callId: invalid signature gets 403 and writes nothing', async () => {
  const path = '/api/plivo-elevenlabs/voice/call-123';
  const req = signedReq(path, ANSWER_BODY, { token: 'bad', params: { callId: 'call-123' } });
  const { res, reachedHandler } = await run(CALL_ID, req);
  assert.equal(reachedHandler, false);
  assert.equal(res.code, 403);
  assert.deepEqual(globalThis.__sbx.writes, []);
});

test('incoming: invalid signature gets 403 before any lookup or call record', async () => {
  const { res, reachedHandler } = await run(INCOMING, signedReq(INCOMING, ANSWER_BODY, { token: 'bad' }));
  assert.equal(reachedHandler, false);
  assert.equal(res.code, 403);
  assert.deepEqual(globalThis.__sbx.writes, []);
});

test('status: rejected request does not end the session or deduct credits', async () => {
  // A row that would be billed if the handler ran: this is the control for the assertion below.
  globalThis.__sbx.calls = [{
    id: 'row-1', userId: 'user-1', agentId: null, fromNumber: '+1', toNumber: '+2',
    duration: 0, callDirection: 'outbound', metadata: { engine: 'plivo-elevenlabs' },
  }];
  const unsigned = await run(STATUS, unsignedReq(STATUS, STATUS_BODY));
  const badSig = await run(STATUS, signedReq(STATUS, STATUS_BODY, { token: 'bad' }));
  for (const { res, reachedHandler } of [unsigned, badSig]) {
    assert.equal(reachedHandler, false);
    assert.equal(res.code, 403);
  }
  assert.deepEqual(globalThis.__sbx.credits, [], 'no credits deducted on a rejected request');
  assert.deepEqual(globalThis.__sbx.ended, [], 'session not ended on a rejected request');
  assert.deepEqual(globalThis.__sbx.writes, [], 'no database writes on a rejected request');
});

test('status: valid signed completed callback does deduct credits (control)', async () => {
  globalThis.__sbx.calls = [{
    id: 'row-1', userId: 'user-1', agentId: null, fromNumber: '+1', toNumber: '+2',
    duration: 0, callDirection: 'outbound', metadata: { engine: 'plivo-elevenlabs' },
  }];
  const { res, reachedHandler } = await run(STATUS, signedReq(STATUS, STATUS_BODY));
  assert.equal(reachedHandler, true);
  assert.equal(res.code, 200);
  assert.equal(globalThis.__sbx.credits.length, 1);
  assert.equal(globalThis.__sbx.credits[0].creditsToDeduct, 1);
});
