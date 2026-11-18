import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMemoryScheduleStore,
  saveScheduleOverride,
  loadSchedules,
} from '../../server/modules/marketing/workflows/follow-up-schedule-store.ts';
import { DEFAULT_SCHEDULES } from '../../server/modules/marketing/workflows/follow-up-schedule.ts';

test('schedule store: company with no override gets the defaults', async () => {
  const store = createMemoryScheduleStore();
  const schedules = await loadSchedules(store, 'company-a');
  assert.deepEqual(schedules, DEFAULT_SCHEDULES);
});

test('schedule store: a valid override is saved for that company only', async () => {
  const store = createMemoryScheduleStore();
  const res = await saveScheduleOverride(store, 'company-a', 'invoice', {
    steps: [{ afterHours: 48, kind: 'reminder' }],
    escalateAfterAttempts: 1,
  });
  assert.equal(res.ok, true);
  const a = await loadSchedules(store, 'company-a');
  const b = await loadSchedules(store, 'company-b');
  assert.equal(a.invoice.steps.length, 1);
  assert.equal(a.invoice.escalateAfterAttempts, 1);
  assert.deepEqual(b.invoice, DEFAULT_SCHEDULES.invoice);
});

test('schedule store: an invalid override is rejected and nothing is stored', async () => {
  const store = createMemoryScheduleStore();
  const res = await saveScheduleOverride(store, 'company-a', 'lead', {
    steps: [{ afterHours: 5, kind: 'payment_demand' }],
  });
  assert.equal(res.ok, false);
  assert.ok(res.errors.length >= 1);
  const schedules = await loadSchedules(store, 'company-a');
  assert.deepEqual(schedules.lead, DEFAULT_SCHEDULES.lead);
});

test('schedule store: a missing company id is rejected', async () => {
  const store = createMemoryScheduleStore();
  const res = await saveScheduleOverride(store, '', 'quote', {});
  assert.equal(res.ok, false);
});

test('schedule store: stored overrides are copies, not shared references', async () => {
  const store = createMemoryScheduleStore();
  await saveScheduleOverride(store, 'company-a', 'quote', { escalateAfterAttempts: 2 });
  const first = await store.get('company-a', 'quote');
  first.escalateAfterAttempts = 9;
  const second = await store.get('company-a', 'quote');
  assert.equal(second.escalateAfterAttempts, 2);
});
