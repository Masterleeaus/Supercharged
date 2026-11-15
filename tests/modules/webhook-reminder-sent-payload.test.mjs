// Checks that the webhook test payload exists for appointment.reminder_sent and that the event is in the list.
// Run: node --test --experimental-transform-types tests/modules/webhook-reminder-sent-payload.test.mjs
// No network and no database. Reads the source of the test-payload module as text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../server/services/webhook-test-service.ts', import.meta.url), 'utf8');

test('appointment.reminder_sent is a listed webhook event type', () => {
  assert.match(src, /'appointment\.reminder_sent',/);
});

test('appointment.reminder_sent has its own test payload case, not the default', () => {
  const start = src.indexOf("case 'appointment.reminder_sent':");
  assert.ok(start > 0, 'case missing');
  const block = src.slice(start, src.indexOf("case 'form.submitted':", start));
  assert.match(block, /event: 'appointment\.reminder_sent'/);
  assert.match(block, /reminder: \{/);
});
