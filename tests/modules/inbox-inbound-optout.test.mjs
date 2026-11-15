// Inbound STOP and START on the inbox path, and that an opted-out contact receives nothing afterwards
// on either the inbox or the Plivo SMS path. Node test runner, in-memory fakes only: no network,
// no database, no real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createInboxService,
  InboxError,
  InMemoryInboxStore,
  InMemoryApprovalPort,
} from '../../server/modules/inbox/index.ts';
import { SEND_ACTION } from '../../server/modules/inbox/types.ts';
import { STOP_CONFIRMATION, START_CONFIRMATION } from '../../server/modules/inbox/inbound-optout.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';
import { processPlivoInboundSms } from '../../server/modules/comms/sms-inbound-route.ts';
import { createSmsProviderAdapter } from '../../server/modules/comms/sms-provider-adapter.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const PHONE = '+61400000001';
const HUMAN = { kind: 'human', id: 'user-1' };
const AGENT = { kind: 'agent', id: 'agent-7' };
const NOW = Date.parse('2026-11-03T12:00:00Z');

function build({ suppression = createSuppressionList(), failReplies = 0 } = {}) {
  const store = new InMemoryInboxStore();
  const approvals = new InMemoryApprovalPort();
  const replies = [];
  let failures = failReplies;
  const optOutReply = async (reply) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error('transport down');
    }
    replies.push(reply);
  };
  let clock = 0;
  let seq = 0;
  const service = createInboxService({
    store,
    approvals,
    suppression,
    optOutReply,
    now: () => new Date(Date.UTC(2026, 10, 2, 0, 0, clock++)),
    newId: () => `id_${++seq}`,
  });
  return { store, approvals, service, suppression, replies };
}

const inbound = (body, externalId, over = {}) => ({
  channel: 'sms',
  address: PHONE,
  displayName: 'Ada',
  body,
  externalId,
  ...over,
});

const isOptedOut = (suppression, channel = 'sms', companyId = CO_A) =>
  suppression.isSuppressed(companyId, { address: PHONE, channel });

// ---------- inbound keywords on the inbox path ----------

test('inbox: STOP records an unsubscribe, sends the STOP confirmation and still stores the message', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound('STOP', 'ext-stop'));

  assert.equal(r.duplicate, false);
  assert.equal(ctx.suppression.reasonFor(CO_A, { address: PHONE, channel: 'sms' }), 'unsubscribed');
  assert.equal(ctx.replies.length, 1);
  assert.equal(ctx.replies[0].kind, 'stop');
  assert.equal(ctx.replies[0].text, STOP_CONFIRMATION);
  assert.equal(ctx.replies[0].companyId, CO_A);
  assert.equal(ctx.replies[0].address, PHONE);
  assert.equal(ctx.replies[0].channel, 'sms');
  assert.equal(ctx.replies[0].idempotencyKey, `optout|${CO_A}|sms|ext-stop`);
  const messages = await ctx.service.listMessages(CO_A, r.thread.id);
  assert.deepEqual(messages.map((m) => m.body), ['STOP']);
});

test('inbox: START after STOP lifts the unsubscribe and sends the START confirmation', async () => {
  const ctx = build();
  await ctx.service.recordInbound(CO_A, inbound('STOP', 'ext-1'));
  await ctx.service.recordInbound(CO_A, inbound('start', 'ext-2'));

  assert.equal(isOptedOut(ctx.suppression), false);
  assert.deepEqual(ctx.replies.map((r) => r.kind), ['stop', 'start']);
  assert.equal(ctx.replies[1].text, START_CONFIRMATION);
  assert.equal(ctx.replies[1].idempotencyKey, `optout|${CO_A}|sms|ext-2`);
});

test('inbox: START with no opt-out on record changes nothing and sends no reply', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound('START', 'ext-1'));

  assert.equal(r.duplicate, false);
  assert.equal(isOptedOut(ctx.suppression), false);
  assert.equal(ctx.replies.length, 0);
  assert.equal((await ctx.service.listMessages(CO_A, r.thread.id)).length, 1);
});

test('inbox: START does not lift a bounce, and sends no confirmation for it', async () => {
  const ctx = build();
  ctx.suppression.suppress(CO_A, { address: PHONE, channel: 'sms', reason: 'bounce_hard' });
  await ctx.service.recordInbound(CO_A, inbound('START', 'ext-1'));

  assert.equal(ctx.suppression.reasonFor(CO_A, { address: PHONE, channel: 'sms' }), 'bounce_hard');
  assert.equal(ctx.replies.length, 0);
});

test('inbox: only the exact keyword counts; a sentence containing stop is not an opt-out', async () => {
  const ctx = build();
  await ctx.service.recordInbound(CO_A, inbound('Please stop texting me about that', 'ext-1'));
  assert.equal(isOptedOut(ctx.suppression), false);
  assert.equal(ctx.replies.length, 0);

  await ctx.service.recordInbound(CO_A, inbound('  stop  ', 'ext-2'));
  assert.equal(isOptedOut(ctx.suppression), true);
  assert.equal(ctx.replies.length, 1);
});

test('inbox: a redelivered STOP sends one confirmation only', async () => {
  const ctx = build();
  await ctx.service.recordInbound(CO_A, inbound('STOP', 'ext-1'));
  const again = await ctx.service.recordInbound(CO_A, inbound('STOP', 'ext-1'));

  assert.equal(again.duplicate, true);
  assert.equal(ctx.replies.length, 1);
});

test('inbox: when the confirmation cannot be handed over, the delivery fails and the retry completes it', async () => {
  const ctx = build({ failReplies: 1 });
  await assert.rejects(ctx.service.recordInbound(CO_A, inbound('STOP', 'ext-1')), /transport down/);

  // The message was not stored, so the provider's retry is not treated as a duplicate.
  assert.equal(await ctx.store.findMessageByExternalId(CO_A, 'sms', 'ext-1'), null);
  assert.equal(ctx.suppression.reasonFor(CO_A, { address: PHONE, channel: 'sms' }), 'unsubscribed');

  const retry = await ctx.service.recordInbound(CO_A, inbound('STOP', 'ext-1'));
  assert.equal(retry.duplicate, false);
  assert.deepEqual(ctx.replies.map((r) => r.kind), ['stop']);
});

test('inbox: opt-out is per channel, so an SMS STOP does not block WhatsApp to the same number', async () => {
  const ctx = build();
  await ctx.service.recordInbound(CO_A, inbound('STOP', 'ext-1'));
  const wa = await ctx.service.recordInbound(CO_A, inbound('hello', 'wa-1', { channel: 'whatsapp' }));
  const sent = await ctx.service.sendAsStaff(CO_A, HUMAN, wa.thread.id, 'Hello');

  assert.equal(sent.status, 'queued');
});

test('inbox: a STOP for company A does not block company B', async () => {
  const ctx = build();
  await ctx.service.recordInbound(CO_A, inbound('STOP', 'a-1'));
  const rB = await ctx.service.recordInbound(CO_B, inbound('hi', 'b-1'));
  const sent = await ctx.service.sendAsStaff(CO_B, HUMAN, rB.thread.id, 'Hello');

  assert.equal(sent.status, 'queued');
});

test('inbox: a suppression list without an opt-out reply sender is refused at construction', () => {
  assert.throws(
    () =>
      createInboxService({
        store: new InMemoryInboxStore(),
        approvals: new InMemoryApprovalPort(),
        suppression: createSuppressionList(),
      }),
    RangeError,
  );
});

// ---------- an opted-out contact receives nothing afterwards (inbox path) ----------

test('inbox: after STOP a staff send to that contact is refused and nothing is queued', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound('STOP', 'ext-1'));

  await assert.rejects(
    ctx.service.sendAsStaff(CO_A, HUMAN, r.thread.id, 'Hello'),
    (err) => err instanceof InboxError && err.code === 'forbidden',
  );
  const outbound = (await ctx.service.listMessages(CO_A, r.thread.id)).filter((m) => m.direction === 'outbound');
  assert.equal(outbound.length, 0);
});

test('inbox: after STOP an agent draft is refused before the approval gate is asked', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound('hi', 'ext-1'));
  await ctx.service.assignThread(CO_A, AGENT, r.thread.id, { kind: 'agent', id: AGENT.id });
  const draft = await ctx.service.createDraft(CO_A, AGENT, r.thread.id, 'Your booking is confirmed');
  await ctx.service.recordInbound(CO_A, inbound('STOP', 'ext-2'));

  await assert.rejects(ctx.service.requestSend(CO_A, AGENT, draft.id), /opted out/);
  assert.equal(ctx.approvals.requests.length, 0);
});

test('inbox: an approval granted after STOP is not executed; the message is rejected and never claimed', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound('hi', 'ext-1'));
  await ctx.service.assignThread(CO_A, AGENT, r.thread.id, { kind: 'agent', id: AGENT.id });
  const draft = await ctx.service.createDraft(CO_A, AGENT, r.thread.id, 'Your booking is confirmed');

  ctx.approvals.nextState = 'pending';
  const awaiting = await ctx.service.requestSend(CO_A, AGENT, draft.id);
  assert.equal(awaiting.status, 'awaiting_approval');

  await ctx.service.recordInbound(CO_A, inbound('STOP', 'ext-2'));

  // The approval is now granted. Serve that decision for the stored request.
  const params = ctx.approvals.requests[0].params;
  ctx.approvals.getApproval = async (companyId, id) =>
    id === awaiting.approvalId ? { id, action: SEND_ACTION, params, status: 'approved' } : null;
  let claims = 0;
  const realMarkExecuted = ctx.approvals.markExecuted.bind(ctx.approvals);
  ctx.approvals.markExecuted = async (...args) => {
    claims += 1;
    return realMarkExecuted(...args);
  };

  const result = await ctx.service.applyApprovalDecision(CO_A, draft.id);
  assert.equal(result.status, 'rejected');
  assert.equal(claims, 0);
});

test('inbox: after START the same contact can be sent to again', async () => {
  const ctx = build();
  const r = await ctx.service.recordInbound(CO_A, inbound('STOP', 'ext-1'));
  await ctx.service.recordInbound(CO_A, inbound('START', 'ext-2'));
  const sent = await ctx.service.sendAsStaff(CO_A, HUMAN, r.thread.id, 'Back again');

  assert.equal(sent.status, 'queued');
});

// ---------- the Plivo SMS path and the shared suppression list ----------

const fakeHttp = (response) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return response(url, init);
  };
  return { calls, fn };
};

const okPlivo = () => ({ ok: true, status: 202, json: async () => ({ message_uuid: ['SM-1'] }) });

function smsAdapter({ suppression, http }) {
  return createSmsProviderAdapter({
    accountId: 'AC0123456789abcdef',
    authToken: 'sms-secret-token',
    fromNumber: '+61499999999',
    http,
    resolveCompany: async () => ({ quietHours: null }),
    resolveContact: async () => ({
      handles: { phone: PHONE },
      consents: [{ channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
      timezone: 'UTC',
    }),
    now: () => NOW,
    suppression,
  });
}

function plivoDeps(suppression) {
  return {
    resolveCompanyForNumber: async () => CO_A,
    messages: {
      lookupDeliveryStatus: async () => {
        throw new Error('not used by inbound');
      },
      compareAndSetDeliveryStatus: async () => {
        throw new Error('not used by inbound');
      },
    },
    contacts: {
      findByPhone: async (companyId, phone) =>
        companyId === CO_A && phone === PHONE ? { id: 'contact-1', contact: { handles: { phone: PHONE }, consents: [] } } : null,
      appendConsentEvent: async () => true,
    },
    suppression,
  };
}

const plivoInbound = (text, messageUuid) => ({ MessageUUID: messageUuid, To: '61499999999', From: '61400000001', Text: text });

test('SMS route: STOP stops an SMS adapter send, and START lets it through again', async () => {
  const suppression = createSuppressionList();
  const http = fakeHttp(okPlivo);
  const adapter = smsAdapter({ suppression, http: http.fn });

  const stop = await processPlivoInboundSms(plivoDeps(suppression), plivoInbound('STOP', 'IN-1'));
  assert.equal(stop.code, 200);
  assert.deepEqual(await adapter.send({ companyId: CO_A, to: PHONE, body: 'Hello' }), { ok: false, reason: 'suppressed' });
  assert.equal(http.calls.length, 0);

  const start = await processPlivoInboundSms(plivoDeps(suppression), plivoInbound('START', 'IN-2'));
  assert.equal(start.code, 200);
  const sent = await adapter.send({ companyId: CO_A, to: PHONE, body: 'Back again' });
  assert.equal(sent.ok, true);
  assert.equal(http.calls.length, 1);
});

test('shared list: STOP on the SMS route blocks an inbox send to the same number, and START on the inbox lifts it', async () => {
  const suppression = createSuppressionList();
  const ctx = build({ suppression });
  const r = await ctx.service.recordInbound(CO_A, inbound('hi', 'ext-1'));

  const stop = await processPlivoInboundSms(plivoDeps(suppression), plivoInbound('STOP', 'IN-1'));
  assert.equal(stop.code, 200);
  await assert.rejects(ctx.service.sendAsStaff(CO_A, HUMAN, r.thread.id, 'Hello'), /opted out/);

  await ctx.service.recordInbound(CO_A, inbound('START', 'ext-2'));
  const sent = await ctx.service.sendAsStaff(CO_A, HUMAN, r.thread.id, 'Back again');
  assert.equal(sent.status, 'queued');
});

test('shared list: STOP on the inbox stops an SMS adapter send to that number', async () => {
  const suppression = createSuppressionList();
  const ctx = build({ suppression });
  await ctx.service.recordInbound(CO_A, inbound('STOP', 'ext-1'));

  const http = fakeHttp(okPlivo);
  const adapter = smsAdapter({ suppression, http: http.fn });
  assert.deepEqual(await adapter.send({ companyId: CO_A, to: PHONE, body: 'Hello' }), { ok: false, reason: 'suppressed' });
  assert.equal(http.calls.length, 0);
});
