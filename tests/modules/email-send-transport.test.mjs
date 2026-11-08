// Email send transport tests (node:test). No network, no SMTP. The sender is a recording fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmailSendTransport } from '../../server/modules/comms/email-send-transport.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const ADDRESS = 'jane.doe@example.com';

function job(overrides = {}) {
  return {
    companyId: CO,
    id: 'job-1',
    campaignId: 'camp-1',
    stepId: 'step-1',
    contactId: 'contact-1',
    channel: 'email',
    address: ADDRESS,
    status: 'queued',
    skipReason: null,
    inApprovedSet: true,
    approvalId: 'appr-1',
    externalId: null,
    createdAt: new Date('2026-11-01T00:00:00Z'),
    updatedAt: new Date('2026-11-01T00:00:00Z'),
    ...overrides,
  };
}

function recordingSender(impl = async () => ({ success: true, messageId: 'provider-1' })) {
  const calls = [];
  const sender = async (message) => {
    calls.push(message);
    return impl(message);
  };
  return { sender, calls };
}

const CONTENT = { subject: 'Spring offer', body: 'Hello there' };

test('valid email job calls the sender once with the right to and subject', async () => {
  const { sender, calls } = recordingSender();
  const transport = createEmailSendTransport({ sender });

  const result = await transport.send(CO, job(), CONTENT);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, ADDRESS);
  assert.equal(calls[0].subject, 'Spring offer');
  assert.equal(calls[0].text, 'Hello there');
  assert.equal(result.ok, true);
  assert.equal(result.externalId, 'provider-1');
});

test('each send carries a unique Message-ID header', async () => {
  const { sender, calls } = recordingSender();
  const transport = createEmailSendTransport({ sender });

  await transport.send(CO, job(), CONTENT);
  await transport.send(CO, job({ id: 'job-2' }), CONTENT);

  const first = calls[0].headers['Message-ID'];
  const second = calls[1].headers['Message-ID'];
  assert.match(first, /^<[^<>@\s]+@[^<>@\s]+>$/);
  assert.notEqual(first, second);
});

test('wrong channel is refused without calling the sender', async () => {
  const { sender, calls } = recordingSender();
  const transport = createEmailSendTransport({ sender });

  const result = await transport.send(CO, job({ channel: 'sms' }), CONTENT);

  assert.deepEqual(result, { ok: false, reason: 'wrong_channel' });
  assert.equal(calls.length, 0);
});

test('invalid addresses are refused without calling the sender', async () => {
  const { sender, calls } = recordingSender();
  const transport = createEmailSendTransport({ sender });

  for (const address of ['', '   ', 'no-at-sign.example.com', '@example.com', 'jane@', null]) {
    const result = await transport.send(CO, job({ address }), CONTENT);
    assert.deepEqual(result, { ok: false, reason: 'invalid_address' }, `address ${JSON.stringify(address)}`);
  }
  assert.equal(calls.length, 0);
});

test('a sender exception becomes a failed result and does not throw', async () => {
  const { sender, calls } = recordingSender(async () => {
    throw new Error('SMTP connection refused');
  });
  const transport = createEmailSendTransport({ sender });

  const result = await transport.send(CO, job(), CONTENT);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sender_error');
  assert.match(result.detail, /SMTP connection refused/);
  assert.equal(calls.length, 1);
});

test('failure reasons never contain the full recipient address', async () => {
  const leaking = [
    async () => {
      throw new Error(`rejected recipient ${ADDRESS} by policy`);
    },
    async () => ({ success: false, error: `mailbox unavailable: ${ADDRESS}` }),
    async () => ({ success: false, error: `bad address <${ADDRESS}>` }),
  ];

  for (const impl of leaking) {
    const { sender } = recordingSender(impl);
    const transport = createEmailSendTransport({ sender });
    const result = await transport.send(CO, job(), CONTENT);

    assert.equal(result.ok, false);
    const serialised = JSON.stringify(result);
    assert.equal(serialised.includes(ADDRESS), false, serialised);
    assert.equal(serialised.includes('jane.doe'), false, serialised);
    assert.match(serialised, /\*\*\*@example\.com/);
  }
});

test('a sender that reports failure maps to a failed result with a reason', async () => {
  const { sender, calls } = recordingSender(async () => ({ success: false, error: 'SMTP not configured' }));
  const transport = createEmailSendTransport({ sender });

  const result = await transport.send(CO, job(), CONTENT);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'sender_error');
  assert.equal(result.detail, 'SMTP not configured');
  assert.equal(calls.length, 1);
});

test('the sender is called exactly once per send, including on failure', async () => {
  let n = 0;
  const { sender, calls } = recordingSender(async () => {
    n += 1;
    if (n === 2) throw new Error('boom');
    return { success: true };
  });
  const transport = createEmailSendTransport({ sender });

  await transport.send(CO, job({ id: 'a' }), CONTENT);
  await transport.send(CO, job({ id: 'b' }), CONTENT);
  await transport.send(CO, job({ id: 'c' }), CONTENT);

  assert.equal(calls.length, 3);
});
