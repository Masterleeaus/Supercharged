/**
 * Role guard checks for the comms routers (campaigns, inbox, marketing), with fakes only.
 *
 * Each staff-only route (audience export, campaign launch, approvals, send jobs, inbox assignment and status,
 * marketing publication and approval) runs an injected requireRole('admin', 'manager') guard before its service
 * method. Thread reads and staff replies stay open to members. The fake requireRole copies server/middleware/auth.ts:
 * admin always passes, any other role must be listed, and it reads req.userRole.
 *
 * Run: cd /home/claude/desk-review && node --test --experimental-transform-types tests/security/comms-role-guards.test.mjs
 */
for (const method of ['log', 'info', 'warn', 'error']) console[method] = () => {};

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaignsRouter } from '../../server/modules/campaigns/campaigns-router.ts';
import { createInboxRouter } from '../../server/modules/inbox/inbox-router.ts';
import { createMarketingRouter } from '../../server/modules/marketing/marketing-router.ts';

const STAFF = ['admin', 'manager'];
const COMPANY = 'c1';

// Staff-only routes. Each must have a role guard for STAFF ahead of its service call.
const GUARDED = [
  { router: 'campaigns', method: 'post', path: '/audiences', params: {}, body: { name: 'a', channel: 'email' }, what: 'audience definition' },
  { router: 'campaigns', method: 'get', path: '/audiences/:id/resolution', params: { id: 'aud1' }, what: 'audience export' },
  { router: 'campaigns', method: 'post', path: '/contacts', params: {}, body: { channel: 'email', address: 'x@example.test' }, what: 'contact import' },
  { router: 'campaigns', method: 'post', path: '/opt-ins', params: {}, body: { channel: 'email', address: 'x@example.test' }, what: 'consent change' },
  { router: 'campaigns', method: 'post', path: '/unsubscribes', params: {}, body: { channel: 'email', address: 'x@example.test' }, what: 'suppression change' },
  { router: 'campaigns', method: 'post', path: '/campaigns', params: {}, body: { name: 'c', channel: 'email', audienceId: 'aud1' }, what: 'campaign create' },
  { router: 'campaigns', method: 'post', path: '/campaigns/:id/steps', params: { id: 'camp1' }, body: { delayHours: 0, body: 'hi' }, what: 'campaign step edit' },
  { router: 'campaigns', method: 'post', path: '/campaigns/:id/activation', params: { id: 'camp1' }, what: 'campaign launch' },
  { router: 'campaigns', method: 'post', path: '/campaigns/:id/steps/:stepId/send-request', params: { id: 'camp1', stepId: 'st1' }, what: 'send request' },
  { router: 'campaigns', method: 'get', path: '/jobs', params: {}, what: 'send job list' },
  { router: 'inbox', method: 'post', path: '/threads/:id/assignment', params: { id: 't1' }, body: { assignee: null }, what: 'inbox assignment' },
  { router: 'inbox', method: 'post', path: '/threads/:id/status', params: { id: 't1' }, body: { status: 'closed' }, what: 'inbox status' },
  { router: 'marketing', method: 'post', path: '/pages/:id/publication', params: { id: 'p1' }, what: 'page publication' },
  { router: 'marketing', method: 'post', path: '/pages/:id/archive', params: { id: 'p1' }, what: 'page archive' },
  { router: 'marketing', method: 'post', path: '/content/:id/approval', params: { id: 'k1' }, what: 'content approval' },
  { router: 'marketing', method: 'post', path: '/content/:id/publication', params: { id: 'k1' }, what: 'content publication' },
];

// Open to members on purpose: thread reads and staff replies.
const OPEN = [
  { router: 'inbox', method: 'get', path: '/threads', params: {}, what: 'thread list' },
  { router: 'inbox', method: 'get', path: '/threads/:id', params: { id: 't1' }, what: 'thread read' },
  { router: 'inbox', method: 'get', path: '/threads/:id/messages', params: { id: 't1' }, what: 'thread messages' },
  { router: 'inbox', method: 'post', path: '/threads/:id/drafts', params: { id: 't1' }, body: { body: 'draft' }, what: 'staff draft' },
  { router: 'inbox', method: 'post', path: '/threads/:id/messages', params: { id: 't1' }, body: { body: 'reply' }, what: 'staff reply' },
];

const FACTORIES = { campaigns: createCampaignsRouter, inbox: createInboxRouter, marketing: createMarketingRouter };

/** Records routes and use() handlers the way an Express router holds them. */
function fakeRouter() {
  const uses = [];
  const routes = new Map();
  const add = (method) => (path, ...handlers) => {
    routes.set(`${method} ${path}`, handlers);
    return undefined;
  };
  return {
    router: { use: (h) => uses.push(h), get: add('get'), post: add('post'), patch: add('patch') },
    uses,
    routes,
  };
}

/** requireRole as in server/middleware/auth.ts. Each guard is tagged with the roles it was built for. */
function fakeRequireRole(calls) {
  return (...roles) => {
    calls.push(roles);
    const guard = (req, res, next) => {
      if (req.userRole === 'admin') return next();
      if (!req.userRole || !roles.includes(req.userRole)) {
        res.status(403).json({ error: 'Insufficient permissions' });
        return;
      }
      next();
    };
    guard.roles = roles;
    return guard;
  };
}

function fakeService(serviceCalls) {
  return new Proxy(
    {},
    {
      get: (_target, name) => (...args) => {
        serviceCalls.push({ name: String(name), args });
        return Promise.resolve({ ok: true });
      },
    },
  );
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    },
  };
}

/** Runs handlers in order. A handler that does not call next ends the chain. */
async function dispatch(handlers, req, res) {
  for (const h of handlers) {
    let advanced = false;
    await h(req, res, () => {
      advanced = true;
    });
    if (!advanced) return;
  }
}

function build(routerName, roleCalls, serviceCalls, { requireRole = fakeRequireRole(roleCalls) } = {}) {
  const fr = fakeRouter();
  FACTORIES[routerName]({
    router: fr.router,
    service: fakeService(serviceCalls),
    scope: () => ({ companyId: COMPANY, actor: { kind: 'human', id: 'u1' } }),
    modeGuard: (_req, _res, next) => next(),
    requireRole,
  });
  return fr;
}

function handlersFor(fr, row) {
  const own = fr.routes.get(`${row.method} ${row.path}`);
  if (!own) throw new Error(`route not registered: ${row.method} ${row.path}`);
  return { all: [...fr.uses, ...own], own };
}

function requestFor(row, role, extraBody = {}) {
  return {
    method: row.method.toUpperCase(),
    path: row.path,
    params: row.params,
    query: {},
    headers: {},
    body: { ...(row.body ?? {}), ...extraBody },
    userRole: role,
  };
}

for (const row of GUARDED) {
  const label = `${row.router} ${row.method.toUpperCase()} ${row.path} (${row.what})`;

  test(`${label}: carries a requireRole guard for admin and manager`, () => {
    const fr = build(row.router, [], []);
    const { own } = handlersFor(fr, row);
    assert.ok(
      own.some((h) => Array.isArray(h.roles) && h.roles.length === STAFF.length && STAFF.every((r) => h.roles.includes(r))),
      'no requireRole(admin, manager) guard ahead of the service call',
    );
  });

  test(`${label}: a member gets 403 and the service is not called`, async () => {
    const serviceCalls = [];
    const fr = build(row.router, [], serviceCalls);
    const res = fakeResponse();
    await dispatch(handlersFor(fr, row).all, requestFor(row, 'member'), res);
    assert.equal(res.statusCode, 403);
    assert.equal(serviceCalls.length, 0);
  });

  test(`${label}: a manager passes and the service sees the session company only`, async () => {
    const serviceCalls = [];
    const fr = build(row.router, [], serviceCalls);
    const res = fakeResponse();
    await dispatch(handlersFor(fr, row).all, requestFor(row, 'manager', { companyId: 'evil' }), res);
    assert.ok(res.statusCode < 400, `expected success, got ${res.statusCode}`);
    assert.equal(serviceCalls.length, 1);
    assert.equal(serviceCalls[0].args[0], COMPANY);
  });
}

for (const row of OPEN) {
  test(`${row.router} ${row.method.toUpperCase()} ${row.path} (${row.what}): open to a member, no role guard`, async () => {
    const serviceCalls = [];
    const fr = build(row.router, [], serviceCalls);
    const { own } = handlersFor(fr, row);
    assert.equal(own.some((h) => Array.isArray(h.roles)), false);
    const res = fakeResponse();
    await dispatch(handlersFor(fr, row).all, requestFor(row, 'member'), res);
    assert.ok(res.statusCode < 400, `expected success, got ${res.statusCode}`);
    assert.equal(serviceCalls.length, 1);
  });
}

test('each comms router refuses to build without requireRole (fail closed)', () => {
  for (const name of Object.keys(FACTORIES)) {
    const fr = fakeRouter();
    assert.throws(
      () =>
        FACTORIES[name]({
          router: fr.router,
          service: fakeService([]),
          scope: () => ({ companyId: COMPANY, actor: { kind: 'human', id: 'u1' } }),
          modeGuard: (_req, _res, next) => next(),
        }),
      /requireRole is required/,
      name,
    );
  }
});

test('the campaigns router builds its guard with exactly admin and manager', () => {
  const roleCalls = [];
  build('campaigns', roleCalls, []);
  assert.ok(roleCalls.length >= 1);
  for (const roles of roleCalls) assert.deepEqual(roles, STAFF);
});
