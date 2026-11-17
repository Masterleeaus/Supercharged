import test from 'node:test';
import assert from 'node:assert/strict';
import { createCentralSsoHandlers, CALLBACK_PATH, START_PATH } from '../../server/infrastructure/central-sso/http-handlers.ts';
import { createCentralSignIn } from '../../server/infrastructure/central-sso/sign-in.ts';
import { TXN_COOKIE } from '../../server/infrastructure/central-sso/oidc-flow.ts';

// Unauthenticated requests to the two Central sign-in routes (see tests/security/route-auth-allowlist.json).
// Start is public by design; the callback's guard is the state binding in the transaction cookie.

function fakeRes() {
  const res = { statusCode: undefined, body: undefined, headers: {}, location: undefined };
  res.status = function (code) { this.statusCode = code; return this; };
  res.json = function (body) { this.body = body; return this; };
  res.setHeader = function (name, value) { this.headers[name] = value; return this; };
  res.redirect = function (code, url) { this.statusCode = code; this.location = url; return this; };
  return res;
}

function build() {
  const calls = { establish: 0, complete: 0 };
  const signIn = createCentralSignIn({
    // Without a matching transaction cookie the flow cannot verify state, so it always refuses here.
    complete: async () => {
      calls.complete++;
      return { ok: false, reason: 'state_mismatch' };
    },
    resolve: async () => null,
    issueNativeToken: async () => 'token',
  });
  const h = createCentralSsoHandlers({
    flow: { start: async () => ({ ok: true, state: 'S'.repeat(32), redirectUrl: 'https://central.example/authorize' }) },
    signIn,
    establishSession: async () => { calls.establish++; return true; },
  });
  return { h, calls };
}

test('unauthenticated start is allowed and issues a state-bound transaction cookie', async () => {
  assert.equal(START_PATH, '/api/auth/central/start');
  const { h } = build();
  const res = fakeRes();
  await h.start({ query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 302);
  assert.match(res.headers['Set-Cookie'], new RegExp(`^${TXN_COOKIE}=`));
});

test('unauthenticated callback with no transaction cookie is refused and creates no session', async () => {
  assert.equal(CALLBACK_PATH, '/api/auth/central/callback');
  const { h, calls } = build();
  const res = fakeRes();
  await h.callback({ query: { code: 'c', state: 'attacker' }, cookies: {}, headers: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'central_sign_in_failed' });
  assert.equal(res.location, undefined);
  assert.equal(calls.complete, 1);
  assert.equal(calls.establish, 0);
});

test('unauthenticated callback with no query and no cookie is refused and creates no session', async () => {
  const { h, calls } = build();
  const res = fakeRes();
  await h.callback({ query: {}, cookies: {}, headers: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(calls.establish, 0);
});
