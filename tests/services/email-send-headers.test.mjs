/**
 * Tests that custom headers reach the wire on the real EmailService.sendEmail path.
 *
 * Claims checked:
 *   1. sendEmail with headers puts List-Unsubscribe on the raw message.
 *   2. A caller's Message-ID is the one on the wire, appears once, and is the returned messageId.
 *   3. Callers that pass no headers get the same message as before (no List-Unsubscribe).
 *   4. Header values with CR/LF, bad names, or protected names fail closed before any send.
 *   5. The full chain (campaign transport -> adapter -> createEmailServiceSender -> sendEmail)
 *      puts the List-Unsubscribe header and the transport's Message-ID on the wire.
 *
 * email-service.ts imports storage and the logger. A resolve hook swaps both for stubs, so the
 * module loads without a database. The transporter is nodemailer's streamTransport, which keeps
 * the raw RFC 822 bytes, so the test reads the real headers. No SMTP, no network.
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

// The service logs every send to stdout. The test runner reads its own frames from stdout, so
// the service's console output is silenced for this file.
const realConsoleLog = console.log;
console.log = () => {};
test.after(() => {
  console.log = realConsoleLog;
});

const nodemailer = (await import('nodemailer')).default;
const { emailService } = await import('../../server/services/email-service.ts');
const { createEmailSendTransport } = await import('../../server/modules/comms/email-send-transport.ts');
const { createEmailProviderAdapter, createEmailServiceSender } = await import(
  '../../server/modules/comms/email-provider-adapter.ts'
);
const { createSuppressionList } = await import('../../server/modules/comms/suppression.ts');

const CO = '11111111-1111-4111-8111-111111111111';
const ADDRESS = 'jane.doe@example.com';
const UNSUB = 'https://app.example.com/unsubscribe/token-abc';
const MSG_ID = '<m1@campaigns.invalid>';

/** Points the real service at a stream transport that keeps the raw message, and records calls. */
function useStreamTransport() {
  const sent = [];
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const realSend = transport.sendMail.bind(transport);
  transport.sendMail = async (opts) => {
    const info = await realSend(opts);
    sent.push({ opts, raw: info.message.toString(), info });
    return info;
  };
  emailService.transporter = transport;
  emailService.smtpConfigured = true;
  emailService.fromAddress = 'noreply@example.com';
  emailService.fromName = 'Test Sender';
  return sent;
}

/** Returns every value of a header line in the raw message, case-insensitive on the name. */
function headerValues(raw, name) {
  const head = raw.split('\n\n')[0];
  const values = [];
  for (const line of head.split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0 && line.slice(0, idx).toLowerCase() === name.toLowerCase()) {
      values.push(line.slice(idx + 1).trim());
    }
  }
  return values;
}

test('sendEmail with headers puts List-Unsubscribe on the raw message', async () => {
  const sent = useStreamTransport();
  const result = await emailService.sendEmail(ADDRESS, 'Spring offer', '<p>Hi</p>', undefined, {
    text: 'Hi',
    headers: { 'List-Unsubscribe': `<${UNSUB}>` },
  });
  assert.equal(result.success, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(headerValues(sent[0].raw, 'List-Unsubscribe'), [`<${UNSUB}>`]);
});

test('a caller Message-ID is the one on the wire, once, and the returned messageId', async () => {
  const sent = useStreamTransport();
  const result = await emailService.sendEmail(ADDRESS, 'Spring offer', '<p>Hi</p>', undefined, {
    headers: { 'Message-ID': MSG_ID, 'List-Unsubscribe': `<${UNSUB}>` },
  });
  assert.equal(result.success, true);
  assert.equal(result.messageId, MSG_ID);
  assert.deepEqual(headerValues(sent[0].raw, 'Message-ID'), [MSG_ID]);
});

test('a caller Message-ID in lower case is also used and is not duplicated', async () => {
  const sent = useStreamTransport();
  const result = await emailService.sendEmail(ADDRESS, 'Spring offer', '<p>Hi</p>', undefined, {
    headers: { 'message-id': MSG_ID },
  });
  assert.equal(result.messageId, MSG_ID);
  assert.deepEqual(headerValues(sent[0].raw, 'Message-ID'), [MSG_ID]);
});

test('a caller without headers is unchanged: no List-Unsubscribe and a generated Message-ID', async () => {
  const sent = useStreamTransport();
  const result = await emailService.sendEmail(ADDRESS, 'Welcome', '<p>Hi</p>');
  assert.equal(result.success, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(headerValues(sent[0].raw, 'List-Unsubscribe'), []);
  const ids = headerValues(sent[0].raw, 'Message-ID');
  assert.equal(ids.length, 1);
  assert.match(ids[0], /^<.+@.+>$/);
  assert.equal(result.messageId, ids[0]);
});

test('replyTo still works alongside headers', async () => {
  const sent = useStreamTransport();
  await emailService.sendEmail(ADDRESS, 'Reply test', '<p>Hi</p>', undefined, {
    replyTo: 'support@example.com',
    headers: { 'List-Unsubscribe': `<${UNSUB}>` },
  });
  assert.deepEqual(headerValues(sent[0].raw, 'Reply-To'), ['support@example.com']);
  assert.deepEqual(headerValues(sent[0].raw, 'List-Unsubscribe'), [`<${UNSUB}>`]);
});

test('a header value with CR or LF is refused before anything is sent', async () => {
  const sent = useStreamTransport();
  let calls = 0;
  const original = emailService.transporter.sendMail;
  emailService.transporter.sendMail = async (...args) => {
    calls += 1;
    return original(...args);
  };
  const result = await emailService.sendEmail(ADDRESS, 'Injection', '<p>Hi</p>', undefined, {
    headers: { 'List-Unsubscribe': `<${UNSUB}>\r\nBcc: attacker@example.com` },
  });
  assert.equal(result.success, false);
  assert.match(result.error, /Invalid value for custom email header/);
  assert.equal(calls, 0);
  assert.equal(sent.length, 0);
});

test('a bad header name or a protected header name is refused before anything is sent', async () => {
  const sent = useStreamTransport();
  const badName = await emailService.sendEmail(ADDRESS, 'x', '<p>x</p>', undefined, {
    headers: { 'Bad Name': 'v' },
  });
  assert.equal(badName.success, false);
  const protectedName = await emailService.sendEmail(ADDRESS, 'x', '<p>x</p>', undefined, {
    headers: { Bcc: 'attacker@example.com' },
  });
  assert.equal(protectedName.success, false);
  assert.match(protectedName.error, /not allowed/);
  assert.equal(sent.length, 0);
});

test('the campaign chain (transport -> adapter -> createEmailServiceSender -> sendEmail) reaches the wire', async () => {
  const sent = useStreamTransport();
  const sender = createEmailProviderAdapter({
    companyId: CO,
    suppression: createSuppressionList(),
    loadContact: async () => ({
      handles: { email: ADDRESS },
      consents: [{ channel: 'email', action: 'opt_in', at: '2026-10-01T00:00:00Z', source: 'contact' }],
    }),
    buildUnsubscribeUrl: () => UNSUB,
    base: await createEmailServiceSender(),
    now: () => new Date('2026-11-03T02:00:00Z'),
  });
  const transport = createEmailSendTransport({ sender, messageIdDomain: 'campaigns.invalid' });
  const job = {
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
  const result = await transport.send(CO, job, { subject: 'Spring offer', body: 'Hello there' });

  assert.equal(result.ok, true);
  assert.equal(sent.length, 1);
  assert.deepEqual(headerValues(sent[0].raw, 'List-Unsubscribe'), [`<${UNSUB}>`]);

  const wireIds = headerValues(sent[0].raw, 'Message-ID');
  assert.equal(wireIds.length, 1);
  assert.match(wireIds[0], /^<[0-9a-f-]+@campaigns\.invalid>$/);
  assert.equal(result.externalId, wireIds[0]);
});
