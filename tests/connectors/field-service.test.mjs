import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sdk = await import('../../server/connectors/sdk/contract.ts');
const runner = await import('../../server/connectors/sdk/runner.ts');
const discovery = await import('../../server/plugins/connector-discovery.ts');
const registryMod = await import('../../server/connectors/registry.ts');
const providers = await import('../../server/connectors/providers/index.ts');
const jobber = await import('../../server/connectors/providers/jobber.ts');
const servicem8 = await import('../../server/connectors/providers/servicem8.ts');
const statuses = await import('../../server/connectors/providers/canonical-job-status.ts');

const MANIFEST_ROOT = fileURLToPath(new URL('../../server/connectors/manifests', import.meta.url));
const OAUTH = { type: 'oauth2', accessToken: 'test-access-token' };
const noSleep = async () => {};
const retry = { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 50, sleep: noSleep, random: () => 0 };

/** Scripted fetch: each call pops the next response; records every request for assertions. */
function scriptedFetch(responses) {
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

function run(definition, action, input, credentials = OAUTH, extra = {}) {
  const records = [];
  return runner
    .runAction({
      definition,
      companyId: '11111111-1111-4111-8111-111111111111',
      action,
      input,
      credentials,
      timeoutMs: 2000,
      retry,
      audit: async (r) => {
        records.push(r);
      },
      ...extra,
    })
    .then((value) => ({ value, records }));
}

test('canonical status tables only map onto canonical statuses', () => {
  assert.deepEqual(statuses.checkStatusTable(jobber.JOBBER_JOB_STATUS_MAP), []);
  assert.deepEqual(statuses.checkStatusTable(servicem8.SERVICEM8_JOB_STATUS_MAP), []);
  assert.ok(statuses.checkStatusTable({ X: 'paid' }).length === 1);
});

test('both field-service definitions pass the SDK consistency check', () => {
  const { fetchImpl } = scriptedFetch([]);
  const impls = providers.createFieldServiceImplementations({ fetch: fetchImpl, jobberApiVersion: '2025-01-01' });
  for (const [id, def] of impls) {
    assert.equal(def.id, id);
    assert.deepEqual(sdk.checkConnectorDefinition(def), [], id);
  }
});

test('manifests are discovered, matched to implementations and gated by feature flags', () => {
  const { fetchImpl } = scriptedFetch([]);
  const impls = providers.createFieldServiceImplementations({ fetch: fetchImpl, jobberApiVersion: '2025-01-01' });
  const found = discovery.discoverConnectorManifests(MANIFEST_ROOT);
  assert.deepEqual(found.rejected, []);
  const on = registryMod.createConnectorRegistry({ discovery: found, implementations: impls, isFlagOn: () => true, settings: registryMod.createMemorySettingsStore() });
  assert.deepEqual(on.registered().map((r) => r.manifest.id).sort(), ['jobber', 'servicem8']);
  const off = registryMod.createConnectorRegistry({ discovery: found, implementations: impls, isFlagOn: () => false, settings: registryMod.createMemorySettingsStore() });
  assert.equal(off.registered().length, 0);
  assert.ok(off.skipped().every((s) => s.reason === 'feature flag off'));
});

test('Jobber webhook signature: accepts the HMAC of the raw body and rejects anything else', () => {
  const { fetchImpl } = scriptedFetch([]);
  const def = jobber.createJobberConnector({ fetch: fetchImpl, apiVersion: 'v' });
  const body = '{"topic":"CLIENT_CREATE","itemId":"abc"}';
  const secret = 'client-secret';
  const sig = createHmac('sha256', secret).update(body, 'utf8').digest('base64');
  assert.equal(def.verifyWebhook(body, sig, secret), true);
  assert.equal(def.verifyWebhook(body + ' ', sig, secret), false);
  assert.equal(def.verifyWebhook(body, sig, 'other-secret'), false);
  assert.equal(def.verifyWebhook(body, '', secret), false);
  assert.equal(def.verifyWebhook(body, 'not-base64-!!', secret), false);
});

test('Jobber createJob sends the bearer token and API version header, and returns the job', async () => {
  const { fetchImpl, calls } = scriptedFetch([json({ data: { jobCreate: { job: { id: 'J1', jobStatus: 'UPCOMING' }, userErrors: [] } } })]);
  const def = jobber.createJobberConnector({ fetch: fetchImpl, apiVersion: '2025-01-01' });
  const { value } = await run(def, 'createJob', { customerId: 'C1', title: 'Gutter clean' });
  assert.deepEqual(value.value, { id: 'J1', jobStatus: 'UPCOMING' });
  assert.equal(calls[0].url, jobber.JOBBER_DEFAULT_API_URL);
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-access-token');
  assert.equal(calls[0].init.headers['x-jobber-graphql-version'], '2025-01-01');
  assert.equal(JSON.parse(calls[0].init.body).variables.input.clientId, 'C1');
  assert.ok(!calls[0].url.includes('test-access-token'));
});

test('Jobber getJob maps the vendor status onto the canonical set, and unknown statuses to "unknown"', async () => {
  const { fetchImpl } = scriptedFetch([
    json({ data: { job: { id: 'J1', title: 'T', jobStatus: 'ACTIVE', client: { id: 'C1' } } } }),
    json({ data: { job: { id: 'J2', title: 'T', jobStatus: 'SOMETHING_NEW', client: { id: 'C1' } } } }),
  ]);
  const def = jobber.createJobberConnector({ fetch: fetchImpl, apiVersion: 'v' });
  const a = await run(def, 'getJob', { id: 'J1' }, OAUTH, { mapping: jobber.JOBBER_JOB_MAPPING });
  assert.equal(a.value.value.status, 'in_progress');
  assert.equal(a.value.value.customerId, 'C1');
  const b = await run(def, 'getJob', { id: 'J2' }, OAUTH, { mapping: jobber.JOBBER_JOB_MAPPING });
  assert.equal(b.value.value.status, 'unknown');
});

test('Jobber THROTTLED GraphQL errors become rate_limited, and userErrors become validation without echoing text', async () => {
  const throttled = scriptedFetch([json({ errors: [{ extensions: { code: 'THROTTLED' } }] })]);
  const defA = jobber.createJobberConnector({ fetch: throttled.fetchImpl, apiVersion: 'v' });
  await assert.rejects(run(defA, 'getClient', { id: 'C1' }), (e) => e.code === 'rate_limited' && e.retryable);

  const user = scriptedFetch([json({ data: { clientCreate: { client: null, userErrors: [{ path: ['x'], message: 'Email secret@x.test is taken' }] } } })]);
  const defB = jobber.createJobberConnector({ fetch: user.fetchImpl, apiVersion: 'v' });
  await assert.rejects(run(defB, 'createClient', { firstName: 'Ada' }), (e) => {
    assert.equal(e.code, 'validation');
    assert.ok(!e.message.includes('secret@x.test'));
    return true;
  });
});

test('HTTP 429 from Jobber carries Retry-After into the error', async () => {
  const { fetchImpl } = scriptedFetch([new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })]);
  const def = jobber.createJobberConnector({ fetch: fetchImpl, apiVersion: 'v' });
  await assert.rejects(run(def, 'getClient', { id: 'C1' }), (e) => e.code === 'rate_limited' && e.retryAfterMs === 2000 && !e.message.includes('slow down'));
});

test('a timed-out or unreachable vendor maps to timeout and upstream', async () => {
  const timeout = Object.assign(new Error('x'), { name: 'TimeoutError' });
  const defA = jobber.createJobberConnector({ fetch: scriptedFetch([timeout]).fetchImpl, apiVersion: 'v' });
  await assert.rejects(run(defA, 'getQuote', { id: 'Q1' }), (e) => e.code === 'timeout');
  const defB = jobber.createJobberConnector({ fetch: scriptedFetch([new TypeError('fetch failed')]).fetchImpl, apiVersion: 'v' });
  await assert.rejects(run(defB, 'getQuote', { id: 'Q1' }), (e) => e.code === 'upstream');
});

test('a missing or non-OAuth credential is refused before any vendor call', async () => {
  const s = scriptedFetch([]);
  const def = jobber.createJobberConnector({ fetch: s.fetchImpl, apiVersion: 'v' });
  await assert.rejects(run(def, 'getClient', { id: 'C1' }, { type: 'api_key', apiKey: 'k' }), (e) => e.code === 'auth');
  assert.equal(s.calls.length, 0);
});

test('ServiceM8 createJob reads the new uuid from the x-record-uuid header', async () => {
  const { fetchImpl, calls } = scriptedFetch([new Response('', { status: 201, headers: { 'x-record-uuid': 'job-uuid-1' } })]);
  const def = servicem8.createServiceM8Connector({ fetch: fetchImpl });
  const { value } = await run(def, 'createJob', { customerId: 'co-1', title: 'Pool filter' });
  assert.deepEqual(value.value, { uuid: 'job-uuid-1' });
  assert.equal(calls[0].url, 'https://api.servicem8.com/api_1.0/job.json');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { company_uuid: 'co-1', job_description: 'Pool filter' });
});

test('ServiceM8 create without the uuid header is an unknown failure', async () => {
  const { fetchImpl } = scriptedFetch([new Response('', { status: 201 })]);
  const def = servicem8.createServiceM8Connector({ fetch: fetchImpl });
  await assert.rejects(run(def, 'createContact', { name: 'Ada' }), (e) => e.code === 'unknown');
});

test('ServiceM8 getJob maps status, and audit records one line per action without the token', async () => {
  const { fetchImpl } = scriptedFetch([json({ uuid: 'j1', job_description: 'Fix tap', company_uuid: 'co-1', status: 'Work Order' })]);
  const def = servicem8.createServiceM8Connector({ fetch: fetchImpl });
  const { value, records } = await run(def, 'getJob', { id: 'j1' }, OAUTH, { mapping: servicem8.SERVICEM8_JOB_MAPPING });
  assert.equal(value.value.status, 'scheduled');
  assert.equal(value.value.title, 'Fix tap');
  assert.equal(records.length, 1);
  assert.ok(!JSON.stringify(records[0]).includes('test-access-token'));
});

test('ServiceM8 refuses a non-OAuth credential and an empty id before any call', async () => {
  const s = scriptedFetch([]);
  const def = servicem8.createServiceM8Connector({ fetch: s.fetchImpl });
  await assert.rejects(run(def, 'getContact', { id: 'co-1' }, { type: 'none' }), (e) => e.code === 'auth');
  await assert.rejects(run(def, 'getContact', { id: '  ' }), (e) => e.code === 'validation');
  assert.equal(s.calls.length, 0);
});
