/**
 * Tests for server/routes/dead-letter-routes.ts.
 * The listDeadLetterDeliveries service is stubbed through deps. Stub auth guards stand in for the real
 * auth middleware, while the real requireCompanyScope runs. Real express on an ephemeral port.
 * Run: node --test --experimental-transform-types tests/routes/dead-letter-routes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createDeadLetterRouter,
  clampDeadLetterLimit,
  DEAD_LETTER_PATH,
} from '../../server/routes/dead-letter-routes.ts';
import { requireCompanyScope } from '../../server/middleware/company-scope.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_A = { userId: 'u-admin', role: 'admin', companyId: CO_A };
const MANAGER_A = { userId: 'u-mgr', role: 'manager', companyId: CO_A };
const MEMBER_A = { userId: 'u-mem', role: 'member', companyId: CO_A };
const NO_COMPANY = { userId: 'u-x', role: 'admin' };

// Stub authenticate: the test identity arrives in the x-test-user header. No header means refused.
const stubAuthenticate = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  const u = JSON.parse(raw);
  req.userId = u.userId;
  req.user = { id: u.userId, role: u.role, companyId: u.companyId };
  next();
};
// Stub role guard: admin or manager only, as the real requireRole('admin', 'manager') is.
const stubRequireApprover = (req, res, next) => {
  if (req.user && ['admin', 'manager'].includes(req.user.role)) return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
};
const guards = {
  authenticate: stubAuthenticate,
  requireCompanyScope: requireCompanyScope(),
  requireApprover: stubRequireApprover,
};

async function start(deps) {
  const app = express();
  app.use(express.json());
  app.use(createDeadLetterRouter(deps, guards));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }),
    get: (path, user) =>
      fetch(base + path, {
        method: 'GET',
        headers: user ? { 'x-test-user': JSON.stringify(user) } : {},
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) })),
  };
}

test('unauthenticated requests are refused and the service is never called', async () => {
  let calls = 0;
  const srv = await start({ listDeadLetterDeliveries: () => { calls += 1; return []; } });
  try {
    const res = await srv.get(DEAD_LETTER_PATH, null);
    assert.equal(res.status, 401);
    assert.equal(calls, 0);
  } finally {
    await srv.close();
  }
});

test('a member is refused with 403 and the service is never called', async () => {
  let calls = 0;
  const srv = await start({ listDeadLetterDeliveries: () => { calls += 1; return []; } });
  try {
    const res = await srv.get(DEAD_LETTER_PATH, MEMBER_A);
    assert.equal(res.status, 403);
    assert.equal(calls, 0);
  } finally {
    await srv.close();
  }
});

test('a logged-in user with no company is refused with 403 and the service is never called', async () => {
  let calls = 0;
  const srv = await start({ listDeadLetterDeliveries: () => { calls += 1; return []; } });
  try {
    const res = await srv.get(DEAD_LETTER_PATH, NO_COMPANY);
    assert.equal(res.status, 403);
    assert.equal(calls, 0);
  } finally {
    await srv.close();
  }
});

test('an admin and a manager are allowed through and receive the service items', async () => {
  const srv = await start({
    listDeadLetterDeliveries: () => [{ id: 'w-1', companyId: CO_A, status: 'failed', attemptCount: 5, maxAttempts: 5 }],
  });
  try {
    for (const user of [ADMIN_A, MANAGER_A]) {
      const res = await srv.get(DEAD_LETTER_PATH, user);
      assert.equal(res.status, 200);
      assert.equal(res.body.items.length, 1);
      assert.equal(res.body.items[0].id, 'w-1');
    }
  } finally {
    await srv.close();
  }
});

test('the company passed to the service is the session company, even when the query names another', async () => {
  const seen = [];
  const srv = await start({
    listDeadLetterDeliveries: (companyId) => {
      seen.push(companyId);
      return [];
    },
  });
  try {
    const res = await srv.get(`${DEAD_LETTER_PATH}?companyId=${CO_B}&company_id=${CO_B}`, ADMIN_A);
    assert.equal(res.status, 200);
    assert.deepEqual(seen, [CO_A]);
  } finally {
    await srv.close();
  }
});

test('the limit is clamped to 1..100 and a missing or non-numeric limit uses 100', async () => {
  const seen = [];
  const srv = await start({
    listDeadLetterDeliveries: (_companyId, limit) => {
      seen.push(limit);
      return [];
    },
  });
  try {
    const cases = [
      ['0', 1],
      ['-5', 1],
      ['500', 100],
      ['25', 25],
      ['1', 1],
      ['100', 100],
      ['abc', 100],
    ];
    for (const [raw, expected] of cases) {
      const res = await srv.get(`${DEAD_LETTER_PATH}?limit=${raw}`, ADMIN_A);
      assert.equal(res.status, 200, `limit=${raw}`);
    }
    const none = await srv.get(DEAD_LETTER_PATH, ADMIN_A);
    assert.equal(none.status, 200);
    assert.deepEqual(seen, [1, 1, 100, 25, 1, 100, 100, 100]);
  } finally {
    await srv.close();
  }
});

test('clampDeadLetterLimit bounds values and falls back for non-string input', () => {
  assert.equal(clampDeadLetterLimit('0'), 1);
  assert.equal(clampDeadLetterLimit('999'), 100);
  assert.equal(clampDeadLetterLimit('42'), 42);
  assert.equal(clampDeadLetterLimit(undefined), 100);
  assert.equal(clampDeadLetterLimit(['5', '6']), 100);
});
