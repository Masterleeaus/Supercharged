// Production wiring for the campaigns module: createCampaignServiceForProduction and
// createCampaignRouterForProduction. Node test runner, no database, no network except a loopback
// HTTP server for the router checks. The transport is a recording fake and never sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  createCampaignServiceForProduction,
  createCampaignRouterForProduction,
  scopeFromLocals,
  InMemoryCampaignStore,
  InMemoryApprovalPort,
  RecordingSendTransport,
} from '../../server/modules/campaigns/index.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';
import { createCompanySettingsStore } from '../../server/modules/settings/company-settings.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const HUMAN = { kind: 'human', id: 'user-1' };

// Clock reads 00:00:00 UTC on 2026-11-02 and advances one second per read: every read is hour 0 UTC.
function deps(overrides = {}) {
  const store = new InMemoryCampaignStore();
  const approvals = new InMemoryApprovalPort();
  const transport = new RecordingSendTransport();
  const companySettings = createCompanySettingsStore({});
  const suppression = createSuppressionList();
  let seq = 0;
  let clock = 0;
  return {
    store,
    approvals,
    transport,
    companySettings,
    suppression,
    newId: () => `id_${++seq}`,
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)),
    ...overrides,
  };
}

async function queuedJob(service, approvals) {
  const audience = await service.defineAudience(CO_A, { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
  await service.addContact(CO_A, { channel: 'email', address: 'ana@example.com', tags: ['vip'], timezone: 'UTC' });
  await service.recordOptIn(CO_A, { channel: 'email', address: 'ana@example.com', source: 'web form' });
  const campaign = await service.createCampaign(CO_A, { name: 'Spring offer', channel: 'email', audienceId: audience.id });
  const step = await service.addStep(CO_A, campaign.id, { subject: 'Hello', body: 'Spring offer inside.' });
  await service.activateCampaign(CO_A, HUMAN, campaign.id);
  approvals.nextState = 'approved';
  const req = await service.requestSend(CO_A, HUMAN, campaign.id, step.id);
  assert.equal(req.queued, 1);
  const [job] = await service.listJobs(CO_A, { approvalId: req.approvalId });
  return job;
}

// ---- service builder -------------------------------------------------------------------------

test('production service refuses to build without companySettings or suppression', () => {
  const d = deps();
  assert.throws(() => createCampaignServiceForProduction({ ...d, companySettings: undefined }), /companySettings is required/);
  assert.throws(() => createCampaignServiceForProduction({ ...d, suppression: undefined }), /suppression is required/);
  assert.throws(() => createCampaignServiceForProduction({ ...d, transport: undefined }), /transport is required/);
});

test('production service holds a send inside the company quiet hours from companySettings', async () => {
  const d = deps();
  assert.equal(d.companySettings.setQuietHours(CO_A, { startHour: 0, endHour: 6, timezone: 'UTC' }).ok, true);
  const service = createCampaignServiceForProduction(d);
  const job = await queuedJob(service, d.approvals);

  const result = await service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'queued');
  assert.equal(d.transport.calls.length, 0);
});

test('production service sends outside the company quiet hours', async () => {
  const d = deps();
  assert.equal(d.companySettings.setQuietHours(CO_A, { startHour: 12, endHour: 18, timezone: 'UTC' }).ok, true);
  const service = createCampaignServiceForProduction(d);
  const job = await queuedJob(service, d.approvals);

  const result = await service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'sent');
  assert.equal(d.transport.calls.length, 1);
});

test('production service skips a suppressed address at dispatch', async () => {
  const d = deps();
  const service = createCampaignServiceForProduction(d);
  const job = await queuedJob(service, d.approvals);
  d.suppression.suppress(CO_A, { address: 'ana@example.com', channel: 'email', reason: 'bounce_hard' });

  const result = await service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'suppressed');
  assert.equal(d.transport.calls.length, 0);
});

test('an injected consent checker is the one the service uses at dispatch', async () => {
  const d = deps();
  const seen = [];
  const consent = (input) => {
    seen.push(input.channel);
    return { allowed: false, reason: 'opted_out' };
  };
  const service = createCampaignServiceForProduction({ ...d, consent });
  const job = await queuedJob(service, d.approvals);

  const result = await service.dispatchJob(CO_A, job.id);
  assert.equal(result.status, 'skipped');
  assert.equal(result.skipReason, 'opted_out');
  assert.deepEqual(seen, ['email']);
  assert.equal(d.transport.calls.length, 0);
});

// ---- router ----------------------------------------------------------------------------------

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Role guard standing in for authenticate and requireRole (middleware/auth). No role means not signed in: 401.
// Otherwise admin passes and the listed roles pass; anything else is 403.
const requireRoleFake = (...roles) => (req, res, next) => {
  if (!req.userRole) return res.status(401).json({ error: 'Authentication required' });
  if (req.userRole === 'admin' || roles.includes(req.userRole)) return next();
  return res.status(403).json({ error: 'Insufficient permissions' });
};

// Stands in for requireCompanyScope, authenticate and the desk-mode middleware that run ahead of the router.
function testApp(router, { deskMode = 'comms', locals = {}, role } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.deskMode = deskMode;
    if (role !== undefined) req.userRole = role;
    res.locals = { ...locals };
    next();
  });
  app.use('/campaigns', router);
  return app;
}

async function call(server, method, path, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}/campaigns${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

test('production router is an Express router and does not mount anything by itself', () => {
  const router = createCampaignRouterForProduction({ ...deps(), requireRole: requireRoleFake });
  assert.equal(typeof router, 'function');
  assert.ok(Array.isArray(router.stack));
  assert.ok(router.stack.length > 0);
});

test('production router refuses workforce mode with 404 and returns 401 without a session scope', async () => {
  const d = deps();
  const router = createCampaignRouterForProduction({ ...d, requireRole: requireRoleFake });
  const workforce = testApp(router, { deskMode: 'workforce', locals: { companyId: CO_A, actor: HUMAN } });
  const ws = await listen(workforce);
  try {
    const r = await call(ws, 'POST', '/audiences', { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
    assert.equal(r.status, 404);
  } finally {
    ws.close();
  }

  const anon = testApp(router, { locals: {} });
  const as = await listen(anon);
  try {
    const r = await call(as, 'POST', '/audiences', { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
    assert.equal(r.status, 401);
  } finally {
    as.close();
  }
});

test('production router takes company from res.locals, not from the body', async () => {
  const d = deps();
  const router = createCampaignRouterForProduction({ ...d, requireRole: requireRoleFake });
  const server = await listen(testApp(router, { locals: { companyId: CO_A, actor: HUMAN }, role: 'manager' }));
  try {
    const created = await call(server, 'POST', '/audiences', { name: 'VIP', channel: 'email', tagsAll: ['vip'], companyId: CO_B });
    assert.equal(created.status, 201);
    assert.equal(created.json.companyId, CO_A);
  } finally {
    server.close();
  }
});

test('router and worker share one service: a send held by company quiet hours is seen through the router', async () => {
  const d = deps();
  d.companySettings.setQuietHours(CO_A, { startHour: 0, endHour: 6, timezone: 'UTC' });
  const service = createCampaignServiceForProduction(d);
  const router = createCampaignRouterForProduction({ ...d, service, requireRole: requireRoleFake });
  const server = await listen(testApp(router, { locals: { companyId: CO_A, actor: HUMAN }, role: 'manager' }));
  try {
    const audience = await call(server, 'POST', '/audiences', { name: 'VIP', channel: 'email', tagsAll: ['vip'] });
    await service.addContact(CO_A, { channel: 'email', address: 'ana@example.com', tags: ['vip'], timezone: 'UTC' });
    await service.recordOptIn(CO_A, { channel: 'email', address: 'ana@example.com', source: 'web form' });
    const campaign = await call(server, 'POST', '/campaigns', { name: 'Spring', channel: 'email', audienceId: audience.json.id });
    const step = await call(server, 'POST', `/campaigns/${campaign.json.id}/steps`, { subject: 'Hello', body: 'Inside.' });
    await call(server, 'POST', `/campaigns/${campaign.json.id}/activation`);
    d.approvals.nextState = 'approved';
    const req = await call(server, 'POST', `/campaigns/${campaign.json.id}/steps/${step.json.id}/send-request`);
    assert.equal(req.status, 200);
    const jobs = await call(server, 'GET', `/jobs?approvalId=${req.json.approvalId}`);
    assert.equal(jobs.status, 200);
    const [job] = jobs.json;
    const result = await service.dispatchJob(CO_A, job.id);
    assert.equal(result.status, 'queued');
    assert.equal(d.transport.calls.length, 0);
  } finally {
    server.close();
  }
});

test('scopeFromLocals reads only a complete company and actor', () => {
  assert.equal(scopeFromLocals({ locals: {} }), null);
  assert.equal(scopeFromLocals({ locals: { companyId: CO_A } }), null);
  assert.equal(scopeFromLocals({ locals: { companyId: CO_A, actor: { kind: 'robot', id: 'x' } } }), null);
  assert.deepEqual(scopeFromLocals({ locals: { companyId: CO_A, actor: HUMAN } }), { companyId: CO_A, actor: HUMAN });
});
