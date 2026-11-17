import test from 'node:test';
import assert from 'node:assert/strict';
import { createCentralSsoHandlers, CALLBACK_PATH, START_PATH } from '../../server/infrastructure/central-sso/http-handlers.ts';
import { TXN_COOKIE } from '../../server/infrastructure/central-sso/oidc-flow.ts';

function fakeRes() {
  const res = { status: 200, body: undefined, headers: {}, location: undefined, statusCalls: [] };
  res.status = function (code) { this.statusCode = code; this.statusCalls.push(code); return this; };
  res.json = function (body) { this.body = body; return this; };
  res.setHeader = function (name, value) { this.headers[name] = value; return this; };
  res.redirect = function (code, url) { this.statusCode = code; this.location = url; return this; };
  return res;
}

const ACCOUNT = { userId: 'local-1', companyId: '11111111-1111-4111-8111-111111111111', role: 'admin', revision: 1 };

function handlers(overrides = {}) {
  const calls = { establish: 0 };
  const h = createCentralSsoHandlers({
    flow: overrides.flow ?? { start: async () => ({ ok: true, state: 'S'.repeat(32), redirectUrl: 'https://central.example/authorize?x=1' }) },
    signIn: overrides.signIn ?? (async () => ({ ok: true, token: 't'.repeat(64), account: ACCOUNT })),
    establishSession: overrides.establishSession ?? (async () => { calls.establish++; return true; }),
  });
  return { h, calls };
}

test('paths are the fixed Supercharged Central routes', () => {
  assert.equal(START_PATH, '/api/auth/central/start');
  assert.equal(CALLBACK_PATH, '/api/auth/central/callback');
});

test('start sets a host-only transaction cookie and redirects to Central', async () => {
  const { h } = handlers();
  const res = fakeRes();
  await h.start({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 302);
  assert.equal(res.location, 'https://central.example/authorize?x=1');
  const cookie = res.headers['Set-Cookie'];
  assert.match(cookie, new RegExp(`^${TXN_COOKIE}=S+; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$`));
  assert.doesNotMatch(cookie, /Domain=/);
});

test('start fails with a fixed code and no redirect when the flow refuses', async () => {
  const { h } = handlers({ flow: { start: async () => ({ ok: false, reason: 'metadata' }) } });
  const res = fakeRes();
  await h.start({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'central_sign_in_unavailable' });
  assert.equal(res.location, undefined);
  assert.equal(res.headers['Set-Cookie'], undefined);
});

test('callback clears the transaction cookie and creates a session on success', async () => {
  const { h, calls } = handlers();
  const res = fakeRes();
  await h.callback({ query: { code: 'c', state: 'S' }, cookies: { [TXN_COOKIE]: 'S' }, headers: {} }, res);
  assert.match(res.headers['Set-Cookie'], new RegExp(`^${TXN_COOKIE}=; Path=/; Max-Age=0`));
  assert.equal(calls.establish, 1);
  assert.equal(res.statusCode, 302);
  assert.equal(res.location, '/');
});

test('callback passes the browser cookie through as the state binding only', async () => {
  let seen;
  const { h } = handlers({ signIn: async (input) => { seen = input; return { ok: false, reason: 'state_mismatch' }; } });
  await h.callback({ query: { code: 'c', state: 'from-query' }, cookies: { [TXN_COOKIE]: 'from-cookie' }, headers: {} }, fakeRes());
  assert.equal(seen.cookieState, 'from-cookie');
  assert.equal(seen.query.state, 'from-query');
});

test('every failed callback returns the same fixed code and creates no session', async () => {
  for (const reason of ['state_mismatch', 'no_local_account', 'id_token', 'company_claim']) {
    const { h, calls } = handlers({ signIn: async () => ({ ok: false, reason }) });
    const res = fakeRes();
    await h.callback({ query: {}, cookies: {}, headers: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.body, { error: 'central_sign_in_failed' });
    assert.equal(res.location, undefined);
    assert.equal(calls.establish, 0);
  }
});

test('a refused local session (inactive or company mismatch) fails closed', async () => {
  const { h } = handlers({ establishSession: async () => false });
  const res = fakeRes();
  await h.callback({ query: {}, cookies: {}, headers: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.location, undefined);
});

test('a thrown error returns a generic 500 without echoing the message', async () => {
  const { h } = handlers({ signIn: async () => { throw new Error('secret-token-value'); } });
  const res = fakeRes();
  await h.callback({ query: {}, cookies: {}, headers: {} }, res);
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'central_sign_in_failed' });
  assert.doesNotMatch(JSON.stringify(res.body), /secret-token-value/);
});
