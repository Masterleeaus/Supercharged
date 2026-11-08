import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import express from 'express';
import { hashAction } from '../../server/modules/approvals/approval-signing.ts';

// The approval router and service import '../../services/audit-log' (opens the app DB pool)
// and '../../middleware/auth' (JWT and tenant context), and use extensionless relative
// imports that Node's ESM loader cannot resolve. A loader hook below resolves the
// extensionless imports and swaps those two modules for stand-ins. The requireRole
// stand-in mirrors the real one (admin always passes, otherwise the role must be listed).
const AUDIT_STUB = 'export async function logAuditEvent() {}';
const AUTH_STUB = `
export function requireRole(...roles) {
  return (req, res, next) => {
    if (req.userRole === 'admin' || roles.includes(req.userRole)) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  };
}
export function authenticateToken(req, res, next) { next(); }
`;
const HOOK = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let stubs = [];
export function initialize(data) { stubs = data.stubs; }
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.')) {
    const hit = stubs.find(([suffix]) => specifier.endsWith(suffix));
    if (hit) {
      return { url: 'data:text/javascript,' + encodeURIComponent(hit[1]), format: 'module', shortCircuit: true };
    }
    if (!/\.[cm]?[jt]s$/.test(specifier)) {
      for (const candidate of [specifier + '.ts', specifier + '/index.ts']) {
        const url = new URL(candidate, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(HOOK), import.meta.url, {
  data: {
    stubs: [
      ['/services/audit-log', AUDIT_STUB],
      ['/middleware/auth', AUTH_STUB],
    ],
  },
});

const { createApprovalRouter, APPROVAL_ROUTES } = await import('../../server/modules/approvals/approval-routes.ts');
const { revokeRefusal, resubmitRefusal, buildResubmission } = await import('../../server/modules/approvals/approval-service.ts');

// Route tests use an in-memory stub service that applies the same exported state
// helpers as ApprovalService. No database is involved, so the SQL conditions in
// ApprovalService are not exercised here.

const LIVE = () => new Date(Date.now() + 60 * 60_000);
const PAST = () => new Date(Date.now() - 60_000);
const identity = (p) => p;

function makeRow(overrides = {}) {
  const createdAt = new Date(Date.now() - 120_000);
  return {
    id: 'appr-1',
    companyId: 'co-a',
    requestedBy: 'agent-user-7',
    agentId: 'agent-7',
    action: 'send_refund',
    urgency: 'normal',
    params: { amount: 40, to: 'cust@example.com' },
    context: { paramsSha256: hashAction('send_refund', { amount: 40, to: 'cust@example.com' }) },
    status: 'pending',
    decision: 'route_to_human',
    policyId: null,
    decidedBy: null,
    decisionReason: null,
    expiresAt: LIVE(),
    decidedAt: null,
    executedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

const view = (row) => ({
  id: row.id,
  action: row.action,
  companyId: row.companyId,
  status: row.status,
  decidedBy: row.decidedBy,
  decidedAt: row.decidedAt,
  executedAt: row.executedAt,
  paramsSha256: row.context?.paramsSha256 ?? null,
  params: row.params,
});

/** In-memory stand-in for the parts of ApprovalService the router calls. Scoped by companyId. */
function makeStubService(rows) {
  let seq = 0;
  const find = (companyId, id) => rows.find((r) => r.companyId === companyId && r.id === id);
  return {
    rows,
    async revokeApproval(companyId, id, revokedBy, reason) {
      const row = find(companyId, id);
      if (!row) return { kind: 'not_found' };
      const now = new Date();
      const refusal = revokeRefusal(row, now);
      if (refusal) return { kind: 'refused', status: row.status, executed: row.executedAt !== null, error: refusal };
      Object.assign(row, { status: 'revoked', decidedBy: revokedBy, decidedAt: now, decisionReason: reason ?? null });
      return { kind: 'ok', approval: view(row) };
    },
    async resubmitApproval(companyId, id, params, resubmittedBy) {
      const row = find(companyId, id);
      if (!row) return { kind: 'not_found' };
      const refusal = resubmitRefusal(row.status);
      if (refusal) return { kind: 'refused', status: row.status, executed: row.executedAt !== null, error: refusal };
      const values = buildResubmission(row, params, resubmittedBy, identity, new Date());
      const created = { ...values, id: `new-${++seq}` };
      rows.push(created);
      return { kind: 'ok', approval: view(created) };
    },
  };
}

/** Starts the real router. Sets companyId and identity the way the real middleware would. */
async function startApp({ rows, companyId = 'co-a', userId = 'user-1', userRole = 'manager', service }) {
  const svc = service ?? makeStubService(rows);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.companyId = companyId;
    if (userId !== null) req.userId = userId;
    req.userRole = userRole;
    next();
  });
  app.use('/api/approvals', createApprovalRouter(svc));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    svc,
    close: () => new Promise((resolve) => server.close(resolve)),
    post: (path, body) =>
      fetch(`http://127.0.0.1:${port}/api/approvals${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
  };
}

// -- state helpers ---------------------------------------------------------

test('revokeRefusal: live pending and approved-not-executed rows can be revoked', () => {
  const now = new Date();
  assert.equal(revokeRefusal({ status: 'pending', expiresAt: LIVE(), executedAt: null }, now), null);
  assert.equal(revokeRefusal({ status: 'approved', expiresAt: PAST(), executedAt: null }, now), null);
});

test('revokeRefusal: executed approvals are refused, even though they are approved', () => {
  const reason = revokeRefusal({ status: 'approved', expiresAt: LIVE(), executedAt: new Date() }, new Date());
  assert.match(reason, /already been executed/);
});

test('revokeRefusal: pending past its deadline, rejected, expired and revoked rows are refused', () => {
  const now = new Date();
  for (const status of ['pending', 'rejected', 'expired', 'revoked']) {
    const expiresAt = status === 'pending' ? PAST() : LIVE();
    assert.notEqual(revokeRefusal({ status, expiresAt, executedAt: null }, now), null, status);
  }
});

test('resubmitRefusal: only rejected and expired rows can be resubmitted', () => {
  assert.equal(resubmitRefusal('rejected'), null);
  assert.equal(resubmitRefusal('expired'), null);
  for (const status of ['pending', 'approved', 'revoked']) {
    assert.notEqual(resubmitRefusal(status), null, status);
  }
});

test('buildResubmission: keeps action, company and actor from the old row and rehashes params', () => {
  const old = makeRow({ status: 'rejected' });
  const newParams = { amount: 25, to: 'cust@example.com' };
  const values = buildResubmission(old, newParams, 'user-9', identity, new Date());
  assert.equal(values.status, 'pending');
  assert.equal(values.companyId, old.companyId);
  assert.equal(values.action, old.action);
  assert.equal(values.requestedBy, old.requestedBy);
  assert.equal(values.agentId, old.agentId);
  assert.equal(values.context.paramsSha256, hashAction('send_refund', newParams));
  assert.notEqual(values.context.paramsSha256, old.context.paramsSha256);
  assert.equal(values.context.resubmittedFrom, old.id);
  assert.equal(values.context.resubmittedBy, 'user-9');
  assert.deepEqual(values.params, newParams);
});

test('buildResubmission: does not mutate the old row', () => {
  const old = makeRow({ status: 'expired' });
  const before = structuredClone(old);
  buildResubmission(old, { amount: 1 }, 'user-9', identity, new Date());
  assert.deepEqual(old, before);
});

// -- routes ----------------------------------------------------------------

test('route manifest lists revoke and resubmit as POST routes', () => {
  assert.ok(APPROVAL_ROUTES.some((r) => r.method === 'POST' && r.path === '/:id/revoke'));
  assert.ok(APPROVAL_ROUTES.some((r) => r.method === 'POST' && r.path === '/:id/resubmit'));
});

test('revoke: a pending approval becomes revoked, records the revoker, and cannot be revoked twice', async () => {
  const app = await startApp({ rows: [makeRow()] });
  try {
    const res = await app.post('/appr-1/revoke', { reason: 'wrong amount' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.approval.status, 'revoked');
    assert.equal(body.approval.decidedBy, 'dashboard:user-1');
    assert.ok(app.svc.rows[0].decidedAt instanceof Date);
    assert.equal(app.svc.rows[0].decisionReason, 'wrong amount');

    const again = await app.post('/appr-1/revoke', {});
    assert.equal(again.status, 409);
    assert.equal((await again.json()).status, 'revoked');
  } finally {
    await app.close();
  }
});

test('revoke: an approved approval that has not executed can be revoked', async () => {
  const app = await startApp({ rows: [makeRow({ status: 'approved', decidedBy: 'dashboard:boss-2' })] });
  try {
    const res = await app.post('/appr-1/revoke', {});
    assert.equal(res.status, 200);
    assert.equal((await res.json()).approval.status, 'revoked');
  } finally {
    await app.close();
  }
});

test('revoke: refused after execution with 409 and executed flag', async () => {
  const app = await startApp({ rows: [makeRow({ status: 'approved', executedAt: new Date() })] });
  try {
    const res = await app.post('/appr-1/revoke', {});
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.status, 'approved');
    assert.equal(body.executed, true);
    assert.equal(app.svc.rows[0].status, 'approved');
  } finally {
    await app.close();
  }
});

test('revoke: an agent-role caller gets 403 and the row is untouched', async () => {
  const app = await startApp({ rows: [makeRow()], userRole: 'agent' });
  try {
    const res = await app.post('/appr-1/revoke', {});
    assert.equal(res.status, 403);
    assert.equal(app.svc.rows[0].status, 'pending');
  } finally {
    await app.close();
  }
});

test('revoke: a missing user id gets 401', async () => {
  const app = await startApp({ rows: [makeRow()], userId: null });
  try {
    assert.equal((await app.post('/appr-1/revoke', {})).status, 401);
  } finally {
    await app.close();
  }
});

test('resubmit: a rejected approval gets a new pending approval; the old row is unchanged', async () => {
  const old = makeRow({ status: 'rejected', decidedBy: 'dashboard:boss-2', decidedAt: new Date() });
  const snapshot = structuredClone(old);
  const app = await startApp({ rows: [old] });
  try {
    const newParams = { amount: 25, to: 'cust@example.com' };
    const res = await app.post('/appr-1/resubmit', { params: newParams });
    assert.equal(res.status, 201);
    const { approval } = await res.json();
    assert.equal(approval.status, 'pending');
    assert.notEqual(approval.id, 'appr-1');
    assert.equal(approval.paramsSha256, hashAction('send_refund', newParams));

    const created = app.svc.rows.find((r) => r.id === approval.id);
    assert.equal(created.action, 'send_refund');
    assert.equal(created.companyId, 'co-a');
    assert.equal(created.requestedBy, 'agent-user-7');
    assert.equal(created.agentId, 'agent-7');
    assert.equal(created.context.resubmittedFrom, 'appr-1');
    assert.deepEqual(old, snapshot);
  } finally {
    await app.close();
  }
});

test('resubmit: an expired approval can be resubmitted', async () => {
  const app = await startApp({ rows: [makeRow({ status: 'expired', expiresAt: PAST() })] });
  try {
    const res = await app.post('/appr-1/resubmit', { params: { amount: 10 } });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).approval.status, 'pending');
  } finally {
    await app.close();
  }
});

test('resubmit: refused for an approved approval (409), and no row is created', async () => {
  const app = await startApp({ rows: [makeRow({ status: 'approved', decidedBy: 'dashboard:boss-2' })] });
  try {
    const res = await app.post('/appr-1/resubmit', { params: { amount: 10 } });
    assert.equal(res.status, 409);
    assert.equal((await res.json()).status, 'approved');
    assert.equal(app.svc.rows.length, 1);
  } finally {
    await app.close();
  }
});

test('resubmit: refusing to change the action name (400), and no row is created', async () => {
  const app = await startApp({ rows: [makeRow({ status: 'rejected' })] });
  try {
    const res = await app.post('/appr-1/resubmit', { action: 'delete_all', params: { amount: 10 } });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /action/);
    assert.equal(app.svc.rows.length, 1);
  } finally {
    await app.close();
  }
});

test('resubmit: refusing to change company or actor fields (400)', async () => {
  const app = await startApp({ rows: [makeRow({ status: 'rejected' })] });
  try {
    for (const extra of [{ companyId: 'co-b' }, { company_id: 'co-b' }, { requestedBy: 'someone-else' }, { agentId: 'agent-x' }]) {
      const res = await app.post('/appr-1/resubmit', { params: { amount: 10 }, ...extra });
      assert.equal(res.status, 400, JSON.stringify(extra));
    }
    assert.equal(app.svc.rows.length, 1);
  } finally {
    await app.close();
  }
});

test('resubmit: params must be a plain object', async () => {
  const app = await startApp({ rows: [makeRow({ status: 'rejected' })] });
  try {
    assert.equal((await app.post('/appr-1/resubmit', {})).status, 400);
    assert.equal((await app.post('/appr-1/resubmit', { params: ['x'] })).status, 400);
    assert.equal((await app.post('/appr-1/resubmit', { params: 'x' })).status, 400);
  } finally {
    await app.close();
  }
});

test('company isolation: another company cannot revoke or resubmit, and sees not-found', async () => {
  const rows = [makeRow({ status: 'rejected' }), makeRow({ id: 'appr-2', status: 'pending' })];
  const app = await startApp({ rows, companyId: 'co-b' });
  try {
    const revoke = await app.post('/appr-2/revoke', {});
    assert.equal(revoke.status, 404);
    assert.equal(rows[1].status, 'pending');

    const resubmit = await app.post('/appr-1/resubmit', { params: { amount: 10 } });
    assert.equal(resubmit.status, 404);
    assert.equal(rows.length, 2);
  } finally {
    await app.close();
  }
});

test('company isolation: a company id in the revoke body is ignored; tenant comes from the session', async () => {
  const rows = [makeRow({ status: 'pending' })];
  const app = await startApp({ rows, companyId: 'co-b' });
  try {
    const res = await app.post('/appr-1/revoke', { companyId: 'co-a' });
    // Tenancy comes from res.locals only. The body id is not used, so co-b cannot reach co-a's row.
    assert.equal(res.status, 404);
    assert.equal(rows[0].status, 'pending');
  } finally {
    await app.close();
  }
});

test('invalid approval id is rejected before reaching the service', async () => {
  const app = await startApp({ rows: [makeRow()] });
  try {
    assert.equal((await app.post('/bad%20id/revoke', {})).status, 400);
    assert.equal((await app.post('/bad%20id/resubmit', { params: {} })).status, 400);
  } finally {
    await app.close();
  }
});
