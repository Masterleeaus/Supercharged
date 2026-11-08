import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapThreadsToInboxItems,
  routeCardGesture,
  mapCampaignResponsesToItems,
} from '../../client/src/components/cockpit/cockpit-logic.ts';

const callRecord = {
  id: 'call-1',
  status: 'completed',
  phoneNumber: '+61400000000',
  callDirection: 'inbound',
  createdAt: '2026-11-01T00:00:00.000Z',
};

const openThread = {
  id: 'th-1',
  channel: 'email',
  subject: 'Quote request',
  status: 'open',
  lastMessageAt: '2026-11-02T09:00:00.000Z',
  createdAt: '2026-11-01T00:00:00.000Z',
};

test('inbox: call records never become inbox cards', () => {
  const out = mapThreadsToInboxItems([callRecord, { ...callRecord, id: 'call-2', status: 'open' }]);
  assert.deepEqual(out, []);
});

test('inbox: a call record mixed with threads leaves only the threads', () => {
  const out = mapThreadsToInboxItems([callRecord, openThread]);
  assert.deepEqual(out.map((i) => i.id), ['thread:th-1']);
  assert.ok(out.every((i) => !i.id.startsWith('call:')));
  assert.ok(out.every((i) => !/\+61|inbound/.test(JSON.stringify(i))));
});

test('inbox: only open threads are shown', () => {
  const out = mapThreadsToInboxItems([
    openThread,
    { ...openThread, id: 'th-2', status: 'closed' },
    { ...openThread, id: 'th-3', status: 'snoozed' },
  ]);
  assert.deepEqual(out.map((i) => i.id), ['thread:th-1']);
});

test('inbox: a thread takes its last message time and its subject as the title', () => {
  const [card] = mapThreadsToInboxItems([openThread]);
  assert.equal(card.createdAt, '2026-11-02T09:00:00.000Z');
  assert.equal(card.title, 'Quote request');
});

test('inbox: a thread without a subject gets a channel title', () => {
  const [card] = mapThreadsToInboxItems([{ ...openThread, subject: null }]);
  assert.equal(card.title, 'email conversation');
});

test('campaign responses: each record becomes a card', () => {
  const out = mapCampaignResponsesToItems([
    { id: 'cr-1', contactName: 'Ana', campaignName: 'Spring', summary: 'Yes please', createdAt: '2026-11-01T00:00:00.000Z' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'campaign-response:cr-1');
  assert.equal(out[0].title, 'Ana replied to Spring');
});

const card = (id, action) => ({
  id,
  kind: 'approval',
  title: id,
  detail: '',
  createdAt: null,
  openHref: null,
  ...(action ? { action } : {}),
});

function recorder() {
  const calls = [];
  return {
    calls,
    handlers: {
      onOpen: (i) => calls.push(['open', i.id]),
      onAction: (i) => calls.push(['action', i.id]),
      onArchive: (i) => calls.push(['archive', i.id]),
    },
  };
}

test('button runs the suggested action through onAction with the item', () => {
  const approve = { kind: 'approve', label: 'Approve and run', approvalId: 'ap-1' };
  const rec = recorder();
  routeCardGesture('button', card('c1', approve), rec.handlers);
  assert.deepEqual(rec.calls, [['action', 'c1']]);
});

test('a button with no action runs nothing', () => {
  const rec = recorder();
  routeCardGesture('button', card('c2'), rec.handlers);
  assert.deepEqual(rec.calls, []);
});

test('a body tap opens the item and never runs the action', () => {
  const rec = recorder();
  routeCardGesture('body', { ...card('c4', { kind: 'approve', label: 'x', approvalId: 'a' }), openHref: '/app/approvals' }, rec.handlers);
  assert.deepEqual(rec.calls, [['open', 'c4']]);
});
