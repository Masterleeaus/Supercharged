// Shared comms-router plumbing (node:test). No Express, no database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareCommsRouter,
  bodyOf,
  sendServiceError,
  commsRoute,
} from '../../server/modules/desk-modes/comms-router.ts';

function fakeRes() {
  return {
    statusCode: 200,
    body: undefined,
    sent: false,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.sent = true; },
  };
}

function fakeRouter() {
  const uses = [];
  return { uses, use(h) { uses.push(h); }, get() {}, post() {}, patch() {} };
}

const noop = () => {};
const okGuard = (_req, _res, next) => next();

test('prepareCommsRouter refuses to build without a mode guard', () => {
  assert.throws(
    () => prepareCommsRouter({ router: fakeRouter(), service: {}, scope: () => null }, 'inbox'),
    /modeGuard is required/,
  );
});

test('prepareCommsRouter refuses a missing service, scope resolver or router', () => {
  assert.throws(() => prepareCommsRouter({ router: fakeRouter(), scope: noop, modeGuard: okGuard }, 'x'), /service/);
  assert.throws(() => prepareCommsRouter({ router: fakeRouter(), service: {}, modeGuard: okGuard }, 'x'), /scope/);
  assert.throws(() => prepareCommsRouter({ service: {}, scope: noop, modeGuard: okGuard }, 'x'), /router/);
});

test('prepareCommsRouter refuses to build without requireRole', () => {
  assert.throws(
    () => prepareCommsRouter({ router: fakeRouter(), service: {}, scope: noop, modeGuard: okGuard }, 'x'),
    /requireRole is required/,
  );
});

test('prepareCommsRouter installs the injected guard ahead of the routes', () => {
  const router = fakeRouter();
  const requireRole = () => okGuard;
  const out = prepareCommsRouter({ router, service: {}, scope: noop, modeGuard: okGuard, requireRole }, 'x');
  assert.equal(out, router);
  assert.equal(router.uses.length, 1);
  assert.equal(router.uses[0], okGuard);
});

test('bodyOf strips every company key and keeps the rest', () => {
  const req = { body: { company_id: '22222222-2222-4222-8222-222222222222', companyId: '22222222-2222-4222-8222-222222222222', tenant_id: 't', tenantId: 't', name: 'x' } };
  assert.deepEqual(bodyOf(req), { name: 'x' });
  assert.equal(req.body.company_id, '22222222-2222-4222-8222-222222222222', 'the original body is not mutated');
});

test('bodyOf returns an empty object for missing, null, array and scalar bodies', () => {
  assert.deepEqual(bodyOf({ body: undefined }), {});
  assert.deepEqual(bodyOf({ body: null }), {});
  assert.deepEqual(bodyOf({ body: ['22222222-2222-4222-8222-222222222222'] }), {});
  assert.deepEqual(bodyOf({ body: '22222222-2222-4222-8222-222222222222' }), {});
});

test('sendServiceError maps each domain code to its HTTP status', () => {
  const cases = [
    ['invalid', 400],
    ['not_found', 404],
    ['forbidden', 403],
    ['conflict', 409],
    ['refused', 422],
  ];
  for (const [code, status] of cases) {
    const res = fakeRes();
    const err = Object.assign(new Error(`${code} message`), { code });
    sendServiceError(res, err);
    assert.equal(res.statusCode, status, code);
    assert.deepEqual(res.body, { error: `${code} message` });
  }
});

test('sendServiceError returns a generic 500 for unknown errors and hides their message', () => {
  const res = fakeRes();
  sendServiceError(res, new Error('connection to db-prod-3 refused'));
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { error: 'internal_error' });

  const res2 = fakeRes();
  sendServiceError(res2, Object.assign(new Error('x'), { code: 'ENOENT' }));
  assert.equal(res2.statusCode, 500);
});

test('commsRoute answers 401 and never runs the handler when there is no session', async () => {
  let ran = false;
  const route = commsRoute(() => null, async () => { ran = true; return {}; });
  const res = fakeRes();
  await route({ body: {}, params: {}, query: {} }, res, noop);
  assert.equal(res.statusCode, 401);
  assert.equal(ran, false);
});

test('commsRoute refuses a scope with an empty company id', async () => {
  let ran = false;
  const route = commsRoute(() => ({ companyId: '', actor: { kind: 'human', id: 'u' } }), async () => { ran = true; });
  const res = fakeRes();
  await route({ body: {}, params: {}, query: {} }, res, noop);
  assert.equal(res.statusCode, 401);
  assert.equal(ran, false);
});

test('commsRoute passes the scope to the handler and maps a thrown domain error', async () => {
  const scope = { companyId: '11111111-1111-4111-8111-111111111111', actor: { kind: 'human', id: 'u1' } };
  const ok = commsRoute(() => scope, async (s) => ({ seen: s }), 201);
  const res = fakeRes();
  await ok({ body: {}, params: {}, query: {} }, res, noop);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.body, { seen: scope });

  const failing = commsRoute(() => scope, async () => {
    throw Object.assign(new Error('no such thread'), { code: 'not_found' });
  });
  const res2 = fakeRes();
  await failing({ body: {}, params: {}, query: {} }, res2, noop);
  assert.equal(res2.statusCode, 404);
});
