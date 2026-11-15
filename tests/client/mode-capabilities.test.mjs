import test from 'node:test';
import assert from 'node:assert/strict';
import { modeAvailability } from '../../client/src/lib/mode-capabilities.ts';
const enabled = { inbox: true, marketing: true, chatbot: true };
test('comms host allows both product modes when capabilities are enabled', () => {
  assert.deepEqual(modeAvailability('inbox', 'comms', enabled), { available: true });
  assert.deepEqual(modeAvailability('marketing', 'comms', enabled), { available: true });
});
test('unknown host mode fails closed for both destinations', () => {
  for (const id of ['inbox', 'marketing']) assert.equal(modeAvailability(id, null, enabled).reason, 'mode_unknown');
});
test('workforce host never acquires communications mode via UI flags', () => {
  for (const id of ['inbox', 'marketing']) assert.equal(modeAvailability(id, 'workforce', enabled).reason, 'mode_unavailable');
});
test('disabled inbox capability does not disappear as an unexplained 404', () => {
  assert.equal(modeAvailability('inbox', 'comms', { inbox: false, marketing: true }).reason, 'feature_disabled');
});
test('marketing capability may be disabled independently', () => {
  assert.equal(modeAvailability('marketing', 'comms', { inbox: true, marketing: false }).reason, 'feature_disabled');
});

test('unknown server mode denies both product modes', () => {
  for (const mode of ['marketing','inbox']) assert.equal(modeAvailability(mode,null,enabled).available,false);
});

test('chatbot builder needs its own capability flag and the comms host', () => {
  assert.deepEqual(modeAvailability('chatbot', 'comms', enabled), { available: true });
  assert.equal(modeAvailability('chatbot', 'comms', { ...enabled, chatbot: false }).reason, 'feature_disabled');
  assert.equal(modeAvailability('chatbot', 'workforce', enabled).reason, 'mode_unavailable');
  assert.equal(modeAvailability('chatbot', null, enabled).reason, 'mode_unknown');
});
