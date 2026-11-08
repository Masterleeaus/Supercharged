/**
 * Tests for server/workforce/runtime/task-board-routes.ts.
 * Stub auth guards stand in for the real auth middleware. The real requireCompanyScope and setScopedCompany run.
 * The store is a fake RunStore with listRuns and listAudit only. Real express on an ephemeral port.
 * Run: node --test --experimental-transform-types tests/workforce/task-board-routes.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTaskBoardRouter, TASKS_PATH, RUN_HISTORY_PATH, MAX_TASKS } from '../../server/workforce/runtime/task-board-routes.ts';
import { requireCompanyScope } from '../../server/middleware/company-scope.ts';
import { StoreUnavailableError } from '../../server/workforce/runtime/store.ts';
import { RUN_VIEW_LABELS } from '../../server/workforce/runtime/run-status-view.ts';

// Keep the output stream clean: the test runner reads child stdout over IPC.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const ADMIN_A = { userId: 'u-admin-a', role: 'admin', companyId: CO_A };
const MANAGER_A = { userId: 'u-manager-a', role: 'manager', companyId: CO_A };
const STAFF_A = { userId: 'u-staff-a', role: 'user', companyId: CO_A };
const NOSCOPE = { userId: 'u-none', role: 'admin' };
const NOW = new Date('2026-11-04T12:00:00.000Z');
const STALE_MS = 60 * 60 * 1000;

const stubAuthenticate = (req, res, next) => {
  const raw = req.headers['x-test-user'];
  if (!raw) return res.status(401).json({ error: 'Authentication required' });
  const u = JSON.parse(raw);
  req.userId = u.userId;
  req.userRole = u.role;
  req.user = { id: u.userId, role: u.role, companyId: u.companyId };
  next();
};

const requireAdminOrManager = (req, res, next) => {
  if (req.userRole === 'admin' || req.userRole === 'manager') return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
};

const guards = {
  authenticate: stubAuthenticate,
  requireCompanyScope: requireCompanyScope(),
  requireAdminOrManager,
};

function run(id, companyId, status, overrides = {}) {
  return {
    id,
    companyId,
    status,
    version: 1,
    createdAt: '2026-11-04T09:00:00.000Z',
    updatedAt: '2026-11-04T10:00:00.000Z',
    team: { id: 'team-1', secretConfig: 'sk_test_FAKE_FIXTURE_ONLY' },
    path: ['coordinator'],
    delegations: [{ tool: 'raw-tool-params', params: { email: 'jane@example.com' } }],
    limits: { maxDepth: 3 },
    budget: { maxTokens: 1000, maxToolCalls: 10, tokensUsed: 5, toolCalls: 1 },
    retry: { maxAttempts: 3, baseDelayMs: 200, maxDelayMs: 2000 },
    pendingApproval: null,
    reason: null,
    ...overrides,
  };
}

function audit(id, companyId, runId, kind, at) {
  return { id, companyId, runId, kind, at, data: {} };
}

function fakeStore({ runs = [], events = [], failListRuns = null, failListAudit = null } = {}) {
  return {
    async listRuns(companyId) {
      if (failListRuns) throw failListRuns;
      return runs.filter((r) => r.companyId === companyId);
    },
    async listAudit(companyId, runId) {
      if (failListAudit) throw failListAudit;
      return events.filter((e) => e.companyId === companyId && (runId === undefined || e.runId === runId));
    },
    async getRun() { throw new Error('not used'); },
    async insertRun() { throw new Error('not used'); },
    async updateRun() { throw new Error('not used'); },
    async appendAudit() { throw new Error('not used'); },
  };
}

async function start(deps) {
  const app = express();
  app.use(createTaskBoardRouter(deps, guards));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, user) =>
    fetch(base + path, {
      headers: user ? { 'x-test-user': JSON.stringify(user) } : {},
    }).then(async (r) => ({ status: r.status, body: await r.json() }));
  return { get, close: () => new Promise((resolve) => server.close(resolve)) };
}

const deps = (store, extra = {}) => ({ store, now: () => NOW, staleAfterMs: STALE_MS, ...extra });

test('paths are the agreed workforce routes', () => {
  assert.equal(TASKS_PATH, '/api/workforce/tasks');
  assert.equal(RUN_HISTORY_PATH, '/api/workforce/run-history');
});

test('tasks: 401 without a session, 403 for staff, 403 with no company scope', async () => {
  const s = await start(deps(fakeStore()));
  try {
    assert.equal((await s.get(TASKS_PATH)).status, 401);
    assert.equal((await s.get(TASKS_PATH, STAFF_A)).status, 403);
    assert.equal((await s.get(TASKS_PATH, NOSCOPE)).status, 403);
  } finally {
    await s.close();
  }
});

test('run history: 401 without a session, 403 for staff', async () => {
  const s = await start(deps(fakeStore()));
  try {
    assert.equal((await s.get(RUN_HISTORY_PATH)).status, 401);
    assert.equal((await s.get(RUN_HISTORY_PATH, STAFF_A)).status, 403);
  } finally {
    await s.close();
  }
});

test('tasks: admin and manager see only their own company, with run-status labels', async () => {
  const store = fakeStore({
    runs: [
      run('run-a1', CO_A, 'running'),
      run('run-a2', CO_A, 'completed', { updatedAt: '2026-11-04T11:00:00.000Z' }),
      run('run-b1', CO_B, 'running'),
    ],
  });
  const s = await start(deps(store));
  try {
    for (const user of [ADMIN_A, MANAGER_A]) {
      const { status, body } = await s.get(TASKS_PATH, user);
      assert.equal(status, 200);
      assert.deepEqual(body.tasks.map((t) => t.runId), ['run-a2', 'run-a1']);
      assert.equal(body.truncated, false);
      const byId = Object.fromEntries(body.tasks.map((t) => [t.runId, t]));
      assert.equal(byId['run-a1'].label, 'running');
      assert.equal(byId['run-a1'].text, 'In progress');
      assert.equal(byId['run-a2'].label, 'completed');
      assert.equal(byId['run-a2'].text, 'Finished');
    }
  } finally {
    await s.close();
  }
});

test('tasks: raw run internals are not returned', async () => {
  const store = fakeStore({ runs: [run('run-a1', CO_A, 'running')] });
  const s = await start(deps(store));
  try {
    const { body } = await s.get(TASKS_PATH, ADMIN_A);
    const json = JSON.stringify(body);
    for (const forbidden of ['team', 'budget', 'delegations', 'limits', 'retry', 'path', 'sk_test_FAKE_FIXTURE_ONLY', 'jane@example.com', 'raw-tool-params', 'companyId', 'status"']) {
      assert.equal(json.includes(forbidden), false, `response must not contain ${forbidden}`);
    }
    assert.deepEqual(Object.keys(body.tasks[0]).sort(), ['createdAt', 'detail', 'label', 'runId', 'text', 'updatedAt']);
  } finally {
    await s.close();
  }
});

test('tasks: an approval waiting past the stale threshold shows as needs attention', async () => {
  const waiting = { pendingApproval: { id: 'ap-1', action: 'send' } };
  const store = fakeStore({
    runs: [
      run('run-fresh', CO_A, 'awaiting_approval', { ...waiting, updatedAt: '2026-11-04T11:45:00.000Z' }),
      run('run-stale', CO_A, 'awaiting_approval', { ...waiting, updatedAt: '2026-11-04T09:00:00.000Z' }),
    ],
  });
  const s = await start(deps(store));
  try {
    const { body } = await s.get(TASKS_PATH, ADMIN_A);
    const byId = Object.fromEntries(body.tasks.map((t) => [t.runId, t]));
    assert.equal(byId['run-fresh'].label, 'awaiting_approval');
    assert.equal(byId['run-stale'].label, 'needs_attention');
    assert.equal(byId['run-stale'].text, 'Needs your attention');
  } finally {
    await s.close();
  }
});

test('tasks: a stored reason with a bearer token does not leave the server unredacted', async () => {
  const store = fakeStore({
    runs: [run('run-a1', CO_A, 'failed', { reason: 'provider said Bearer abc.def.ghi1234567890 is bad' })],
  });
  const s = await start(deps(store));
  try {
    const { body } = await s.get(RUN_HISTORY_PATH, ADMIN_A);
    const json = JSON.stringify(body);
    assert.equal(json.includes('abc.def.ghi1234567890'), false);
    assert.equal(body.runs[0].outcome.reason.includes('[redacted]'), true);
  } finally {
    await s.close();
  }
});

test('tasks: more runs than the cap returns the cap and says so', async () => {
  const runs = Array.from({ length: MAX_TASKS + 5 }, (_, i) =>
    run(`run-${i}`, CO_A, 'queued', { updatedAt: new Date(Date.UTC(2026, 10, 4, 0, i)).toISOString() }),
  );
  const s = await start(deps(fakeStore({ runs })));
  try {
    const { body } = await s.get(TASKS_PATH, ADMIN_A);
    assert.equal(body.tasks.length, MAX_TASKS);
    assert.equal(body.truncated, true);
    assert.equal(body.tasks[0].runId, `run-${MAX_TASKS + 4}`);
  } finally {
    await s.close();
  }
});

test('run history: each run carries its own audit events from the same company only', async () => {
  const store = fakeStore({
    runs: [run('run-a1', CO_A, 'completed'), run('run-a2', CO_A, 'running', { createdAt: '2026-11-04T10:30:00.000Z' })],
    events: [
      audit('e1', CO_A, 'run-a1', 'run.started', '2026-11-04T09:01:00.000Z'),
      audit('e2', CO_A, 'run-a1', 'run.completed', '2026-11-04T09:05:00.000Z'),
      audit('e3', CO_B, 'run-a1', 'run.completed', '2026-11-04T09:06:00.000Z'),
      audit('e4', CO_A, null, 'workforce.export', '2026-11-04T09:07:00.000Z'),
    ],
  });
  const s = await start(deps(store));
  try {
    const { status, body } = await s.get(RUN_HISTORY_PATH, ADMIN_A);
    assert.equal(status, 200);
    assert.deepEqual(body.runs.map((r) => r.runId), ['run-a2', 'run-a1']);
    const a1 = body.runs.find((r) => r.runId === 'run-a1');
    assert.deepEqual(a1.events.map((e) => e.action), ['run.started', 'run.completed']);
    assert.deepEqual(Object.keys(a1.events[0]).sort(), ['action', 'createdAt']);
    assert.equal(a1.label, 'completed');
    assert.equal(body.runs.find((r) => r.runId === 'run-a2').events.length, 0);
  } finally {
    await s.close();
  }
});

test('run history: unknown run statuses fail visible as needs attention', async () => {
  const store = fakeStore({ runs: [run('run-x', CO_A, 'mystery_state')] });
  const s = await start(deps(store));
  try {
    const { body } = await s.get(RUN_HISTORY_PATH, ADMIN_A);
    assert.equal(body.runs[0].label, 'needs_attention');
    assert.ok(RUN_VIEW_LABELS.includes(body.runs[0].label));
  } finally {
    await s.close();
  }
});

test('no store configured returns 503 with a generic body', async () => {
  const s = await start({ now: () => NOW });
  try {
    const { status, body } = await s.get(TASKS_PATH, ADMIN_A);
    assert.equal(status, 503);
    assert.equal(body.error, 'dependency_not_configured');
  } finally {
    await s.close();
  }
});

test('store unavailable returns 503, any other store failure returns 500 without its message', async () => {
  const unavailable = await start(deps(fakeStore({ failListRuns: new StoreUnavailableError('db down at host 10.0.0.5') })));
  try {
    const { status, body } = await unavailable.get(TASKS_PATH, ADMIN_A);
    assert.equal(status, 503);
    assert.equal(body.error, 'store_unavailable');
    assert.equal(JSON.stringify(body).includes('10.0.0.5'), false);
  } finally {
    await unavailable.close();
  }

  const broken = await start(deps(fakeStore({ failListAudit: new Error('SELECT secret FROM table password=hunter2') })));
  try {
    const { status, body } = await broken.get(RUN_HISTORY_PATH, ADMIN_A);
    assert.equal(status, 500);
    assert.deepEqual(body, { error: 'internal_error' });
  } finally {
    await broken.close();
  }
});
