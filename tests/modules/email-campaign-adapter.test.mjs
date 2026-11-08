// Email campaign adapter tests (node:test). No network, no SMTP. The sender is a recording fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adaptEmailTransportToPort } from '../../server/modules/comms/email-campaign-adapter.ts';
import { createEmailSendTransport } from '../../server/modules/comms/email-send-transport.ts';

// Silence logging: the runner's IPC breaks if a test file writes to stdout.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

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

const CONTENT = { subject: 'Spring offer', body: 'Hello there' };

function recordingTransport(result) {
  const calls = [];
  const transport = {
    async send(companyId, j, content) {
      calls.push({ companyId, job: j, content });
      return typeof result === 'function' ? result(companyId, j, content) : result;
    },
  };
  return { transport, calls };
}

test('success returns the externalId from the transport', async () => {
  const { transport } = recordingTransport({ ok: true, externalId: '<ext-42@campaigns.invalid>' });
  const port = adaptEmailTransportToPort(transport);

  const out = await port.send(CO, job(), CONTENT);

  assert.deepEqual(out, { externalId: '<ext-42@campaigns.invalid>' });
});

test('failed result throws an Error carrying the reason and no address', async () => {
  const { transport } = recordingTransport({
    ok: false,
    reason: 'sender_error',
    detail: `SMTP refused ${ADDRESS}`,
  });
  const port = adaptEmailTransportToPort(transport);

  await assert.rejects(
    () => port.send(CO, job(), CONTENT),
    (err) => {
      assert.ok(err instanceof Error);
      assert.equal(err.message, 'sender_error');
      assert.ok(!err.message.includes(ADDRESS));
      assert.ok(!err.message.includes('jane.doe'));
      return true;
    },
  );
});

test('address never leaks when the real transport fails inside the sender', async () => {
  const sender = async () => {
    throw new Error(`mailbox unavailable for ${ADDRESS}`);
  };
  const port = adaptEmailTransportToPort(createEmailSendTransport({ sender }));

  await assert.rejects(
    () => port.send(CO, job(), CONTENT),
    (err) => {
      assert.equal(err.message, 'sender_error');
      assert.ok(!err.message.includes(ADDRESS));
      assert.ok(!err.message.includes('jane.doe'));
      return true;
    },
  );
});

test('companyId, job and content pass through to the transport unchanged', async () => {
  const { transport, calls } = recordingTransport({ ok: true, externalId: 'ext-1' });
  const port = adaptEmailTransportToPort(transport);
  const j = job();

  await port.send(CO, j, CONTENT);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].companyId, CO);
  assert.equal(calls[0].job, j);
  assert.equal(calls[0].content, CONTENT);
});

test('every transport refusal reason throws with that reason as the message', async () => {
  for (const reason of ['wrong_channel', 'invalid_address', 'sender_error']) {
    const { transport } = recordingTransport({ ok: false, reason });
    const port = adaptEmailTransportToPort(transport);
    await assert.rejects(
      () => port.send(CO, job(), CONTENT),
      (err) => err instanceof Error && err.message === reason,
    );
  }
});

test('onSent receives the Message-ID of a successful send, with company and job', async () => {
  const { transport } = recordingTransport({ ok: true, externalId: '<ext-77@campaigns.invalid>' });
  const seen = [];
  const port = adaptEmailTransportToPort(transport, {
    onSent: (companyId, j, messageId) => {
      seen.push({ companyId, jobId: j.id, messageId });
    },
  });
  const out = await port.send(CO, job(), CONTENT);
  assert.deepEqual(out, { externalId: '<ext-77@campaigns.invalid>' });
  assert.deepEqual(seen, [{ companyId: CO, jobId: 'job-1', messageId: '<ext-77@campaigns.invalid>' }]);
});

test('onSent is not called when the send fails', async () => {
  const { transport } = recordingTransport({ ok: false, reason: 'sender_error' });
  let called = false;
  const port = adaptEmailTransportToPort(transport, { onSent: () => { called = true; } });
  await assert.rejects(() => port.send(CO, job(), CONTENT));
  assert.equal(called, false);
});

test('a failing onSent does not fail the send, so the campaign cannot resend', async () => {
  const { transport, calls } = recordingTransport({ ok: true, externalId: '<ext-88@campaigns.invalid>' });
  const port = adaptEmailTransportToPort(transport, {
    onSent: async () => {
      throw new Error('thread store down');
    },
  });
  const out = await port.send(CO, job(), CONTENT);
  assert.deepEqual(out, { externalId: '<ext-88@campaigns.invalid>' });
  assert.equal(calls.length, 1);
});
