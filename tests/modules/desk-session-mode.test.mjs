/**
 * Tests for server/modules/desk-modes/session-mode.ts and the mode guard on comms modules.
 * Run: node --test --experimental-transform-types tests/modules/desk-session-mode.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Silence logs from imported server code: the test runner uses stdout for its IPC.
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;

const {
  DEFAULT_DESK_MODE_CONFIG,
  sessionDeskMode,
  requireModule,
  isModuleAllowed,
  modulesForMode,
} = await import('../../server/modules/desk-modes/index.ts');
const { buildModeConfig } = await import('../../server/modules/desk-modes/mode-resolver.ts');

const config = buildModeConfig({ workforceHosts: 'superchargedat.work', commsHosts: 'syncedat.work' });

test('the production config maps each host to its own mode', () => {
  assert.deepEqual(sessionDeskMode('superchargedat.work', DEFAULT_DESK_MODE_CONFIG), { mode: 'workforce', source: 'host' });
  assert.deepEqual(sessionDeskMode('syncedat.work', DEFAULT_DESK_MODE_CONFIG), { mode: 'comms', source: 'host' });
});

test('port, case and trailing dot are normalised before the lookup', () => {
  assert.equal(sessionDeskMode('SyncedAt.Work:443', config).mode, 'comms');
  assert.equal(sessionDeskMode('superchargedat.work.', config).mode, 'workforce');
});

test('unknown, missing, empty and malformed hosts get the workforce default', () => {
  for (const host of [undefined, null, '', '   ', 'evil.example', 'syncedat.work.evil.com', 'evilsyncedat.work', 'https://syncedat.work', 'syncedat.work/x']) {
    assert.deepEqual(sessionDeskMode(host, config), { mode: 'workforce', source: 'default' }, String(host));
  }
});

test('a repeated Host header is treated as unknown, not as the first value', () => {
  assert.deepEqual(sessionDeskMode(['syncedat.work'], config), { mode: 'workforce', source: 'default' });
  assert.deepEqual(sessionDeskMode(['syncedat.work', 'evil.example'], config), { mode: 'workforce', source: 'default' });
});

test('the session mode is only ever workforce or comms', () => {
  for (const host of ['syncedat.work', 'superchargedat.work', 'nope.example', undefined]) {
    assert.ok(['workforce', 'comms'].includes(sessionDeskMode(host, config).mode));
  }
});

test('comms modules are refused for the workforce mode and allowed for comms', () => {
  for (const mod of ['inbox', 'campaigns', 'marketing', 'chatbot']) {
    assert.equal(isModuleAllowed('comms', mod), true, mod);
    assert.equal(isModuleAllowed('workforce', mod), false, mod);
  }
});

test('requireModule for a comms module returns 404 on a workforce-mode request before next runs', () => {
  const guard = requireModule('campaigns');
  let nextCalled = false;
  let status = null;
  const res = { status(c) { status = c; return this; }, json() {} };
  guard({ headers: {}, deskMode: 'workforce' }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(status, 404);
});

test('requireModule for a comms module with no mode set fails closed', () => {
  const guard = requireModule('inbox');
  let nextCalled = false;
  let status = null;
  const res = { status(c) { status = c; return this; }, json() {} };
  guard({ headers: {} }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(status, 404);
  assert.ok(!modulesForMode('workforce').includes('inbox'));
});

test('untrusted hosts never produce source host', () => {
  assert.equal(sessionDeskMode('unknown.example', config).source, 'default');
  assert.equal(sessionDeskMode('syncedat.work', config).source, 'host');
});
