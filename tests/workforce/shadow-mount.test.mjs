/**
 * Tests for the production mount of the shadow router.
 * - Static: server/routes.ts mounts createShadowRouterForProduction once, right after the workforce admin router,
 *   behind authenticate, requireCompanyScope and requireRole('admin', 'manager').
 * - Runtime: createShadowRouterForProduction over a fake pool, with the real requireCompanyScope. Proves the pending
 *   list is company-scoped through listPending, and that an approval is refused while the apply allowlist is empty.
 * Run: node --test --experimental-transform-types tests/workforce/shadow-mount.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import {
  createShadowRouterForProduction,
  SHADOW_APPLY_TABLES,
  SHADOW_PENDING_PATH,
} from '../../server/workforce/runtime/shadow-routes.ts';
import { requireCompanyScope } from '../../server/middleware/company-scope.ts';

const ROUTES = new URL('../../server/routes.ts', import.meta.url);
const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const MANAGER_A = { id: 'u-manager-a', role: 'manager', companyId: CO_A };
const MEMBER_A = { id: 'u-member-a', role: 'member', companyId: CO_A };
const MANAGER_B = { id: 'u-manager-b', role: 'manager', companyId: CO_B };

const pendingRow = {
  id: 'sc-1',
  company_id: CO_A,
  run_id: 'run-1',
  tool_id: 'tool-job-update',
  category: 'other',
  target_table: 'desk_jobs',
  target_id: 'job-7',
  operation: 'update',
  before_json: { status: 'open' },
  after_json: { status: 'scheduled' },
  base_version: 3,
  requested_by_agent_id: 'agent-1',
  requested_by_role_id: 'role-scheduler',
  policy_version: '1',
  status: 'pending',
  approved_by_kind: null,
  approved_by_id: null,
  created_at: '2026-11-04T00:00:00.000Z',
  decided_at: null,
  applied_at: null,
};

/** Fake pool: answers the shadow store's statements from one pending row. Records every statement. */
function fakePool() {
  const log = [];
  const pool = {
    log,
    async query(text, values = []) {
      log.push({ text, values });
      if (text.includes('FROM shadow_changes') && text.includes('status = $2')) {
        const rows = pendingRow.company_id === values[0] && pendingRow.status === 'pending' ? [pendingRow] : [];
        return { rows, rowCount: rows.length };
      }
      if (text.includes('FROM shadow_changes') && text.includes('id = $2')) {
        const match = values[0] === pendingRow.company_id && values[1] === pendingRow.id;
        return { rows: match ? [pendingRow] : [], rowCount: match ? 1 : 0 };
      }
      if (text.startsWith('UPDATE shadow_changes')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected SQL in mount fake: ${text.slice(0, 60)}`);
    },
    async connect() {
      log.push({ text: 'connect', values: [] });
      throw new Error('apply must not be reached');
    },
  };
  return pool;
}

const stubAuthenticate = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  const u = JSON.parse(raw);
  req.user = { id: u.id, role: u.role, companyId: u.companyId };
  next();
};
const stubRequireApprover = (req, res, next) => {
  const role = req.user?.role;
  if (role === 'owner' || role === 'admin' || role === 'manager') return next();
  return res.status(403).json({ error: 'not_permitted' });
};

async function serve(pool) {
  const app = express();
  app.use(express.json());
  app.use(
    createShadowRouterForProduction(pool, {
      authenticate: stubAuthenticate,
      requireCompanyScope: requireCompanyScope(),
      requireApprover: stubRequireApprover,
    }),
  );
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    call: (method, path, user, body) =>
      fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': JSON.stringify(user) } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) })),
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

test('routes.ts mounts the shadow router once, after the workforce admin router, behind the three guards', () => {
  const source = readFileSync(ROUTES, 'utf8');
  const mounts = source.split('\n').filter((line) => line.includes('createShadowRouterForProduction'));
  assert.equal(mounts.length, 1, 'exactly one mount line');
  const mount = mounts[0];
  assert.match(mount, /app\.use\(/);
  assert.match(mount, /authenticate: authenticateToken/);
  assert.match(mount, /requireCompanyScope: requireCompanyScope\(\)/);
  assert.match(mount, /requireApprover: requireRole\("admin", "manager"\)/);

  // The admin mount is a multi-line app.use(...) statement. It starts at the app.use line that opens
  // createWorkforceAdminRouter and ends at the first line after it that closes the statement with "}));".
  const lines = source.split('\n');
  const adminStart = lines.findIndex((line) => line.includes('app.use(createWorkforceAdminRouter('));
  assert.ok(adminStart >= 0, 'workforce admin router mount exists');
  const adminEnd = lines.findIndex((line, i) => i > adminStart && line.trimEnd().endsWith('}));'));
  assert.ok(adminEnd > adminStart, 'workforce admin router mount ends');
  const mountIndex = lines.indexOf(mount);
  assert.equal(mountIndex, adminEnd + 1, 'shadow mount sits directly after the workforce admin mount');
});

test('the shadow apply allowlist is empty until Jason names the tables', () => {
  assert.deepEqual([...SHADOW_APPLY_TABLES], []);
});

test('the pending list is company-scoped: a manager of another company sees none of these rows', async () => {
  const pool = fakePool();
  const srv = await serve(pool);
  try {
    const mine = await srv.call('GET', SHADOW_PENDING_PATH, MANAGER_A);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.changes.length, 1);
    assert.equal(mine.body.changes[0].id, 'sc-1');

    const theirs = await srv.call('GET', `${SHADOW_PENDING_PATH}?companyId=${CO_A}`, MANAGER_B);
    assert.equal(theirs.status, 200);
    assert.equal(theirs.body.changes.length, 0);

    const listCalls = pool.log.filter((c) => c.text.includes('status = $2'));
    assert.deepEqual(listCalls.map((c) => c.values[0]), [CO_A, CO_B]);
  } finally {
    await srv.close();
  }
});

test('a member cannot list, and no SQL runs for a refused request', async () => {
  const pool = fakePool();
  const srv = await serve(pool);
  try {
    const r = await srv.call('GET', SHADOW_PENDING_PATH, MEMBER_A);
    assert.equal(r.status, 403);
    assert.equal(pool.log.length, 0);
  } finally {
    await srv.close();
  }
});

test('an unauthenticated request is refused before scope or service', async () => {
  const pool = fakePool();
  const srv = await serve(pool);
  try {
    const r = await srv.call('GET', SHADOW_PENDING_PATH, null);
    assert.equal(r.status, 401);
    assert.equal(pool.log.length, 0);
  } finally {
    await srv.close();
  }
});

test('an approval is refused with 400 while the allowlist is empty, and nothing is applied or connected', async () => {
  const pool = fakePool();
  const srv = await serve(pool);
  try {
    const r = await srv.call('POST', `/api/workforce/shadow-changes/sc-1/approve`, MANAGER_A, { companyId: CO_B });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid');
    assert.equal(pool.log.some((c) => c.text === 'connect'), false, 'no connection is taken for apply');
    assert.equal(pool.log.some((c) => c.text.startsWith('UPDATE shadow_changes')), false, 'status does not move');
  } finally {
    await srv.close();
  }
});
