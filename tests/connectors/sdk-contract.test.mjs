import test from 'node:test';
import assert from 'node:assert/strict';

const sdk = await import('../../server/connectors/sdk/contract.ts');
const client = await import('../../server/connectors/sdk/client.ts');
const mapping = await import('../../server/connectors/sdk/field-mapping.ts');
const audit = await import('../../server/connectors/sdk/audit.ts');
const runner = await import('../../server/connectors/sdk/runner.ts');
const { createFakeProvider, FAKE_API_KEY } = await import('./fixtures/fake-provider.ts');

const creds = { type: 'api_key', apiKey: FAKE_API_KEY };
const noSleep = async () => {};
const retry = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 50, sleep: noSleep, random: () => 0 };
const memoryAudit = () => {
  const records = [];
  return { records, sink: async (r) => { records.push(r); } };
};
const CONTACT_MAP = {
  fields: { fullName: 'contact.display_name', email: 'contact.email_address' },
  statusPath: 'state',
  statuses: { ACTIVE: 'active', ARCHIVED: 'archived' },
};

test('checkConnectorDefinition accepts the fake provider and rejects inconsistent ones', () => {
  const fake = createFakeProvider();
  assert.deepEqual(sdk.checkConnectorDefinition(fake), []);
  const bad = { ...fake, capabilities: ['read'], entities: ['contact'] };
  const problems = sdk.checkConnectorDefinition(bad);
  assert.ok(problems.some((p) => p.includes('createBooking') || p.includes('needs capability')));
  assert.ok(sdk.checkConnectorDefinition({ ...fake, auth: 'basic' }).length > 0);
  assert.ok(sdk.checkConnectorDefinition({ ...fake, capabilities: ['webhook_in'] }).some((p) => p.includes('verifyWebhook')));
});

test('errorFromStatus maps vendor statuses to the taxonomy and only retries retryable codes', () => {
  assert.equal(sdk.errorFromStatus(429, 1000).code, 'rate_limited');
  assert.equal(sdk.errorFromStatus(429).retryable, true);
  assert.equal(sdk.errorFromStatus(503).code, 'upstream');
  assert.equal(sdk.errorFromStatus(401).retryable, false);
  assert.equal(sdk.errorFromStatus(422).code, 'validation');
});

test('read action returns mapped canonical fields and writes one audit record', async () => {
  const fake = createFakeProvider();
  const log = memoryAudit();
  const result = await runner.runAction({
    definition: fake, companyId: 'co-1', action: 'getContact', input: { id: 'c1' },
    credentials: creds, mapping: CONTACT_MAP, audit: log.sink, retry,
  });
  assert.deepEqual(result.value, { fullName: 'Ada Example', email: 'ada@example.test', status: 'active' });
  assert.equal(log.records.length, 1);
  assert.equal(log.records[0].outcome, 'success');
  assert.equal(log.records[0].companyId, 'co-1');
});

test('unknown vendor status maps to "unknown" instead of failing the read', () => {
  const out = mapping.mapRecord({ contact: { display_name: 'x' }, state: 'PAUSED' }, CONTACT_MAP);
  assert.equal(out.status, mapping.UNKNOWN_STATUS);
  assert.equal(out.fullName, 'x');
  assert.equal(out.email, null);
});

test('retries a rate-limited read and honours Retry-After; attempts are counted', async () => {
  const fake = createFakeProvider();
  fake.failNext({ status: 429, retryAfterMs: 5 });
  fake.failNext({ status: 503 });
  const waits = [];
  const result = await runner.runAction({
    definition: fake, companyId: 'co-1', action: 'getContact', input: { id: 'c1' },
    credentials: creds, audit: memoryAudit().sink,
    retry: { ...retry, maxAttempts: 4, sleep: async (ms) => { waits.push(ms); } },
  });
  assert.equal(result.attempts, 3);
  assert.equal(waits[0], 5);
  assert.equal(fake.calls, 3);
});

test('does not retry non-retryable errors', async () => {
  const fake = createFakeProvider();
  fake.failNext({ status: 401 });
  const log = memoryAudit();
  await assert.rejects(
    runner.runAction({ definition: fake, companyId: 'co-1', action: 'getContact', input: { id: 'c1' }, credentials: creds, audit: log.sink, retry }),
    (err) => err.code === 'auth' && fake.calls === 1,
  );
  assert.equal(log.records[0].outcome, 'failure');
  assert.equal(log.records[0].errorCode, 'auth');
});

test('gives up after maxAttempts and does not block on a Retry-After longer than maxDelayMs', async () => {
  const fake = createFakeProvider();
  fake.failNext({ status: 429 });
  fake.failNext({ status: 429 });
  fake.failNext({ status: 429 });
  await assert.rejects(
    runner.runAction({ definition: fake, companyId: 'co-1', action: 'getContact', input: { id: 'c1' }, credentials: creds, audit: memoryAudit().sink, retry }),
    (err) => err.code === 'rate_limited',
  );
  assert.equal(fake.calls, 3);

  const fake2 = createFakeProvider();
  fake2.failNext({ status: 429, retryAfterMs: 60_000 });
  await assert.rejects(
    runner.runAction({ definition: fake2, companyId: 'co-1', action: 'getContact', input: { id: 'c1' }, credentials: creds, audit: memoryAudit().sink, retry }),
    (err) => err.code === 'rate_limited',
  );
  assert.equal(fake2.calls, 1);
});

test('per-attempt timeout produces a timeout ConnectorError, which is retried', async () => {
  const fake = createFakeProvider();
  fake.failNext({ timeoutMs: 200 });
  const result = await runner.runAction({
    definition: fake, companyId: 'co-1', action: 'getContact', input: { id: 'c1' },
    credentials: creds, timeoutMs: 20, audit: memoryAudit().sink, retry,
  });
  assert.equal(result.attempts, 2);
});

test('writes carry one idempotency key across retries and the vendor creates the booking once', async () => {
  const fake = createFakeProvider();
  fake.failNext({ status: 503 });
  const log = memoryAudit();
  const result = await runner.runAction({
    definition: fake, companyId: 'co-1', action: 'createBooking', input: { when: '2026-12-01' },
    credentials: creds, stableId: 'quote-42:slot-1', audit: log.sink, retry,
  });
  assert.equal(result.attempts, 2);
  assert.equal(new Set(fake.seenKeys).size, 1);
  assert.equal(fake.bookingsCreated, 1);
  assert.equal(log.records[0].idempotencyKey, result.idempotencyKey);
});

test('a stable id gives the same idempotency key on a replayed write', async () => {
  const a = createFakeProvider();
  const b = createFakeProvider();
  const first = await runner.runAction({ definition: a, companyId: 'co-1', action: 'createBooking', input: {}, credentials: creds, stableId: 's1', audit: memoryAudit().sink, retry });
  const second = await runner.runAction({ definition: b, companyId: 'co-1', action: 'createBooking', input: {}, credentials: creds, stableId: 's1', audit: memoryAudit().sink, retry });
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  const other = await runner.runAction({ definition: b, companyId: 'co-2', action: 'createBooking', input: {}, credentials: creds, stableId: 's1', audit: memoryAudit().sink, retry });
  assert.notEqual(other.idempotencyKey, first.idempotencyKey);
});

test('unknown action and wrong credentials fail closed and are audited', async () => {
  const fake = createFakeProvider();
  const log = memoryAudit();
  await assert.rejects(runner.runAction({ definition: fake, companyId: 'co-1', action: 'deleteEverything', input: {}, credentials: creds, audit: log.sink, retry }), (e) => e.code === 'validation');
  await assert.rejects(runner.runAction({ definition: fake, companyId: 'co-1', action: 'getContact', input: { id: 'c1' }, credentials: { type: 'api_key', apiKey: 'wrong' }, audit: log.sink, retry }), (e) => e.code === 'auth');
  assert.deepEqual(log.records.map((r) => r.outcome), ['failure', 'failure']);
});

test('an audit sink failure fails the action with a generic error', async () => {
  const fake = createFakeProvider();
  await assert.rejects(
    runner.runAction({ definition: fake, companyId: 'co-1', action: 'getContact', input: { id: 'c1' }, credentials: creds, audit: async () => { throw new Error('db down: postgres://user:pw@host'); }, retry }),
    (e) => e.code === 'unknown' && !String(e.message).includes('postgres'),
  );
});

test('audit payloads never contain credentials, tokens or bearer strings', () => {
  const record = audit.buildAuditRecord({
    companyId: 'co-1', connector: 'fake-crm', action: 'createBooking', outcome: 'success', attempts: 1, durationMs: 3,
    now: new Date('2026-11-17T00:00:00Z'),
    payload: { when: 'x', access_token: 'abc', nested: { refreshToken: 'def', client_secret: 'ghi' }, header: 'Bearer abc.def', url: 'https://x.test/cb?code=zzz&state=ok' },
  });
  const text = JSON.stringify(record);
  for (const secret of ['abc', 'def', 'ghi', 'zzz', 'Bearer']) assert.equal(text.includes(secret), false, `leaked ${secret}`);
  assert.equal(record.payload.when, 'x');
});

test('backoff stays within the cap and jitter is applied', () => {
  const policy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 300, random: () => 0.5 };
  const e = new sdk.ConnectorError('upstream', 'x');
  assert.equal(client.backoffDelay(1, e, policy), 50);
  assert.equal(client.backoffDelay(4, e, policy), 150);
  assert.equal(client.backoffDelay(9, e, policy), 150);
});
