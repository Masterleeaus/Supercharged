// Production pre-send gate: with no durable inbox consent store, every inbox send is refused as
// no_consent, and each block is written to the audit log with its reason. No database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionPreSendGate } from '../../server/modules/comms/production-presend-gate.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const settingsNone = { async getQuietHours() { return { ok: true, settings: null }; } };

test('production gate refuses every inbox send as no_consent until a consent store is wired', async () => {
  const written = [];
  const gate = createProductionPreSendGate({
    write: async (entry) => { written.push(entry); },
    settings: settingsNone,
    now: () => new Date('2026-11-15T10:00:00Z'),
  });
  const decision = await gate.check({ companyId: CO, channel: 'sms', address: '+61400000001', surface: 'inbox', actorId: 'staff-1' });
  assert.deepEqual(decision, { allowed: false, reason: 'no_consent' });
});

test('a block is written to the audit log with its reason, surface and target', async () => {
  const written = [];
  const gate = createProductionPreSendGate({
    write: async (entry) => { written.push(entry); },
    settings: settingsNone,
    now: () => new Date('2026-11-15T10:00:00Z'),
  });
  await gate.recordBlock(
    { companyId: CO, channel: 'sms', surface: 'inbox', actorId: 'staff-1' },
    'no_consent',
    { messageId: 'msg-9', threadId: 'thr-9' },
  );
  assert.equal(written.length, 1);
  const entry = written[0];
  assert.equal(entry.action, 'comms.send_blocked');
  assert.equal(entry.userId, 'staff-1');
  assert.equal(entry.resourceType, 'message');
  assert.equal(entry.resourceId, 'msg-9');
  assert.equal(entry.metadata.companyId, CO);
  assert.equal(entry.metadata.reason, 'no_consent');
  assert.equal(entry.metadata.surface, 'inbox');
  assert.equal(entry.metadata.channel, 'sms');
});

test('construction refuses a gate with no audit writer', () => {
  assert.throws(() => createProductionPreSendGate({ settings: settingsNone }), /audit writer required/);
});
