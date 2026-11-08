import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModeConfig,
  deskModeMiddleware,
  requireModule,
} from '../../server/modules/desk-modes/index.ts';

const config = buildModeConfig({
  workforceHosts: 'supercharged.at.work',
  commsHosts: 'syncedat.work',
});

function fakeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; },
  };
  return res;
}

function run(mw, req) {
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; });
  return { req, res, nextCalled };
}

test('workforce host sets deskMode to workforce and calls next', () => {
  const mw = deskModeMiddleware(config);
  const { req, nextCalled } = run(mw, { headers: { host: 'supercharged.at.work' } });
  assert.equal(nextCalled, true);
  assert.equal(req.deskMode, 'workforce');
});

test('comms host sets deskMode to comms', () => {
  const mw = deskModeMiddleware(config);
  const { req, nextCalled } = run(mw, { headers: { host: 'syncedat.work:443' } });
  assert.equal(nextCalled, true);
  assert.equal(req.deskMode, 'comms');
});

test('unknown host gets 404 and never reaches next', () => {
  const mw = deskModeMiddleware(config);
  const { res, nextCalled } = run(mw, { headers: { host: 'attacker.example' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 404);
});

test('missing host gets 404', () => {
  const mw = deskModeMiddleware(config);
  const { res, nextCalled } = run(mw, { headers: {} });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 404);
});

test('x-forwarded-host is never used; only Host decides the mode', () => {
  const mw = deskModeMiddleware(config);
  const { req, nextCalled } = run(mw, {
    headers: { host: 'syncedat.work', 'x-forwarded-host': 'supercharged.at.work' },
  });
  assert.equal(nextCalled, true);
  assert.equal(req.deskMode, 'comms');
});

test('a forwarded host alone cannot select a mode', () => {
  const mw = deskModeMiddleware(config);
  const { res, nextCalled } = run(mw, { headers: { 'x-forwarded-host': 'supercharged.at.work' } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 404);
});

test('requireModule lets the right mode through and blocks the other', () => {
  const guard = requireModule('campaigns');
  const comms = { deskMode: 'comms' };
  const workforce = { deskMode: 'workforce' };
  let calledComms = false;
  guard(comms, fakeRes(), () => { calledComms = true; });
  assert.equal(calledComms, true);

  const res = fakeRes();
  let calledWorkforce = false;
  guard(workforce, res, () => { calledWorkforce = true; });
  assert.equal(calledWorkforce, false);
  assert.equal(res.statusCode, 404);
});

test('requireModule blocks a request with no mode set', () => {
  const guard = requireModule('workforce-runtime');
  const res = fakeRes();
  let called = false;
  guard({}, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 404);
});
