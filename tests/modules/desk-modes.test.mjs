import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildModeConfig,
  normaliseHost,
  resolveDeskMode,
  modulesForMode,
  isModuleAllowed,
  exclusiveModules,
  SHARED_MODULES,
} from '../../server/modules/desk-modes/index.ts';

const config = buildModeConfig({
  workforceHosts: 'supercharged.at.work,www.supercharged.at.work',
  commsHosts: 'syncedat.work,www.syncedat.work',
});

test('workforce host resolves to workforce mode', () => {
  const r = resolveDeskMode('supercharged.at.work', config);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'workforce');
});

test('comms host resolves to comms mode', () => {
  const r = resolveDeskMode('syncedat.work', config);
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'comms');
});

test('host is case-insensitive, strips port and trailing dot', () => {
  assert.equal(resolveDeskMode('SyncedAt.Work:443', config).mode, 'comms');
  assert.equal(resolveDeskMode('supercharged.at.work.', config).mode, 'workforce');
});

test('unknown host fails closed with no mode', () => {
  const r = resolveDeskMode('evil.example.com', config);
  assert.deepEqual(r, { ok: false, reason: 'unknown_host' });
});

test('missing host is rejected', () => {
  assert.equal(resolveDeskMode(undefined, config).reason, 'missing_host');
  assert.equal(resolveDeskMode('   ', config).reason, 'missing_host');
});

test('malformed host strings are rejected before any lookup', () => {
  for (const bad of [
    'https://syncedat.work',
    'syncedat.work/path',
    'user@syncedat.work',
    'syncedat .work',
    'syncedat.work\r\nX-Injected: 1',
    'a'.repeat(300),
  ]) {
    assert.equal(resolveDeskMode(bad, config).reason, 'malformed_host', bad);
  }
});

test('a host cannot match by being a suffix or prefix of a configured host', () => {
  assert.equal(resolveDeskMode('evilsyncedat.work', config).reason, 'unknown_host');
  assert.equal(resolveDeskMode('syncedat.work.evil.com', config).reason, 'unknown_host');
});

test('a host listed for both modes is a startup error', () => {
  assert.throws(
    () => buildModeConfig({ workforceHosts: 'x.example', commsHosts: 'x.example' }),
    /both modes/,
  );
});

test('each mode needs at least one host', () => {
  assert.throws(() => buildModeConfig({ workforceHosts: '', commsHosts: 'y.example' }));
  assert.throws(() => buildModeConfig({ workforceHosts: 'x.example' }));
});

test('an invalid configured host is a startup error', () => {
  assert.throws(
    () => buildModeConfig({ workforceHosts: 'https://x.example', commsHosts: 'y.example' }),
    /invalid configured host/,
  );
});

test('normaliseHost returns null for non-strings', () => {
  assert.equal(normaliseHost(42), null);
  assert.equal(normaliseHost(null), null);
});

test('each mode mounts its own exclusive modules', () => {
  assert.ok(exclusiveModules('workforce').includes('workforce-runtime'));
  assert.ok(exclusiveModules('comms').includes('campaigns'));
  assert.equal(exclusiveModules('workforce').includes('campaigns'), false);
  assert.equal(exclusiveModules('comms').includes('workforce-runtime'), false);
});

test('shared modules are mounted in both modes', () => {
  for (const mode of ['workforce', 'comms']) {
    for (const m of SHARED_MODULES) {
      assert.ok(modulesForMode(mode).includes(m), `${mode} missing ${m}`);
    }
  }
});

test('workforce mode cannot mount comms modules and comms cannot mount workforce ones', () => {
  assert.equal(isModuleAllowed('workforce', 'inbox'), false);
  assert.equal(isModuleAllowed('workforce', 'chatbot'), false);
  assert.equal(isModuleAllowed('comms', 'workforce-runtime'), false);
  assert.equal(isModuleAllowed('comms', 'agent-embed'), false);
});

test('no module name appears twice within a mode', () => {
  for (const mode of ['workforce', 'comms']) {
    const list = modulesForMode(mode);
    assert.equal(new Set(list).size, list.length, mode);
  }
});

test('illegal numeric host ports are refused rather than silently stripped', () => {
  for (const host of ['syncedat.work:0','syncedat.work:65536','syncedat.work:99999']) {
    assert.equal(normaliseHost(host),null);
    assert.equal(resolveDeskMode(host,config).reason,'malformed_host');
  }
  assert.equal(resolveDeskMode('syncedat.work:65535',config).mode,'comms');
});

test('DNS labels respect length and hyphen boundaries',()=>{
  for(const bad of ['-bad.test','bad-.test','a'.repeat(64)+'.test']) assert.equal(normaliseHost(bad),null,bad);
  assert.equal(normaliseHost('a'.repeat(63)+'.test'),'a'.repeat(63)+'.test');
});
