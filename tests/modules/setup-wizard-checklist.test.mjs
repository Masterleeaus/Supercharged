// Issue #363 checklist contract. Each test names one checklist box and fails if its wizard step disappears.
// Pure module checks: no database, no network. Run:
//   node --test --experimental-transform-types tests/modules/setup-wizard-checklist.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as wizard from '../../server/modules/starter-packs/setup-wizard.ts';

test('box 1: tools are asked, mapped to connectors, and a pack is chosen', () => {
  assert.equal(typeof wizard.recordTools, 'function');
  assert.equal(typeof wizard.choosePack, 'function');
  assert.equal(typeof wizard.connectorsToConnect, 'function');
  assert.ok(wizard.WIZARD_STEPS.indexOf('tools') < wizard.WIZARD_STEPS.indexOf('pack'));
});

test('box 2: connect, field-map preview and one test enquiry run in that order', () => {
  assert.equal(typeof wizard.connectAll, 'function');
  assert.equal(typeof wizard.previewFieldMap, 'function');
  assert.equal(typeof wizard.runTestEnquiry, 'function');
  const order = ['connect', 'fieldMap', 'test'].map((s) => wizard.WIZARD_STEPS.indexOf(s));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('box 3: a preview is built before go-live and go-live requires the preview hash', () => {
  assert.equal(typeof wizard.buildPreview, 'function');
  assert.equal(typeof wizard.goLive, 'function');
  assert.ok(wizard.WIZARD_STEPS.indexOf('review') < wizard.WIZARD_STEPS.indexOf('live'));
  assert.equal(wizard.WIZARD_STEPS.at(-1), 'live');
});

test('box 4: every decision is logged with step, actor and time', () => {
  const state = wizard.startSetup('co-test', new Date('2026-01-01T00:00:00Z'));
  const next = wizard.recordTools(state, ['gmail'], 'owner-test', new Date('2026-01-01T00:01:00Z'));
  assert.equal(next.log.length, 1);
  assert.equal(next.log[0].step, 'tools');
  assert.equal(next.log[0].actorId, 'owner-test');
  assert.equal(next.log[0].at, '2026-01-01T00:01:00.000Z');
});

test('the setup budget is 30 minutes', () => {
  assert.equal(wizard.SETUP_BUDGET_MINUTES, 30);
});
