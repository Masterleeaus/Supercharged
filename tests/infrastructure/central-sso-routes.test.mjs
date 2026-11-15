// Central SSO start and callback routes with a stub flow and stub sign-in. No network, no database.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createCentralSsoRouter, CENTRAL_START_PATH, CENTRAL_CALLBACK_PATH } from '../../server/routes/core/central-sso-routes.ts';

const STATE = 'state-' + 'a'.repeat(40);
const REDIRECT = 'https://central.example/authorize?state=' + STATE;
const TOKEN = 'native-token-' + 'b'.repeat(40);

function makeStubs(script = {}) {
  const calls = { start: 0, signIn: [] };
  const flow = {
    start: async () => {
      calls.start += 1;
      return script.start ?? { ok: true, redirectUrl: REDIRECT, state: STATE };
    },
  };
  const signIn = async (input) => {
    calls.signIn.push(input);
    return script.signIn ?? { ok: true, token: TOKEN };
  };
  return { calls, flow, signIn };
}

async function withServer(router, fn) {
  const app = express();
  app.use(router);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const noRedirect = { redirect: 'manual' };

describe('central sso routes: disabled (default)', () => {
  test('start and callback return 404 and never call the flow or sign-in', async () => {
    const { calls, flow, signIn } = makeStubs();
    const router = createCentralSsoRouter({ enabled: false, flow, signIn });
    await withServer(router, async (base) => {
      const start = await fetch(base + CENTRAL_START_PATH, noRedirect);
      assert.equal(start.status, 404);
      assert.equal(start.headers.get('set-cookie'), null);
      const cb = await fetch(base + CENTRAL_CALLBACK_PATH + '?code=x&state=y', noRedirect);
      assert.equal(cb.status, 404);
      assert.equal(cb.headers.get('set-cookie'), null);
    });
    assert.equal(calls.start, 0);
    assert.equal(calls.signIn.length, 0);
  });

  test('other paths are not claimed by the router', async () => {
    const router = createCentralSsoRouter({ enabled: false });
    await withServer(router, async (base) => {
      const res = await fetch(base + '/auth/central/other', noRedirect);
      assert.equal(res.status, 404);
    });
  });
});

describe('central sso routes: enabled', () => {
  test('start redirects to the provider and sets the host-only transaction cookie', async () => {
    const { calls, flow, signIn } = makeStubs();
    const router = createCentralSsoRouter({ enabled: true, flow, signIn });
    await withServer(router, async (base) => {
      const res = await fetch(base + CENTRAL_START_PATH, noRedirect);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), REDIRECT);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const cookie = res.headers.get('set-cookie');
      assert.match(cookie, new RegExp(`^__Host-central_sso_txn=${STATE}; Path=/; Max-Age=600; HttpOnly; Secure; SameSite=Lax$`));
      assert.doesNotMatch(cookie, /Domain=/i);
    });
    assert.equal(calls.start, 1);
  });

  test('start reports a fixed reason and sets no cookie when the flow fails', async () => {
    const { flow, signIn } = makeStubs({ start: { ok: false, reason: 'session_unavailable' } });
    const router = createCentralSsoRouter({ enabled: true, flow, signIn });
    await withServer(router, async (base) => {
      const res = await fetch(base + CENTRAL_START_PATH, noRedirect);
      assert.equal(res.status, 503);
      assert.equal(res.headers.get('set-cookie'), null);
      assert.deepEqual(await res.json(), { success: false, reason: 'session_unavailable' });
    });
  });

  test('start turns a thrown flow error into a fixed reason', async () => {
    const router = createCentralSsoRouter({
      enabled: true,
      flow: { start: async () => { throw new Error('secret detail'); } },
    });
    await withServer(router, async (base) => {
      const res = await fetch(base + CENTRAL_START_PATH, noRedirect);
      assert.equal(res.status, 503);
      const body = await res.text();
      assert.doesNotMatch(body, /secret detail/);
      assert.equal(JSON.parse(body).reason, 'provider_error');
    });
  });

  test('callback passes the query and the cookie state to sign-in and returns the token', async () => {
    const { calls, flow, signIn } = makeStubs();
    const router = createCentralSsoRouter({ enabled: true, flow, signIn });
    await withServer(router, async (base) => {
      const res = await fetch(`${base}${CENTRAL_CALLBACK_PATH}?code=abc&state=${STATE}`, {
        ...noRedirect,
        headers: { cookie: `other=1; __Host-central_sso_txn=${STATE}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.match(res.headers.get('set-cookie'), /^__Host-central_sso_txn=; Path=\/; Max-Age=0; HttpOnly; Secure; SameSite=Lax$/);
      assert.deepEqual(await res.json(), { success: true, token: TOKEN });
    });
    assert.equal(calls.signIn.length, 1);
    assert.deepEqual(calls.signIn[0].query, { code: 'abc', state: STATE });
    assert.equal(calls.signIn[0].cookieState, STATE);
  });

  test('callback without the transaction cookie passes undefined state to sign-in', async () => {
    const { calls, flow, signIn } = makeStubs({ signIn: { ok: false, reason: 'state_mismatch' } });
    const router = createCentralSsoRouter({ enabled: true, flow, signIn });
    await withServer(router, async (base) => {
      const res = await fetch(`${base}${CENTRAL_CALLBACK_PATH}?code=abc&state=${STATE}`, noRedirect);
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { success: false, reason: 'state_mismatch' });
    });
    assert.equal(calls.signIn[0].cookieState, undefined);
  });

  test('duplicate transaction cookies are treated as absent', async () => {
    const { calls, flow, signIn } = makeStubs({ signIn: { ok: false, reason: 'state_mismatch' } });
    const router = createCentralSsoRouter({ enabled: true, flow, signIn });
    await withServer(router, async (base) => {
      await fetch(`${base}${CENTRAL_CALLBACK_PATH}?code=abc&state=${STATE}`, {
        ...noRedirect,
        headers: { cookie: `__Host-central_sso_txn=${STATE}; __Host-central_sso_txn=${STATE}` },
      });
    });
    assert.equal(calls.signIn[0].cookieState, undefined);
  });

  test('callback clears the cookie and returns 401 when sign-in fails', async () => {
    const { flow, signIn } = makeStubs({ signIn: { ok: false, reason: 'no_local_account' } });
    const router = createCentralSsoRouter({ enabled: true, flow, signIn });
    await withServer(router, async (base) => {
      const res = await fetch(`${base}${CENTRAL_CALLBACK_PATH}?error=access_denied`, noRedirect);
      assert.equal(res.status, 401);
      assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
      assert.deepEqual(await res.json(), { success: false, reason: 'no_local_account' });
    });
  });

  test('callback turns a thrown sign-in error into a fixed reason', async () => {
    const router = createCentralSsoRouter({
      enabled: true,
      signIn: async () => { throw new Error('db password=hunter2'); },
    });
    await withServer(router, async (base) => {
      const res = await fetch(`${base}${CENTRAL_CALLBACK_PATH}?code=abc`, noRedirect);
      const body = await res.text();
      assert.equal(res.status, 401);
      assert.doesNotMatch(body, /hunter2/);
      assert.equal(JSON.parse(body).reason, 'sign_in_failed');
    });
  });

  test('enabled without wiring fails closed with 503', async () => {
    const router = createCentralSsoRouter({ enabled: true });
    await withServer(router, async (base) => {
      const start = await fetch(base + CENTRAL_START_PATH, noRedirect);
      assert.equal(start.status, 503);
      assert.equal(JSON.parse(await start.text()).reason, 'not_configured');
      const cb = await fetch(base + CENTRAL_CALLBACK_PATH + '?code=abc', noRedirect);
      assert.equal(cb.status, 503);
      assert.match(cb.headers.get('set-cookie'), /Max-Age=0/);
    });
  });
});
