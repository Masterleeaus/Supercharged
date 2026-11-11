import test from 'node:test';
import assert from 'node:assert/strict';
import { modeAvailability, MODE_UNAVAILABLE_TEXT } from '../../client/src/lib/mode-capabilities.ts';
test('no mode can be enabled solely by a browser flag', () => {
  for (const selected of ['marketing', 'inbox']) {
    assert.equal(modeAvailability(selected, null, { inbox: true, marketing: true }).available, false);
  }
});
test('each denied state provides an actionable explanation', () => {
  for (const reason of ['mode_unavailable', 'feature_disabled', 'mode_unknown']) {
    assert.ok(MODE_UNAVAILABLE_TEXT[reason].length > 40);
  }
});
