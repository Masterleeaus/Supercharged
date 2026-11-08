/**
 * Tests for server/workforce/runtime/shadow-routes.ts.
 * Real express on an ephemeral port. Real requireCompanyScope and real createShadowChanges over the in-memory store.
 * Stub authenticate reads the test identity from the x-test-user header and sets req.user, as the real auth does.
 * Run: node --test --experimental-transform-types tests/workforce/shadow-routes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createShadowRouter, SHADOW_PENDING_PATH } from '../../server/workforce/runtime/shadow-routes.ts';
import { createShadowChanges, createMemoryShadowStore } from '../../server/workforce/runtime/shadow-changes.ts';
import { requireCompanyScope } from '../../server/middleware/company-scope.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const MEMBER_A = { id: 'u-member-a', role: 'member', companyId: CO_A };
const MANAGER_A = { id: 'u-manager-a', role: 'manager', companyId: CO_A };
const OWNER_B = { id: 'u-owner-b', role: 'owner', companyId: CO_B };

const stubAuthenticate = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  const u = JSON.parse(raw);
  req.user = { id: u.id, role: u.role, companyId: u.companyId };
  next();
};
/** Stands in for requireRole('admin', 'manager'), which reads req.userRole. The response matches the service refusal. */
const stubRequireApprover = (req, res, next) => {
  const role = req.user?.role;
  if (role === 'owner' || role === 'admin' || role === 'manager') return next();
  return res.status(403).json({ error: 'not_permitted' });
};
const guards = { authenticate: stubAuthenticate, requireCompanyScope: requireCompanyScope(), requireApprover: stubRequireApprover };

/** Builds a real shadow service, one pending money change for CO_A, and a router served on an ephemeral port. */
async function setup() {
  const store = createMemoryShadowStore();
  let applied = 0;
  const shadow = createShadowChanges({
    store,
    now: () => Date.now(),
    readVersion: async () => 0,
    apply: async () => {
      applied += 1;
      return 'applied';
    },
  });
  const created = await shadow.request({
    companyId: CO_A,
    runId: 'run-1',
    toolId: 'tool-invoice-send',
    category: 'money',
    targetTable: 'invoices',
    targetId: 'inv-1',
    operation: 'update',
    before: { total: 10 },
    after: { total: 20 },
    baseVersion: 0,
    requestedBy: { agentId: 'agent-1', roleId: 'role-billing' },
  });
  assert.equal(created.ok, true);
  const changeId = created.change.id;

  const pendingRows = [created.change];
  const app = express();
  app.use(express.json());
  app.use(
    createShadowRouter(
      {
        shadow,
        listPending: (companyId) => pendingRows.filter((c) => c.companyId === companyId),
      },
      guards,
    ),
  );
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    changeId,
    getApplied: () => applied,
    status: async () => (await shadow.get(CO_A, changeId)).status,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
    call: (method, path, user, body) =>
      fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': JSON.stringify(user) } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) })),
  };
}

test('a member cannot approve a money change, and the change stays pending', async () => {
  const srv = await setup();
  try {
    const r = await srv.call('POST', `/api/workforce/shadow-changes/${srv.changeId}/approve`, MEMBER_A, {});
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'not_permitted');
    assert.equal(srv.getApplied(), 0);
    assert.equal(await srv.status(), 'pending');
  } finally {
    await srv.close();
  }
});

test('a body role of owner does not grant approval', async () => {
  const srv = await setup();
  try {
    const r = await srv.call(
      'POST',
      `/api/workforce/shadow-changes/${srv.changeId}/approve`,
      MEMBER_A,
      { role: 'owner', approverRole: 'owner', user: { role: 'owner' } },
    );
    assert.equal(r.status, 403);
    assert.equal(srv.getApplied(), 0);
    assert.equal(await srv.status(), 'pending');
  } finally {
    await srv.close();
  }
});

test('a manager approves through the session role, and a different company id in the body is ignored', async () => {
  const srv = await setup();
  try {
    const r = await srv.call(
      'POST',
      `/api/workforce/shadow-changes/${srv.changeId}/approve`,
      MANAGER_A,
      { companyId: CO_B },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'applied');
    assert.equal(srv.getApplied(), 1);
    assert.equal(await srv.status(), 'applied');
  } finally {
    await srv.close();
  }
});

test('a body company id naming the change company does not let another company approve it', async () => {
  const srv = await setup();
  try {
    const r = await srv.call(
      'POST',
      `/api/workforce/shadow-changes/${srv.changeId}/approve`,
      OWNER_B,
      { companyId: CO_A },
    );
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
    assert.equal(srv.getApplied(), 0);
    assert.equal(await srv.status(), 'pending');
  } finally {
    await srv.close();
  }
});

test('the pending list uses the session company and ignores a company id in the query', async () => {
  const srv = await setup();
  try {
    const mine = await srv.call('GET', `${SHADOW_PENDING_PATH}?companyId=${CO_B}`, MANAGER_A);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.changes.length, 1);
    assert.equal(mine.body.changes[0].id, srv.changeId);

    const other = await srv.call('GET', SHADOW_PENDING_PATH, OWNER_B);
    assert.equal(other.status, 200);
    assert.equal(other.body.changes.length, 0);
  } finally {
    await srv.close();
  }
});

test('unauthenticated requests are refused', async () => {
  const srv = await setup();
  try {
    const r = await srv.call('POST', `/api/workforce/shadow-changes/${srv.changeId}/approve`, null, {});
    assert.equal(r.status, 401);
    assert.equal(srv.getApplied(), 0);
  } finally {
    await srv.close();
  }
});

test('the pending list refuses a member, even with a valid company session', async () => {
  const srv = await setup();
  try {
    const r = await srv.call('GET', SHADOW_PENDING_PATH, MEMBER_A);
    assert.equal(r.status, 403);
    assert.equal(r.body.error, 'not_permitted');
    assert.equal(r.body.changes, undefined);
  } finally {
    await srv.close();
  }
});

test('the approver guard runs on every shadow route, before any decision', async () => {
  const shadow = {
    decide: async () => {
      throw new Error('decide must not run');
    },
    retry: async () => {
      throw new Error('retry must not run');
    },
  };
  const deny = (req, res) => res.status(403).json({ error: 'role_required' });
  const app = express();
  app.use(express.json());
  app.use(createShadowRouter({ shadow, listPending: () => [] }, { ...guards, requireApprover: deny }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const [method, path] of [
      ['GET', SHADOW_PENDING_PATH],
      ['POST', '/api/workforce/shadow-changes/sc-1/approve'],
      ['POST', '/api/workforce/shadow-changes/sc-1/reject'],
      ['POST', '/api/workforce/shadow-changes/sc-1/retry'],
    ]) {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', 'x-test-user': JSON.stringify(MANAGER_A) },
        body: method === 'POST' ? '{}' : undefined,
      });
      assert.equal(res.status, 403, path);
      assert.equal((await res.json()).error, 'role_required', path);
    }
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test('retry re-applies an approved change for a manager, and refuses a member', async () => {
  let calls = 0;
  const store = createMemoryShadowStore();
  const shadow = createShadowChanges({
    store,
    now: () => Date.now(),
    readVersion: async () => 0,
    apply: async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return 'applied';
    },
  });
  const created = await shadow.request({
    companyId: CO_A,
    runId: 'run-1',
    toolId: 'tool-invoice-send',
    category: 'other',
    targetTable: 'invoices',
    targetId: 'inv-2',
    operation: 'update',
    before: { total: 10 },
    after: { total: 20 },
    baseVersion: 0,
    requestedBy: { agentId: 'agent-1', roleId: 'role-billing' },
  });
  const app = express();
  app.use(express.json());
  app.use(createShadowRouter({ shadow }, guards));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (user, path) =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': JSON.stringify(user) } : {}) },
      body: '{}',
    });
  try {
    const approveRes = await call(MANAGER_A, `/api/workforce/shadow-changes/${created.change.id}/approve`);
    assert.equal(approveRes.status, 500, 'a throwing apply is a server error, not success');
    assert.equal((await shadow.get(CO_A, created.change.id)).status, 'approved');

    const memberRetry = await call(MEMBER_A, `/api/workforce/shadow-changes/${created.change.id}/retry`);
    assert.equal(memberRetry.status, 403);
    assert.equal((await shadow.get(CO_A, created.change.id)).status, 'approved');

    const retryRes = await call(MANAGER_A, `/api/workforce/shadow-changes/${created.change.id}/retry`);
    assert.equal(retryRes.status, 200);
    assert.deepEqual(await retryRes.json(), { status: 'applied' });
    assert.equal((await shadow.get(CO_A, created.change.id)).status, 'applied');
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

