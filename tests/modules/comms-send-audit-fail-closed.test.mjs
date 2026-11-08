// Send audit fail-closed behaviour for the five provider adapters (node:test).
// Fakes only: an in-memory audit sink, a counting provider stub. No database, no network, no real provider.
// Console is silenced because the modules are server code and the test runner's IPC must stay clean.
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommsAuditSink } from '../../server/modules/comms/audit-sink.ts';
import { createSmsProviderAdapter } from '../../server/modules/comms/sms-provider-adapter.ts';
import { createTelegramProviderAdapter } from '../../server/modules/comms/telegram-provider-adapter.ts';
import { createWhatsAppProviderAdapter } from '../../server/modules/comms/whatsapp-provider-adapter.ts';
import { createEmailProviderAdapter } from '../../server/modules/comms/email-provider-adapter.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';
import { sendMessengerReply } from '../../server/modules/comms/messenger-provider-adapter.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'user_42';
const HOUR = 60 * 60 * 1000;
const NOW_MS = Date.parse('2026-11-03T12:00:00Z');
const SMS_PHONE = '+61400000000';
const WA_TO = '+61400000000';
const EMAIL_ADDRESS = 'jane.doe@example.com';
const RID = '1234567890';

const tgConsented = {
  handles: { telegram: '98765' },
  consents: [{ channel: 'telegram', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
};
const waContact = {
  handles: { phone: WA_TO },
  consents: [{ channel: 'whatsapp', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
};
const smsContact = {
  handles: { phone: SMS_PHONE },
  consents: [{ channel: 'sms', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
  timezone: 'UTC',
};
const emailContact = {
  handles: { email: EMAIL_ADDRESS },
  consents: [{ channel: 'email', action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
};

/**
 * One shared trace for audit writes and provider calls, so the order is visible.
 * failAt is the 0-based audit write index that fails (0 = pending, 1 = outcome). -1 means none fail.
 * mode 'throw' fails synchronously, 'reject' fails as a rejected promise.
 */
function makeTrace({ failAt = -1, mode = 'reject' } = {}) {
  const trace = [];
  const events = [];
  let writes = 0;
  const sink = (entry) => {
    const index = writes++;
    events.push(entry);
    trace.push(index === 0 ? 'audit:pending' : 'audit:outcome');
    if (index === failAt) {
      if (mode === 'throw') throw new Error('database unavailable');
      return Promise.reject(new Error('database unavailable'));
    }
    return Promise.resolve();
  };
  const hit = () => {
    trace.push('provider');
  };
  return { trace, events, sink, hit };
}

/** Resolves to { value } or { thrown } so a throwing refusal and a returned refusal read the same way. */
async function settle(promise) {
  try {
    return { value: await promise };
  } catch (thrown) {
    return { thrown };
  }
}

// Each case: run(sink, hit) sends one message through the adapter, and refusalOf(outcome) reads its refusal code.
const CASES = [
  {
    name: 'sms',
    run: (sink, hit) =>
      createSmsProviderAdapter({
        accountId: 'AC0123456789abcdef',
        authToken: 'FAKE-AUTH-TOKEN',
        fromNumber: '+61499999999',
        http: async () => {
          hit();
          return { ok: true, status: 201, json: async () => ({ message_uuid: ['SM123'] }) };
        },
        resolveCompany: async () => ({ quietHours: null }),
        resolveContact: async () => smsContact,
        now: () => NOW_MS,
        auditSink: sink,
      }).send({ companyId: CO, actorId: ACTOR, to: SMS_PHONE, body: 'Hello' }),
    refusalOf: (o) => o.value?.reason,
  },
  {
    name: 'telegram',
    run: (sink, hit) =>
      createTelegramProviderAdapter({
        token: '123456:FAKE-TOKEN-VALUE',
        auditSink: sink,
        http: {
          async post() {
            hit();
            return { ok: true, result: { message_id: 42 } };
          },
        },
      }).send({
        companyId: CO,
        actorId: ACTOR,
        contact: tgConsented,
        chatId: '98765',
        text: 'See you Tuesday',
        now: '2026-11-03T10:00:00Z',
      }),
    refusalOf: (o) => o.thrown?.reason,
  },
  {
    name: 'whatsapp',
    run: (sink, hit) =>
      createWhatsAppProviderAdapter({
        phoneNumberId: '555000111',
        accessToken: 'EAAG-FAKE-TOKEN',
        company: 'Clean Smart',
        companyId: CO,
        auditSink: sink,
        http: async () => {
          hit();
          return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.T1' }] }) };
        },
      }).send({
        to: WA_TO,
        contact: waContact,
        now: NOW_MS,
        lastInboundAt: NOW_MS - 2 * HOUR,
        text: 'See you Tuesday',
        actorId: ACTOR,
      }),
    refusalOf: (o) => o.value?.reason,
  },
  {
    name: 'email',
    run: (sink, hit) =>
      createEmailProviderAdapter({
        companyId: CO,
        suppression: createSuppressionList(),
        loadContact: async () => emailContact,
        buildUnsubscribeUrl: () => 'https://app.example.com/unsubscribe/token-abc',
        base: async () => {
          hit();
          return { success: true, messageId: 'em_1' };
        },
        now: () => new Date(NOW_MS),
        auditSink: sink,
        actorId: ACTOR,
      })({ to: EMAIL_ADDRESS, subject: 'Hi', text: 'Hello', html: '<p>Hello</p>' }),
    refusalOf: (o) => o.value?.error,
  },
  {
    name: 'messenger',
    run: (sink, hit) =>
      sendMessengerReply({
        accessToken: 'EAAG-FAKE-TOKEN',
        recipientId: RID,
        text: 'Hello',
        contact: { handles: { messenger: RID }, consents: [] },
        lastInboundAt: NOW_MS - HOUR,
        now: NOW_MS,
        http: {
          async post() {
            hit();
            return { message_id: 'm_1' };
          },
        },
        companyId: CO,
        actorId: ACTOR,
        auditSink: sink,
      }),
    refusalOf: (o) => o.value?.reason,
  },
];

for (const c of CASES) {
  test(`${c.name}: a failed pending audit write refuses the send and the provider is never called`, async () => {
    const t = makeTrace({ failAt: 0 });
    const outcome = await settle(c.run(t.sink, t.hit));
    assert.equal(t.trace.includes('provider'), false, 'provider must not be called');
    assert.equal(c.refusalOf(outcome), 'audit_unavailable');
    // Telegram refuses by throwing, so only the returned-refusal adapters carry the field.
    if (c.name !== 'telegram') assert.equal(outcome.value.auditRecorded, false);
  });

  test(`${c.name}: a synchronously throwing pending write also blocks the provider call`, async () => {
    const t = makeTrace({ failAt: 0, mode: 'throw' });
    const outcome = await settle(c.run(t.sink, t.hit));
    assert.equal(t.trace.includes('provider'), false);
    assert.equal(c.refusalOf(outcome), 'audit_unavailable');
  });

  test(`${c.name}: pending is written before the provider, and a failed outcome write is reported, not swallowed`, async () => {
    const t = makeTrace({ failAt: 1 });
    const outcome = await settle(c.run(t.sink, t.hit));
    assert.deepEqual(t.trace, ['audit:pending', 'provider', 'audit:outcome']);
    assert.equal(outcome.value.auditRecorded, false);
    assert.equal(outcome.value.auditError, 'post_send_write_failed');
    // The send result itself is still returned to the caller.
    assert.ok(outcome.value.ok === true || outcome.value.success === true, 'the send result is kept');
  });

  test(`${c.name}: both writes succeed, so auditRecorded is true and the order is pending, provider, outcome`, async () => {
    const t = makeTrace();
    const outcome = await settle(c.run(t.sink, t.hit));
    assert.deepEqual(t.trace, ['audit:pending', 'provider', 'audit:outcome']);
    assert.equal(outcome.value.auditRecorded, true);
    assert.equal(outcome.value.auditError, undefined);
    assert.equal(t.events.length, 2);
    assert.equal(t.events[0].target.id, t.events[1].target.id, 'both events share one correlation id');
  });
}

test('sms: a provider failure writes an outcome event and reports the provider_error', async () => {
  const t = makeTrace();
  const adapter = createSmsProviderAdapter({
    accountId: 'AC0123456789abcdef',
    authToken: 'FAKE-AUTH-TOKEN',
    fromNumber: '+61499999999',
    http: async () => {
      t.hit();
      return { ok: false, status: 500, json: async () => ({}) };
    },
    resolveCompany: async () => ({ quietHours: null }),
    resolveContact: async () => smsContact,
    now: () => NOW_MS,
    auditSink: t.sink,
  });
  const r = await adapter.send({ companyId: CO, actorId: ACTOR, to: SMS_PHONE, body: 'Hello' });
  assert.deepEqual(t.trace, ['audit:pending', 'provider', 'audit:outcome']);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'provider_error');
  assert.equal(r.auditRecorded, true);
});

test('no sink injected: the send goes out and the result says auditRecorded false', async () => {
  const hits = [];
  const adapter = createSmsProviderAdapter({
    accountId: 'AC0123456789abcdef',
    authToken: 'FAKE-AUTH-TOKEN',
    fromNumber: '+61499999999',
    http: async () => {
      hits.push('provider');
      return { ok: true, status: 201, json: async () => ({ message_uuid: ['SM900'] }) };
    },
    resolveCompany: async () => ({ quietHours: null }),
    resolveContact: async () => smsContact,
    now: () => NOW_MS,
  });
  const r = await adapter.send({ companyId: CO, actorId: ACTOR, to: SMS_PHONE, body: 'Hello' });
  assert.deepEqual(hits, ['provider']);
  assert.deepEqual(r, { ok: true, externalId: 'SM900', auditRecorded: false });
});

test('a sink with no actor cannot build the pending event, so the send is refused', async () => {
  const t = makeTrace();
  const adapter = createSmsProviderAdapter({
    accountId: 'AC0123456789abcdef',
    authToken: 'FAKE-AUTH-TOKEN',
    fromNumber: '+61499999999',
    http: async () => {
      t.hit();
      return { ok: true, status: 201, json: async () => ({ message_uuid: ['SM901'] }) };
    },
    resolveCompany: async () => ({ quietHours: null }),
    resolveContact: async () => smsContact,
    now: () => NOW_MS,
    auditSink: t.sink,
  });
  const r = await adapter.send({ companyId: CO, to: SMS_PHONE, body: 'Hello' });
  assert.equal(r.reason, 'audit_unavailable');
  assert.equal(t.trace.includes('provider'), false);
});

test('durable sink: the awaited write rejects when the writer fails, so a send gate can see it', async () => {
  const sink = createCommsAuditSink({
    retryDelayMs: 1,
    write: async () => {
      throw new Error('database unavailable');
    },
  });
  const durable = sink.forCompanyDurable(CO);
  await assert.rejects(durable({
    action: 'comms.message_sent',
    companyId: CO,
    actorId: ACTOR,
    at: '2026-11-03T12:00:00.000Z',
    target: { type: 'message', id: 'c1' },
    detail: { channel: 'sms', status: 'pending' },
  }));
});

test('event shape: the pending and sent events carry status in detail (needs comms-audit-events allowlist change)', async () => {
  const t = makeTrace();
  await settle(CASES[0].run(t.sink, t.hit));
  assert.equal(t.events[0].detail.status, 'pending');
  assert.equal(t.events[1].detail.status, 'sent');
});
