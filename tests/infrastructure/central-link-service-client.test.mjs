import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readCentralServiceConfig,
  CentralConfigError,
} from '../../server/infrastructure/central-link/config.ts';
import {
  createCentralServiceClient,
  assertNoTenantFields,
  CentralServiceError,
} from '../../server/infrastructure/central-link/service-client.ts';

const AUDIENCE = 'urn:titan-central:product:supercharged';
const ORIGIN = 'https://central.example.test';
const config = {
  origin: ORIGIN,
  tokenUrl: `${ORIGIN}/oidc/token`,
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret-value',
  audience: AUDIENCE,
};

// Unsigned test JWT. Supercharged only reads aud locally; Central verifies the signature.
function jwt(aud, extra = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({alg: 'EdDSA', typ: 'JWT'})}.${enc({aud, sub: 'svc', ...extra})}.c2ln`;
}

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({url, init});
    const next = responses.shift();
    if (!next) throw new Error('unexpected extra fetch');
    return {
      ok: next.status === undefined ? true : next.status >= 200 && next.status < 300,
      status: next.status ?? 200,
      json: async () => {
        if (next.badJson) throw new SyntaxError('bad json');
        return next.body;
      },
    };
  };
  return {fn, calls};
}

const tokenResponse = (token, extra = {}) => ({body: {access_token: token, token_type: 'Bearer', expires_in: 3600, ...extra}});

test('service config names missing variables and refuses non-https or wrong-origin token URLs', () => {
  const env = {
    CENTRAL_ORIGIN: ORIGIN,
    CENTRAL_TOKEN_URL: config.tokenUrl,
    CENTRAL_SERVICE_CLIENT_ID: config.clientId,
    CENTRAL_SERVICE_CLIENT_SECRET: config.clientSecret,
    CENTRAL_SERVICE_AUDIENCE: AUDIENCE,
  };
  assert.equal(readCentralServiceConfig(env).audience, AUDIENCE);
  for (const name of Object.keys(env)) {
    assert.throws(
      () => readCentralServiceConfig({...env, [name]: undefined}),
      (e) => e instanceof CentralConfigError && e.message.includes(name),
      name,
    );
  }
  assert.throws(() => readCentralServiceConfig({...env, CENTRAL_ORIGIN: 'http://central.example.test'}), CentralConfigError);
  assert.throws(() => readCentralServiceConfig({...env, CENTRAL_TOKEN_URL: 'https://other.example.test/t'}), CentralConfigError);
  assert.throws(() => readCentralServiceConfig({...env, CENTRAL_SERVICE_AUDIENCE: 'titan-central'}), CentralConfigError);
});

test('token is requested with client credentials and the product audience, then used as a bearer', async () => {
  const token = jwt(AUDIENCE);
  const {fn, calls} = fakeFetch([tokenResponse(token), {body: {ok: true}}]);
  const client = createCentralServiceClient({config, fetchImpl: fn, nowMs: () => 1});
  const result = await client.request({method: 'GET', path: '/v1/access/check', query: {product: 'supercharged'}});
  assert.deepEqual(result, {status: 200, body: {ok: true}});

  const [tokenCall, apiCall] = calls;
  assert.equal(tokenCall.url, config.tokenUrl);
  assert.equal(tokenCall.init.method, 'POST');
  assert.equal(tokenCall.init.redirect, 'error');
  assert.equal(
    tokenCall.init.headers.Authorization,
    `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`,
  );
  const form = new URLSearchParams(tokenCall.init.body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('audience'), AUDIENCE);
  assert.deepEqual([...form.keys()].sort(), ['audience', 'grant_type']);

  assert.equal(apiCall.url, `${ORIGIN}/v1/access/check?product=supercharged`);
  assert.equal(apiCall.init.headers.Authorization, `Bearer ${token}`);
  assert.equal(apiCall.init.body, undefined);
});

test('a valid token is reused until shortly before expiry, then refreshed', async () => {
  const token = jwt(AUDIENCE);
  const {fn, calls} = fakeFetch([
    tokenResponse(token, {expires_in: 3600}),
    {body: {ok: 1}},
    {body: {ok: 2}},
    tokenResponse(jwt(AUDIENCE, {n: 2}), {expires_in: 3600}),
    {body: {ok: 3}},
  ]);
  let now = 1_000_000;
  const client = createCentralServiceClient({config, fetchImpl: fn, nowMs: () => now});
  assert.deepEqual((await client.request({method: 'GET', path: '/v1/x'})).body, {ok: 1});
  assert.deepEqual((await client.request({method: 'GET', path: '/v1/x'})).body, {ok: 2});
  assert.equal(calls.filter((c) => c.init.method === 'POST').length, 1);
  now += (3600 - 30) * 1000; // inside the 60 s refresh window
  assert.deepEqual((await client.request({method: 'GET', path: '/v1/x'})).body, {ok: 3});
  assert.equal(calls.filter((c) => c.init.method === 'POST').length, 2);
});

test('concurrent calls share one token request', async () => {
  const {fn, calls} = fakeFetch([tokenResponse(jwt(AUDIENCE)), {body: {a: 1}}, {body: {a: 2}}]);
  const client = createCentralServiceClient({config, fetchImpl: fn, nowMs: () => 1});
  await Promise.all([client.request({method: 'GET', path: '/v1/a'}), client.request({method: 'GET', path: '/v1/b'})]);
  assert.equal(calls.filter((c) => c.init.method === 'POST').length, 1);
});

test('a wrong-audience token is refused and not cached', async () => {
  const {fn, calls} = fakeFetch([
    tokenResponse(jwt('urn:titan-central:product:sorted')),
    tokenResponse(jwt(['urn:titan-central:product:lms'])),
    tokenResponse(jwt(AUDIENCE)),
    {body: {ok: true}},
  ]);
  const client = createCentralServiceClient({config, fetchImpl: fn, nowMs: () => 1});
  await assert.rejects(client.request({method: 'GET', path: '/v1/x'}),
    (e) => e instanceof CentralServiceError && e.code === 'wrong_audience');
  await assert.rejects(client.request({method: 'GET', path: '/v1/x'}),
    (e) => e instanceof CentralServiceError && e.code === 'wrong_audience');
  // Nothing was cached, so the next call asks again and succeeds with a correct token.
  assert.deepEqual((await client.request({method: 'GET', path: '/v1/x'})).body, {ok: true});
  assert.equal(calls.filter((c) => c.init.method === 'POST').length, 3);
});

test('an opaque, non-JWT token is refused because its audience cannot be checked', async () => {
  const {fn} = fakeFetch([tokenResponse('opaque-token-without-dots')]);
  const client = createCentralServiceClient({config, fetchImpl: fn, nowMs: () => 1});
  await assert.rejects(client.request({method: 'GET', path: '/v1/x'}),
    (e) => e instanceof CentralServiceError && e.code === 'token_invalid');
});

test('organisation, tenant and cohort fields are refused in query and body before any fetch', async () => {
  const {fn, calls} = fakeFetch([]);
  const client = createCentralServiceClient({config, fetchImpl: fn, nowMs: () => 1});
  const cases = [
    {method: 'GET', path: '/v1/x', query: {organisation_id: 'o1'}},
    {method: 'GET', path: '/v1/x', query: {organisationId: 'o1'}},
    {method: 'POST', path: '/v1/x', body: {tenant: 't1'}},
    {method: 'POST', path: '/v1/x', body: {filter: {nested: {cohort: 'beta'}}}},
    {method: 'POST', path: '/v1/x', body: [{organization_id: 'o'}]},
  ];
  for (const c of cases) {
    await assert.rejects(client.request(c), (e) => e instanceof CentralServiceError && e.code === 'tenant_parameter_refused');
  }
  assert.equal(calls.length, 0);
});

test('paths carrying a query string or an absolute URL are refused', async () => {
  const {fn} = fakeFetch([]);
  const client = createCentralServiceClient({config, fetchImpl: fn, nowMs: () => 1});
  for (const path of ['/v1/x?organisation_id=o', 'https://evil.example.test/x', '//evil.example.test/x', 'v1/x']) {
    await assert.rejects(client.request({method: 'GET', path}), (e) => e instanceof CentralServiceError && e.code === 'invalid_path', path);
  }
});

test('a 401 clears the cached token so the next call fetches a new one', async () => {
  const {fn, calls} = fakeFetch([
    tokenResponse(jwt(AUDIENCE, {n: 1})),
    {status: 401, body: {error: 'unauthorized'}},
    tokenResponse(jwt(AUDIENCE, {n: 2})),
    {body: {ok: true}},
  ]);
  const client = createCentralServiceClient({config, fetchImpl: fn, nowMs: () => 1});
  assert.equal((await client.request({method: 'GET', path: '/v1/x'})).status, 401);
  assert.equal((await client.request({method: 'GET', path: '/v1/x'})).status, 200);
  assert.equal(calls.filter((c) => c.init.method === 'POST').length, 2);
});

test('token failures do not leak the token, the secret or the response body', async () => {
  const secretLike = 'SUPER-SECRET-SENTINEL-VALUE';
  const {fn} = fakeFetch([{status: 500, body: {access_token: secretLike}}]);
  const client = createCentralServiceClient({config, fetchImpl: fn, nowMs: () => 1});
  await assert.rejects(client.request({method: 'GET', path: '/v1/x'}), (e) => {
    assert.equal(e.code, 'token_request_failed');
    assert.ok(!String(e.message).includes(secretLike));
    assert.ok(!String(e.message).includes(config.clientSecret));
    return true;
  });
});

test('no token or secret is written to the console during a successful call', async () => {
  const token = jwt(AUDIENCE, {marker: 'LOG-SENTINEL'});
  const {fn} = fakeFetch([tokenResponse(token), {body: {ok: true}}]);
  const seen = [];
  const original = {};
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
    original[m] = console[m];
    console[m] = (...args) => seen.push(args.map(String).join(' '));
  }
  try {
    const client = createCentralServiceClient({config, fetchImpl: fn, nowMs: () => 1});
    await client.request({method: 'GET', path: '/v1/x'});
  } finally {
    for (const m of Object.keys(original)) console[m] = original[m];
  }
  const joined = seen.join('\n');
  assert.ok(!joined.includes(token));
  assert.ok(!joined.includes('LOG-SENTINEL'));
  assert.ok(!joined.includes(config.clientSecret));
});

test('assertNoTenantFields accepts ordinary payloads', () => {
  assertNoTenantFields({name: 'job', items: [{id: 1}]}, 'body');
  assertNoTenantFields(undefined, 'query');
  assert.throws(() => assertNoTenantFields({a: [{Tenant_Id: 'x'}]}, 'body'), CentralServiceError);
});
