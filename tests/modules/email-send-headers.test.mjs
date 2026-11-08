/**
 * Header guarantees on the campaign email send path. These cover only the gaps that
 * tests/services/email-send-headers.test.mjs and the existing transport/adapter tests leave open.
 *
 * Claims checked:
 *   1. The transport hands the sender only the Message-ID header, and no From or Reply-To field.
 *   2. The adapter replaces any caller-supplied List-Unsubscribe with the company unsubscribe URL.
 *   3. sendEmail refuses caller headers that name From, Sender, Reply-To or Subject in any case.
 *   4. sendEmail refuses a bare LF or a NUL byte in a header value, and a non-string value.
 *   5. A refused header never reaches the transporter.
 *
 * email-service.ts imports storage and the logger. A resolve hook swaps both for stubs. No SMTP.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

const HOOK_SOURCE = `
const DATA = (src) => 'data:text/javascript,' + encodeURIComponent(src);

export async function resolve(specifier, context, nextResolve) {
  if (/(^|\\/)storage$/.test(specifier)) {
    return {
      url: DATA('export const storage = { getGlobalSetting: async () => null };'),
      shortCircuit: true,
    };
  }
  if (/(^|\\/)utils\\/logger$/.test(specifier)) {
    return {
      url: DATA('export const logger = { info() {}, warn() {}, error() {}, debug() {} };'),
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
`;

register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE));

const realConsoleLog = console.log;
console.log = () => {};
test.after(() => {
  console.log = realConsoleLog;
});

const nodemailer = (await import('nodemailer')).default;
const { emailService } = await import('../../server/services/email-service.ts');
const { createEmailSendTransport } = await import('../../server/modules/comms/email-send-transport.ts');
const { createEmailProviderAdapter } = await import('../../server/modules/comms/email-provider-adapter.ts');
const { createSuppressionList } = await import('../../server/modules/comms/suppression.ts');

const CO = '11111111-1111-4111-8111-111111111111';
const ADDRESS = 'jane.doe@example.com';
const UNSUB = 'https://app.example.com/unsubscribe/token-abc';
const COMPANY_UNSUB = 'https://app.example.com/unsubscribe/company-token';

/** Points the real service at a stream transport and counts every sendMail call. */
function useCountingTransport() {
  const sent = [];
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const realSend = transport.sendMail.bind(transport);
  transport.sendMail = async (opts) => {
    sent.push(opts);
    return realSend(opts);
  };
  emailService.transporter = transport;
  emailService.smtpConfigured = true;
  emailService.fromAddress = 'noreply@example.com';
  emailService.fromName = 'Test Sender';
  return sent;
}

function transportWith(sender) {
  return createEmailSendTransport({ sender, messageIdDomain: 'campaigns.invalid' });
}

const JOB = {
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
};

test('the transport gives the sender only the Message-ID header and no From or Reply-To field', async () => {
  const seen = [];
  const transport = transportWith(async (message) => {
    seen.push(message);
    return { success: true, messageId: 'p-1' };
  });
  await transport.send(CO, JOB, { subject: 'Offer', body: 'Hi' });

  assert.equal(seen.length, 1);
  assert.deepEqual(Object.keys(seen[0].headers), ['Message-ID']);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['headers', 'subject', 'text', 'to']);
  assert.equal('from' in seen[0], false);
  assert.equal('replyTo' in seen[0], false);
});

test('the adapter replaces a caller-supplied List-Unsubscribe with the company unsubscribe URL', async () => {
  const calls = [];
  const sender = createEmailProviderAdapter({
    companyId: CO,
    suppression: createSuppressionList(),
    loadContact: async () => ({
      handles: { email: ADDRESS },
      consents: [{ channel: 'email', action: 'opt_in', at: '2026-10-01T00:00:00Z', source: 'contact' }],
    }),
    buildUnsubscribeUrl: () => COMPANY_UNSUB,
    base: async (message) => {
      calls.push(message);
      return { success: true, messageId: 'p-2' };
    },
    now: () => new Date('2026-11-03T02:00:00Z'),
  });

  await sender({
    to: ADDRESS,
    subject: 's',
    text: 'hi',
    headers: { 'List-Unsubscribe': `<${UNSUB}>` },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers['List-Unsubscribe'], `<${COMPANY_UNSUB}>`);
});

test('sendEmail refuses caller headers that name From, Sender, Reply-To or Subject in any case', async () => {
  const sent = useCountingTransport();
  const names = ['From', 'from', 'FROM', 'Sender', 'Reply-To', 'reply-to', 'Subject', 'subject'];
  for (const name of names) {
    const result = await emailService.sendEmail(ADDRESS, 'x', '<p>x</p>', undefined, {
      headers: { [name]: 'attacker@example.com' },
    });
    assert.equal(result.success, false, name);
    assert.match(result.error, /not allowed/, name);
  }
  assert.equal(sent.length, 0);
});

test('sendEmail refuses a bare LF or a NUL byte in a header value', async () => {
  const sent = useCountingTransport();
  const values = ['<https://x.example/u>\nBcc: attacker@example.com', `<https://x.example/u>\0`];
  for (const value of values) {
    const result = await emailService.sendEmail(ADDRESS, 'x', '<p>x</p>', undefined, {
      headers: { 'List-Unsubscribe': value },
    });
    assert.equal(result.success, false);
    assert.match(result.error, /Invalid value for custom email header/);
  }
  assert.equal(sent.length, 0);
});

test('sendEmail refuses a non-string header value and a non-object header map', async () => {
  const sent = useCountingTransport();
  const badValues = [42, null, ['a'], { nested: 'x' }];
  for (const value of badValues) {
    const result = await emailService.sendEmail(ADDRESS, 'x', '<p>x</p>', undefined, {
      headers: { 'X-Test': value },
    });
    assert.equal(result.success, false, JSON.stringify(value));
  }
  const notAnObject = await emailService.sendEmail(ADDRESS, 'x', '<p>x</p>', undefined, {
    headers: ['X-Test: v'],
  });
  assert.equal(notAnObject.success, false);
  assert.match(notAnObject.error, /expected an object/);
  assert.equal(sent.length, 0);
});
