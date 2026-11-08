/**
 * Field link client tests. Fake fetch only: no network, no database, no servers.
 * The client is TypeScript and Node 22.18+ strips types natively, so it is imported directly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import {
  FieldLinkClient, FieldLinkError, readFieldLinkConfig, validateFieldBaseUrl,
  FIELD_LINK_ENDPOINTS, FIELD_LINK_HEADERS,
} from '../../server/integrations/field-link/client.ts';
import { DENY_ALL_COMPANY_MAP, createStaticCompanyMap } from '../../server/integrations/field-link/company-map.ts';

const SECRET = 'TEST-FIELD-LINK-SECRET-NOT-REAL-0123456789-ABCDEF';
const KEY_ID = 'desk-key-test-1';
const BASE = 'https://field.example.test';
const NOW_MS = Date.parse('2026-11-02T00:00:00Z');
const DESK_COMPANY = 'desk_co_42';
const FIELD_ACCOUNT = 'acct_field_7';

const INPUT = {
  idempotency_key: 'idem-0001',
  record_id: 'lead_99',
  customer: { name: 'Test Customer', phone: '+61400000000' },
  service_address: { line1: '1 Test Street', suburb: 'Testville', postcode: '3000' },
  requested_service: 'deep clean',
  requested_window: { start: '2026-11-05T09:00:00+11:00', end: '2026-11-05T12:00:00+11:00' },
  notes: 'call before arriving',
  consent: { captured_at: '2026-11-01T10:00:00+11:00', basis: 'customer_request' },
};

const mappedMap = () => createStaticCompanyMap([[DESK_COMPANY, FIELD_ACCOUNT]]);

function recordingFetch(responder) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { fetchImpl, calls };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(overrides = {}) {
  return new FieldLinkClient({
    baseUrl: BASE, keyId: KEY_ID, secret: SECRET, companyMap: mappedMap(), now: () => NOW_MS, ...overrides,
  });
}

function assertNoLeak(error, forbidden) {
  const surfaces = [error.message, error.stack ?? '', String(error), JSON.stringify(error), inspect(error, { depth: 5 })];
  for (const text of surfaces) {
    for (const needle of forbidden) {
      assert.equal(text.includes(needle), false, `error surface leaked: ${needle.slice(0, 12)}...`);
    }
  }
}

// ---- 1. base URL: refuse plain http to remote hosts ----

test('refuses plain http to a remote host', () => {
  for (const url of ['http://field.example.test', 'http://10.0.0.5:3010', 'http://0.0.0.0:3010', 'http://[::1]:3010']) {
    assert.throws(() => validateFieldBaseUrl(url), (e) => e instanceof FieldLinkError && e.code === 'field_link_config_invalid', url);
    assert.throws(() => client({ baseUrl: url }), (e) => e.code === 'field_link_config_invalid', url);
  }
});

test('allows http only for 127.0.0.1 and localhost, and https for any host', () => {
  assert.equal(validateFieldBaseUrl('http://127.0.0.1:3010/'), 'http://127.0.0.1:3010');
  assert.equal(validateFieldBaseUrl('http://localhost:3010'), 'http://localhost:3010');
  assert.equal(validateFieldBaseUrl('https://field.example.test/'), 'https://field.example.test');
});

test('refuses URLs with credentials, query strings, or other schemes', () => {
  for (const url of ['https://user:pass@field.example.test', 'https://field.example.test?x=1', 'ftp://field.example.test', 'not a url']) {
    assert.throws(() => validateFieldBaseUrl(url), (e) => e.code === 'field_link_config_invalid', url);
  }
});

test('refuses a short secret and never echoes it', () => {
  const short = 'short-secret-value';
  assert.throws(() => client({ secret: short }), (e) => {
    assert.equal(e.code, 'field_link_config_invalid');
    assertNoLeak(e, [short]);
    return true;
  });
});

test('config reader returns null when unset and fails when partly set', () => {
  assert.equal(readFieldLinkConfig({}), null);
  assert.throws(() => readFieldLinkConfig({ FIELD_LINK_BASE_URL: BASE }), (e) => e.code === 'field_link_config_invalid');
  const cfg = readFieldLinkConfig({ FIELD_LINK_BASE_URL: BASE, FIELD_LINK_KEY_ID: KEY_ID, FIELD_LINK_SECRET: SECRET });
  assert.equal(cfg.baseUrl, BASE);
});

// ---- 2. redirects are refused ----

test('refuses redirects and asks fetch not to follow them', async () => {
  const { fetchImpl, calls } = recordingFetch(() => new Response(null, { status: 302, headers: { location: 'https://evil.example.test/steal' } }));
  const c = client({ fetch: fetchImpl });
  await assert.rejects(c.createBookingRequest(DESK_COMPANY, INPUT), (e) => {
    assert.equal(e.code, 'field_link_redirect_refused');
    assert.equal(e.status, 302);
    return true;
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.redirect, 'error');
});

test('a fetch that refuses to follow a redirect surfaces as unreachable without the location', async () => {
  const { fetchImpl } = recordingFetch(() => { throw new TypeError('redirect mode is set to error: https://evil.example.test/secret-path'); });
  const c = client({ fetch: fetchImpl });
  await assert.rejects(c.getBookingRequest(DESK_COMPANY, 'fbr_1'), (e) => {
    assert.equal(e.code, 'field_link_unreachable');
    assertNoLeak(e, ['evil.example.test', 'secret-path']);
    return true;
  });
});

// ---- 3. secret and bodies never leak into errors ----

test('never leaks the secret when the transport error contains it', async () => {
  const { fetchImpl } = recordingFetch(() => { throw new Error(`connect failed using ${SECRET}`); });
  const c = client({ fetch: fetchImpl });
  await assert.rejects(c.createBookingRequest(DESK_COMPANY, INPUT), (e) => {
    assert.ok(e instanceof FieldLinkError);
    assertNoLeak(e, [SECRET, INPUT.customer.phone, INPUT.customer.name]);
    return true;
  });
});

test('never leaks the secret or the response body on an HTTP error', async () => {
  const echoed = `server echoed ${SECRET} and ${INPUT.customer.phone}`;
  const { fetchImpl } = recordingFetch(() => new Response(echoed, { status: 500 }));
  const c = client({ fetch: fetchImpl });
  await assert.rejects(c.createBookingRequest(DESK_COMPANY, INPUT), (e) => {
    assert.equal(e.code, 'field_link_http_error');
    assert.equal(e.status, 500);
    assertNoLeak(e, [SECRET, INPUT.customer.phone, 'server echoed']);
    return true;
  });
});

test('never leaks the response body when a 2xx body is not JSON', async () => {
  const { fetchImpl } = recordingFetch(() => new Response(`not json ${SECRET}`, { status: 200 }));
  const c = client({ fetch: fetchImpl });
  await assert.rejects(c.getBookingRequest(DESK_COMPANY, 'fbr_1'), (e) => {
    assert.equal(e.code, 'field_link_bad_response');
    assertNoLeak(e, [SECRET]);
    return true;
  });
});

test('maps common statuses to codes without detail', async () => {
  const expected = { 401: 'field_link_auth_rejected', 403: 'field_link_forbidden', 404: 'field_link_not_found', 409: 'field_link_conflict', 422: 'field_link_validation_failed' };
  for (const [status, code] of Object.entries(expected)) {
    const { fetchImpl } = recordingFetch(() => json(Number(status), { error: 'x' }));
    await assert.rejects(client({ fetch: fetchImpl }).createBookingRequest(DESK_COMPANY, INPUT), (e) => e.code === code && e.status === Number(status));
  }
});

// ---- 4. signature header present and verifiable ----

test('sends an HMAC signature over timestamp, method, path and body hash', async () => {
  const { fetchImpl, calls } = recordingFetch(() => json(201, { booking_request_id: 'fbr_1', status: 'new' }));
  const result = await client({ fetch: fetchImpl }).createBookingRequest(DESK_COMPANY, INPUT);
  assert.equal(result.booking_request_id, 'fbr_1');

  const { url, init } = calls[0];
  assert.equal(url, `${BASE}${FIELD_LINK_ENDPOINTS.createBookingRequest.path}`);
  assert.equal(init.method, 'POST');
  assert.equal(init.redirect, 'error');

  const headers = init.headers;
  const timestamp = String(Math.floor(NOW_MS / 1000));
  assert.equal(headers[FIELD_LINK_HEADERS.keyId], KEY_ID);
  assert.equal(headers[FIELD_LINK_HEADERS.timestamp], timestamp);
  assert.equal(headers[FIELD_LINK_HEADERS.idempotencyKey], INPUT.idempotency_key);
  assert.match(headers[FIELD_LINK_HEADERS.signature], /^[A-Za-z0-9+/]+=*$/);

  // Recompute independently of the client code.
  const bodyHash = createHash('sha256').update(init.body, 'utf8').digest('hex');
  const expected = createHmac('sha256', SECRET).update(`${timestamp}.POST.${FIELD_LINK_ENDPOINTS.createBookingRequest.path}.${bodyHash}`, 'utf8').digest('base64');
  assert.equal(headers[FIELD_LINK_HEADERS.signature], expected);
});

test('the signed body carries the mapped account and the Desk tenant reference', async () => {
  const { fetchImpl, calls } = recordingFetch(() => json(201, { booking_request_id: 'fbr_1' }));
  await client({ fetch: fetchImpl }).createBookingRequest(DESK_COMPANY, INPUT);
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.account_id, FIELD_ACCOUNT);
  assert.deepEqual(body.external_ref, { source: 'titan-desk', tenant_ref: DESK_COMPANY, record_id: INPUT.record_id });
});

test('GET requests are signed over an empty body', async () => {
  const { fetchImpl, calls } = recordingFetch(() => json(200, { id: 'fbr_1' }));
  await client({ fetch: fetchImpl }).getBookingRequest(DESK_COMPANY, 'fbr_1');
  const headers = calls[0].init.headers;
  const timestamp = String(Math.floor(NOW_MS / 1000));
  const emptyHash = createHash('sha256').update('', 'utf8').digest('hex');
  const expected = createHmac('sha256', SECRET).update(`${timestamp}.GET.${FIELD_LINK_ENDPOINTS.getBookingRequest.path.replace(':id', 'fbr_1')}.${emptyHash}`, 'utf8').digest('base64');
  assert.equal(headers[FIELD_LINK_HEADERS.signature], expected);
  assert.equal(calls[0].init.body, undefined);
});

// ---- 5. tenant mapping fails closed ----

test('missing company mapping fails closed and sends nothing', async () => {
  const { fetchImpl, calls } = recordingFetch(() => json(201, {}));
  const c = client({ fetch: fetchImpl, companyMap: DENY_ALL_COMPANY_MAP });
  await assert.rejects(c.createBookingRequest(DESK_COMPANY, INPUT), (e) => e.code === 'field_link_tenant_not_mapped');
  assert.equal(calls.length, 0);
});

test('unmapped, empty and prototype-named tenants are refused', async () => {
  const { fetchImpl, calls } = recordingFetch(() => json(201, {}));
  const c = client({ fetch: fetchImpl });
  for (const tenant of ['other_co', '', '   ', '__proto__', 'constructor', 'toString']) {
    await assert.rejects(c.createBookingRequest(tenant, INPUT), (e) => e.code === 'field_link_tenant_not_mapped', tenant);
  }
  assert.equal(calls.length, 0);
});

test('a client with no company map at all uses the fail-closed default', async () => {
  const { fetchImpl, calls } = recordingFetch(() => json(201, {}));
  const c = new FieldLinkClient({ baseUrl: BASE, keyId: KEY_ID, secret: SECRET, fetch: fetchImpl });
  await assert.rejects(c.createBookingRequest(DESK_COMPANY, INPUT), (e) => e.code === 'field_link_tenant_not_mapped');
  assert.equal(calls.length, 0);
});

test('static map rejects conflicting duplicate entries', () => {
  assert.throws(() => createStaticCompanyMap([[DESK_COMPANY, 'a'], [DESK_COMPANY, 'b']]), /duplicate-key/);
});

// ---- 6. timeout and input checks ----

test('times out and aborts the request', async () => {
  const fetchImpl = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const c = client({ fetch: fetchImpl, timeoutMs: 20 });
  await assert.rejects(c.getBookingRequest(DESK_COMPANY, 'fbr_1'), (e) => e.code === 'field_link_timeout');
});

test('rejects invalid booking input before any request', async () => {
  const { fetchImpl, calls } = recordingFetch(() => json(201, {}));
  const c = client({ fetch: fetchImpl });
  await assert.rejects(c.createBookingRequest(DESK_COMPANY, { ...INPUT, idempotency_key: '' }), (e) => e.code === 'field_link_input_invalid');
  await assert.rejects(c.createBookingRequest(DESK_COMPANY, { ...INPUT, notes: 'x'.repeat(2001) }), (e) => e.code === 'field_link_input_invalid');
  assert.equal(calls.length, 0);
});
