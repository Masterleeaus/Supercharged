// Security regression test: webhook test and retry are scoped to the session company.
// Fakes only: no database, no network. Run: node --test --experimental-transform-types tests/security/webhook-test-company-scope.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';

// Silence logs from server code so the test runner's IPC stays clean.
const noop = () => {};
console.log = noop;
console.info = noop;
console.warn = noop;
console.error = noop;

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';
const USER_A = 'user-a';
const SUB_B = 'sub-b';
const SUB_A = 'sub-a';
const PUBLIC_IP_URL = 'https://93.184.216.34/hook';

// The service imports the shared storage module, whose chain needs a live database and extensionless imports.
// A resolve hook swaps that one specifier for an inline empty fake. The tests inject their own store.
const STUB_HOOK = `
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier === '../storage') {
    return { url: 'data:text/javascript,export const storage = {};', shortCircuit: true };
  }
  if (specifier === '@shared/schema') {
    return { url: 'data:text/javascript,export const Webhook = {}; export const InsertWebhookLog = {};', shortCircuit: true };
  }
  if (specifier.startsWith('.') && !/\\.[cm]?[jt]sx?$/.test(specifier) && context.parentURL?.startsWith('file:')) {
    const p = fileURLToPath(new URL(specifier, context.parentURL));
    for (const cand of [p + '.ts', p + '/index.ts']) {
      if (existsSync(cand)) return { url: pathToFileURL(cand).href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(STUB_HOOK));

const { WebhookTestService } = await import('../../server/services/webhook-test-service.ts');

function fakeStore(rows) {
  const logs = [];
  return {
    logs,
    async getWebhook(id) {
      return rows.find((r) => r.id === id);
    },
    async createWebhookLog(log) {
      logs.push(log);
      return log;
    },
  };
}

function subscription(overrides) {
  return {
    id: SUB_B,
    userId: 'user-b',
    companyId: COMPANY_B,
    url: PUBLIC_IP_URL,
    secret: 'fake-secret',
    authType: 'none',
    authCredentials: null,
    headers: null,
    ...overrides,
  };
}

function withFetchSpy(fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response('ok', { status: 200 });
  };
  return fn(calls).finally(() => {
    globalThis.fetch = original;
  });
}

test('user of company A cannot test a company B subscription, and no request is sent', async () => {
  const store = fakeStore([subscription({ userId: USER_A, companyId: COMPANY_B })]);
  const service = new WebhookTestService(store);
  await withFetchSpy(async (calls) => {
    const result = await service.testWebhook(SUB_B, USER_A, COMPANY_A);
    assert.equal(result.success, false);
    assert.match(result.error, /^Webhook not found/);
    assert.equal(calls.length, 0, 'no outbound request may be sent for another company');
    assert.equal(store.logs.length, 0, 'no delivery log may be written for another company');
  });
});

test('a cross-company subscription gets the same response as a missing one', async () => {
  const store = fakeStore([subscription({ userId: USER_A, companyId: COMPANY_B })]);
  const service = new WebhookTestService(store);
  const crossCompany = await service.testWebhook(SUB_B, USER_A, COMPANY_A);
  const missing = await service.testWebhook('does-not-exist', USER_A, COMPANY_A);
  assert.deepEqual(crossCompany, missing);
});

test('the owner in the subscription company can still test it', async () => {
  const store = fakeStore([subscription({ id: SUB_A, userId: USER_A, companyId: COMPANY_A })]);
  const service = new WebhookTestService(store);
  await withFetchSpy(async (calls) => {
    const result = await service.testWebhook(SUB_A, USER_A, COMPANY_A);
    assert.notEqual(result.error, 'Webhook not found');
    assert.equal(calls.length, 1, 'the request is sent for the owning company');
  });
});

test('fails closed when the company is missing', async () => {
  const store = fakeStore([subscription({ id: SUB_A, userId: USER_A, companyId: COMPANY_A })]);
  const service = new WebhookTestService(store);
  await withFetchSpy(async (calls) => {
    for (const missing of ['', undefined, null]) {
      const result = await service.testWebhook(SUB_A, USER_A, missing);
      assert.equal(result.success, false);
      assert.equal(result.error, 'Company scope required');
    }
    assert.equal(calls.length, 0);
  });
});

test('a subscription with no company is refused for every caller', async () => {
  const store = fakeStore([subscription({ id: SUB_A, userId: USER_A, companyId: null })]);
  const service = new WebhookTestService(store);
  await withFetchSpy(async (calls) => {
    const result = await service.testWebhook(SUB_A, USER_A, COMPANY_A);
    assert.match(result.error, /^Webhook not found/);
    assert.equal(calls.length, 0);
  });
});

test('route source: test and retry take the company from res.locals and refuse without it', () => {
  const src = fs.readFileSync(new URL('../../server/routes/user-webhook-routes.ts', import.meta.url), 'utf8');
  assert.match(src, /res\.locals\?\.companyId/, 'company must come from res.locals');
  assert.doesNotMatch(src, /req\.body\.companyId|req\.query\.companyId|req\.params\.companyId/);
  assert.match(src, /testWebhook\(req\.params\.id, req\.userId!, companyId\)/);
  assert.match(src, /webhook\.companyId !== companyId/, 'retry must compare the subscription company');
});
