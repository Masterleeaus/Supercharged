import test from 'node:test';
import assert from 'node:assert/strict';
import { canSendFreeForm, decideWhatsAppSend } from '../../server/modules/comms/whatsapp-window.ts';

// Pure logic only. Fixed clock, no network, no database.

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

test('inside the 24-hour window is free-form', () => {
  const lastInboundAt = NOW - 23 * HOUR;
  assert.deepEqual(canSendFreeForm({ lastInboundAt, now: NOW }), { freeForm: true });
  assert.deepEqual(decideWhatsAppSend({ lastInboundAt, now: NOW, templateApproved: false, body: 'hi' }), {
    send: 'free_form',
  });
});

test('exactly 24 hours after the inbound message the window is closed', () => {
  const lastInboundAt = NOW - 24 * HOUR;
  assert.deepEqual(canSendFreeForm({ lastInboundAt, now: NOW }), { freeForm: false, reason: 'window_closed' });
  assert.deepEqual(
    decideWhatsAppSend({ lastInboundAt, now: NOW, templateApproved: true, body: 'hi' }),
    { send: 'template' },
  );
});

test('a missing inbound with an approved template uses the template', () => {
  assert.deepEqual(canSendFreeForm({ lastInboundAt: null, now: NOW }), { freeForm: false, reason: 'no_inbound' });
  assert.deepEqual(
    decideWhatsAppSend({ lastInboundAt: undefined, now: NOW, templateApproved: true, body: 'hi' }),
    { send: 'template' },
  );
});

test('a closed window with no approved template is refused', () => {
  const lastInboundAt = NOW - 30 * HOUR;
  assert.deepEqual(
    decideWhatsAppSend({ lastInboundAt, now: NOW, templateApproved: false, body: 'hi' }),
    { send: 'refuse', reason: 'template_required' },
  );
  assert.deepEqual(
    decideWhatsAppSend({ lastInboundAt: null, now: NOW, templateApproved: false, body: 'hi' }),
    { send: 'refuse', reason: 'template_required' },
  );
});

test('an inbound timestamp in the future is refused as clock_skew', () => {
  const lastInboundAt = NOW + 5 * 60 * 1000;
  assert.deepEqual(canSendFreeForm({ lastInboundAt, now: NOW }), { freeForm: false, reason: 'clock_skew' });
  assert.deepEqual(
    decideWhatsAppSend({ lastInboundAt, now: NOW, templateApproved: true, body: 'hi' }),
    { send: 'refuse', reason: 'clock_skew' },
  );
});

test('Date objects and epoch milliseconds are interchangeable', () => {
  assert.deepEqual(canSendFreeForm({ lastInboundAt: new Date(NOW - HOUR), now: new Date(NOW) }), { freeForm: true });
  assert.deepEqual(canSendFreeForm({ lastInboundAt: NOW - HOUR, now: NOW }), { freeForm: true });
});

test('windowHours is configurable', () => {
  const lastInboundAt = NOW - 5 * HOUR;
  assert.deepEqual(canSendFreeForm({ lastInboundAt, now: NOW, windowHours: 6 }), { freeForm: true });
  assert.deepEqual(canSendFreeForm({ lastInboundAt, now: NOW, windowHours: 4 }), {
    freeForm: false,
    reason: 'window_closed',
  });
});

test('invalid windowHours values are refused', () => {
  const lastInboundAt = NOW - HOUR;
  for (const windowHours of [0, -1, NaN, Infinity, '24', null]) {
    assert.throws(() => canSendFreeForm({ lastInboundAt, now: NOW, windowHours }), TypeError, `windowHours=${String(windowHours)}`);
    assert.throws(
      () => decideWhatsAppSend({ lastInboundAt, now: NOW, templateApproved: true, body: 'hi', windowHours }),
      TypeError,
      `windowHours=${String(windowHours)}`,
    );
  }
});
