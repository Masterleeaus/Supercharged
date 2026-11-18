import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const jobber = await import('../../server/connectors/providers/jobber.ts');
const servicem8 = await import('../../server/connectors/providers/servicem8.ts');
const rt = await import('../../server/connectors/field-service/round-trip.ts');

const OAUTH = { type: 'oauth2', accessToken: 'test-access-token' };
const SECRET = 'test-client-secret';
const COMPANY = '11111111-1111-4111-8111-111111111111';
const noSleep = async () => {};
const retry = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 50, sleep: noSleep, random: () => 0 };
const lead = {
  source: 'web_form', sourceRef: 'form-1', name: 'Ana Lopez', email: 'ana@example.com',
  message: 'Gutter clean before winter', receivedAt: '2026-11-18T00:00:00Z',
};

/** Scripted fetch, same shape as field-service.test.mjs. Every request is recorded. */
function scripted(responses) {
  const calls = [];
  const queue = [...responses];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error('no scripted response left');
    return next;
  };
  return { fetchImpl, calls };
}
const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const gql = (data) => json({ data });

function ctxFor(definition) {
  return {
    definition, companyId: COMPANY, credentials: OAUTH, timeoutMs: 2000, retry,
    audit: async () => {},
  };
}
const jobberCtx = (fetchImpl) => ctxFor(jobber.createJobberConnector({ fetch: fetchImpl, apiVersion: '2025-01-01' }));
const m8Ctx = (fetchImpl) => ctxFor(servicem8.createServiceM8Connector({ fetch: fetchImpl }));

function signed(body) {
  const raw = JSON.stringify(body);
  return { raw, sig: createHmac('sha256', SECRET).update(raw, 'utf8').digest('base64') };
}
const jobUpdate = (itemId, occurredAt = '2026-11-18T01:00:00Z') => ({
  data: { webhookEvent: { topic: 'JOB_UPDATE', itemId, occurredAt, appId: 'app', accountId: 'acct' } },
});

// ---- Enquiry to job ----

test('Jobber: an enquiry creates a client and a job linked to it, and returns the canonical status', async () => {
  const { fetchImpl, calls } = scripted([
    gql({ clientCreate: { client: { id: 'CL1' }, userErrors: [] } }),
    gql({ jobCreate: { job: { id: 'J1', jobStatus: 'UPCOMING' }, userErrors: [] } }),
  ]);
  const out = await rt.enquiryToJob('jobber', jobberCtx(fetchImpl), lead);
  assert.deepEqual(out, { vendor: 'jobber', customerId: 'CL1', jobId: 'J1', status: 'scheduled' });
  const createClient = JSON.parse(calls[0].init.body).variables.input;
  assert.deepEqual(createClient, { firstName: 'Ana', lastName: 'Lopez' });
  const createJob = JSON.parse(calls[1].init.body).variables.input;
  assert.equal(createJob.clientId, 'CL1');
  assert.equal(createJob.title, 'Gutter clean before winter');
  assert.equal(calls[1].init.headers['x-jobber-graphql-version'], '2025-01-01');
});

test('Jobber: a vendor userError on createClient stops the flow before any job is created', async () => {
  const { fetchImpl, calls } = scripted([gql({ clientCreate: { client: null, userErrors: [{ path: ['firstName'] }] } })]);
  await assert.rejects(rt.enquiryToJob('jobber', jobberCtx(fetchImpl), lead), (e) => e.code === 'validation');
  assert.equal(calls.length, 1);
});

test('ServiceM8: an enquiry creates a contact, a job against it, and reads the job status back', async () => {
  const { fetchImpl, calls } = scripted([
    json({}, 200, { 'x-record-uuid': 'CO1' }),
    json({}, 200, { 'x-record-uuid': 'JB1' }),
    json({ uuid: 'JB1', status: 'Work Order' }),
  ]);
  const out = await rt.enquiryToJob('servicem8', m8Ctx(fetchImpl), lead);
  assert.deepEqual(out, { vendor: 'servicem8', customerId: 'CO1', jobId: 'JB1', status: 'scheduled' });
  assert.match(calls[0].url, /company\.json$/);
  assert.match(calls[1].url, /job\.json$/);
  assert.equal(JSON.parse(calls[1].init.body).company_uuid, 'CO1');
  assert.match(calls[2].url, /job\/JB1\.json$/);
});

test('ServiceM8: a create with no record id in the response is refused, not guessed', async () => {
  const { fetchImpl } = scripted([json({}, 200, {})]);
  await assert.rejects(rt.enquiryToJob('servicem8', m8Ctx(fetchImpl), lead), (e) => e.code === 'unknown');
});

// ---- Status back to the customer ----

test('Jobber webhook: a signed JOB_UPDATE moves the job to invoiced and plans one customer message', async () => {
  const { fetchImpl, calls } = scripted([gql({ job: { id: 'J1', jobStatus: 'CLOSED', client: { id: 'CL1' } } })]);
  const { raw, sig } = signed(jobUpdate('J1'));
  const out = await rt.handleJobberJobUpdate(jobberCtx(fetchImpl), { rawBody: raw, signature: sig, secret: SECRET, lastStatus: 'completed', seen: new Set() });
  assert.equal(out.ok, true);
  assert.equal(out.changed, true);
  assert.equal(out.status, 'invoiced');
  assert.deepEqual(out.message, { channel: 'message', to: 'CL1', body: rt.CUSTOMER_STATUS_MESSAGES.invoiced, status: 'invoiced' });
  assert.equal(JSON.parse(calls[0].init.body).variables.id, 'J1');
});

test('Jobber webhook: a bad signature is refused before any vendor call', async () => {
  const { fetchImpl, calls } = scripted([]);
  const { raw } = signed(jobUpdate('J1'));
  const out = await rt.handleJobberJobUpdate(jobberCtx(fetchImpl), { rawBody: raw, signature: 'AAAA', secret: SECRET, lastStatus: null, seen: new Set() });
  assert.deepEqual(out, { ok: false, reason: 'bad_signature' });
  assert.equal(calls.length, 0);
});

test('Jobber webhook: a redelivered event is a duplicate and makes no second vendor call', async () => {
  const { fetchImpl, calls } = scripted([gql({ job: { id: 'J1', jobStatus: 'ACTIVE', client: { id: 'CL1' } } })]);
  const { raw, sig } = signed(jobUpdate('J1'));
  const seen = new Set();
  const args = { rawBody: raw, signature: sig, secret: SECRET, lastStatus: null, seen };
  await rt.handleJobberJobUpdate(jobberCtx(fetchImpl), args);
  const again = await rt.handleJobberJobUpdate(jobberCtx(fetchImpl), args);
  assert.deepEqual(again, { ok: true, reason: 'duplicate', changed: false });
  assert.equal(calls.length, 1);
});

test('Jobber webhook: other topics are ignored without a vendor call', async () => {
  const { fetchImpl, calls } = scripted([]);
  const body = { data: { webhookEvent: { topic: 'CLIENT_CREATE', itemId: 'CL9' } } };
  const { raw, sig } = signed(body);
  const out = await rt.handleJobberJobUpdate(jobberCtx(fetchImpl), { rawBody: raw, signature: sig, secret: SECRET, lastStatus: null, seen: new Set() });
  assert.deepEqual(out, { ok: false, reason: 'ignored_topic' });
  assert.equal(calls.length, 0);
});

test('Jobber webhook: an unchanged status plans no message', async () => {
  const { fetchImpl } = scripted([gql({ job: { id: 'J1', jobStatus: 'ACTIVE', client: { id: 'CL1' } } })]);
  const { raw, sig } = signed(jobUpdate('J1'));
  const out = await rt.handleJobberJobUpdate(jobberCtx(fetchImpl), { rawBody: raw, signature: sig, secret: SECRET, lastStatus: 'in_progress', seen: new Set() });
  assert.equal(out.changed, false);
  assert.equal(out.message, null);
});

test('Jobber: an unknown vendor status maps to "unknown" and plans no message', async () => {
  const { fetchImpl } = scripted([gql({ job: { id: 'J1', jobStatus: 'SOMETHING_NEW', client: { id: 'CL1' } } })]);
  const { raw, sig } = signed(jobUpdate('J1'));
  const out = await rt.handleJobberJobUpdate(jobberCtx(fetchImpl), { rawBody: raw, signature: sig, secret: SECRET, lastStatus: null, seen: new Set() });
  assert.equal(out.status, 'unknown');
  assert.equal(out.message, null);
});

test('ServiceM8 poll: Completed plans the completed message, and a repeat poll plans nothing', async () => {
  const { fetchImpl } = scripted([
    json({ uuid: 'JB1', status: 'Completed', company_uuid: 'CO1' }),
    json({ uuid: 'JB1', status: 'Completed', company_uuid: 'CO1' }),
  ]);
  const first = await rt.pollServiceM8JobStatus(m8Ctx(fetchImpl), 'JB1', 'scheduled');
  assert.equal(first.changed, true);
  assert.deepEqual(first.message, { channel: 'message', to: 'CO1', body: rt.CUSTOMER_STATUS_MESSAGES.completed, status: 'completed' });
  const second = await rt.pollServiceM8JobStatus(m8Ctx(fetchImpl), 'JB1', 'completed');
  assert.equal(second.changed, false);
  assert.equal(second.message, null);
});

test('the customer message body is a fixed template, never vendor text', () => {
  for (const [status, body] of Object.entries(rt.CUSTOMER_STATUS_MESSAGES)) {
    assert.equal(typeof body, 'string');
    assert.ok(!/job_description|Vendor|GraphQL|userErrors/.test(body), status);
  }
});
