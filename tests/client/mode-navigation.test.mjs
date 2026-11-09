import test from 'node:test';
import assert from 'node:assert/strict';
import { MODE_DESTINATIONS, selectedMode, destinationForMode } from '../../client/src/lib/mode-navigation.ts';
test('both modes have unique, stable deep links', () => {
  assert.deepEqual(MODE_DESTINATIONS.map(x => x.id), ['marketing', 'inbox']);
  assert.equal(new Set(MODE_DESTINATIONS.map(x => x.href)).size, 2);
});
test('reload and route selection derive from URL, not client tenant storage', () => {
  assert.equal(selectedMode('/app/modes/inbox'), 'inbox');
  assert.equal(selectedMode('/app/modes/marketing?tab=flows'), 'marketing');
  assert.equal(selectedMode('/app/chatbot-inbox'), 'inbox');
});
test('unknown navigation mode fails explicitly', () => {
  assert.equal(destinationForMode('inbox').label, 'Omnichannel Inbox');
  assert.throws(() => destinationForMode('not-a-mode'), /Unknown/);
});
