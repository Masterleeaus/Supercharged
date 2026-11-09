import test from 'node:test';
import assert from 'node:assert/strict';
import { parseServerDeskMode, productModeForPath, isCommsHostMode, verifiedServerMode } from '../../client/src/lib/desk-product-mode.ts';
test('server mode accepts only workforce and comms', () => {
  assert.equal(parseServerDeskMode('comms'), 'comms');
  assert.equal(parseServerDeskMode('workforce'), 'workforce');
  assert.equal(parseServerDeskMode('syncedat'), null);
  assert.equal(parseServerDeskMode({ mode: 'comms' }), null);
});
test('marketing and inbox paths resolve to distinct product modes', () => {
  assert.equal(productModeForPath('/app/modes/marketing'), 'marketing');
  assert.equal(productModeForPath('/app/modes/inbox'), 'inbox');
  assert.equal(productModeForPath('/app/chatbot-inbox'), 'inbox');
  assert.equal(productModeForPath('/app/campaigns/123'), 'marketing');
  assert.equal(productModeForPath('/app/settings'), null);
});
test('comms host determination is strict', () => {
  assert.equal(isCommsHostMode('comms'), true);
  assert.equal(isCommsHostMode('workforce'), false);
  assert.equal(isCommsHostMode(null), false);
});

test('only a verified host selects a server mode', () => {
  assert.equal(verifiedServerMode({mode:'comms',source:'host'}), 'comms');
  assert.equal(verifiedServerMode({mode:'comms',source:'default'}), null);
  assert.equal(verifiedServerMode({mode:'comms'}), null);
  assert.equal(verifiedServerMode(null), null);
});
