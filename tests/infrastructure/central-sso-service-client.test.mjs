import test from 'node:test';
import assert from 'node:assert/strict';
import {createCentralServiceClient, CentralServiceError, assertNoTenantParams} from '../../server/infrastructure/central-sso/service-client.ts';

const ISSUER = 'https://central.example';
const META = {
 issuer: ISSUER,
 authorizationEndpoint: 'https://central.example/authorize',
 tokenEndpoint: 'https://central.example/token',
 jwksUri: 'https://central.example/jwks',
};
const SERVICE_AUD = 'urn:titan-central:product:supercharged';
// Test fixtures only. These are not real credentials.
const config = {
 enabled: true,
 issuer: ISSUER,
 clientId: 'desk-client-test',
 clientSecret: 'test-only-client-secret',
 redirectUri: 'https://desk.example/auth/central/callback',
 audience: 'desk-audience-test',
 companyClaim: 'company_id',
 serviceClientId: 'desk-service-test',
 serviceClientSecret: 'test-only-service-secret',
 apiBaseUrl: 'https://central.example/api/',
};

const b64u = (x) => Buffer.from(x).toString('base64url');
// Unsigned JWT is enough here: the service client checks aud and exp on tokens from the token endpoint, not the signature.
function jwt(payload) {
 return `${b64u(JSON.stringify({alg: 'RS256', typ: 'JWT'}))}.${b64u(JSON.stringify(payload))}.c2ln`;
}

function world({aud = SERVICE_AUD, expiresIn = 3600, exp, tokenStatus = 200, tokenBody, clockRef}) {
 const seen = {token: [], api: []};
 let n = 0;
 const fetchImpl = async (url, init) => {
  if (url === META.tokenEndpoint) {
   seen.token.push({url, body: init.body, redirect: init.redirect});
   if (tokenStatus !== 200) return new Response('{"error":"unauthorized_client"}', {status: tokenStatus});
   n += 1;
   const now = clockRef.now / 1000;
   const access = jwt({aud, exp: exp ?? now + expiresIn, sub: 'service', n});
   return new Response(JSON.stringify(tokenBody ?? {access_token: access, token_type: 'Bearer', expires_in: expiresIn}), {
    status: 200, headers: {'content-type': 'application/json'},
   });
  }
  seen.api.push({url, init});
  return new Response('{"ok":true}', {status: 200, headers: {'content-type': 'application/json'}});
 };
 const client = createCentralServiceClient({
  config,
  discovery: async () => META,
  fetchImpl,
  clock: () => clockRef.now,
 });
 return {client, seen};
}

test('service client refuses to exist unless enabled and fully configured', () => {
 const discovery = async () => META;
 assert.throws(() => createCentralServiceClient({config: {enabled: false}, discovery}), /enable Central SSO first/);
 assert.throws(() => createCentralServiceClient({config: {...config, serviceClientSecret: undefined}, discovery}), /service credentials required/);
 assert.throws(() => createCentralServiceClient({config: {...config, apiBaseUrl: 'http://central.example'}, discovery}), /https API base URL/);
});

test('client-credentials request uses the product audience and the discovered token endpoint', async () => {
 const clockRef = {now: Date.now()};
 const {client, seen} = world({clockRef});
 const res = await client.request('/v1/access-check', {method: 'GET'});
 assert.equal(res.status, 200);
 const body = new URLSearchParams(seen.token[0].body);
 assert.equal(body.get('grant_type'), 'client_credentials');
 assert.equal(body.get('audience'), SERVICE_AUD);
 assert.equal(body.get('client_id'), config.serviceClientId);
 assert.equal(seen.token[0].redirect, 'error');
 assert.equal(seen.api[0].url, 'https://central.example/api/v1/access-check');
 assert.equal(seen.api[0].init.headers.authorization.startsWith('Bearer '), true);
});

test('token is cached, and refreshed before it expires', async () => {
 const clockRef = {now: Date.now()};
 const {client, seen} = world({clockRef, expiresIn: 600});
 await client.request('/v1/a');
 await client.request('/v1/b');
 assert.equal(seen.token.length, 1);
 clockRef.now += 600_000 - 30_000; // inside the 60 s leeway
 await client.request('/v1/c');
 assert.equal(seen.token.length, 2);
});

test('concurrent callers share one token request', async () => {
 const clockRef = {now: Date.now()};
 const {client, seen} = world({clockRef});
 await Promise.all([client.request('/v1/a'), client.request('/v1/b'), client.getAccessToken()]);
 assert.equal(seen.token.length, 1);
});

test('a token for another product audience is refused and never sent to the API', async () => {
 const clockRef = {now: Date.now()};
 const {client, seen} = world({clockRef, aud: 'urn:titan-central:product:other'});
 await assert.rejects(client.request('/v1/access-check'), (e) => e instanceof CentralServiceError && e.code === 'audience_mismatch');
 assert.equal(seen.api.length, 0);
});

test('an opaque (non-JWT) access token cannot be audience-checked and is refused', async () => {
 const clockRef = {now: Date.now()};
 const {client, seen} = world({clockRef, tokenBody: {access_token: 'opaque-token-value-123456', token_type: 'Bearer', expires_in: 600}});
 await assert.rejects(client.request('/v1/x'), (e) => e.code === 'token_not_checkable');
 assert.equal(seen.api.length, 0);
});

test('expired or short-lived tokens and bad token types are refused', async () => {
 const clockRef = {now: Date.now()};
 let w = world({clockRef, exp: Math.floor(clockRef.now / 1000) - 5});
 await assert.rejects(w.client.request('/v1/x'), (e) => e.code === 'token_expiry');
 w = world({clockRef, expiresIn: 30});
 await assert.rejects(w.client.request('/v1/x'), (e) => e.code === 'token_expiry');
 w = world({clockRef, tokenBody: {access_token: jwt({aud: SERVICE_AUD, exp: Math.floor(clockRef.now / 1000) + 600}), token_type: 'mac', expires_in: 600}});
 await assert.rejects(w.client.request('/v1/x'), (e) => e.code === 'token_type');
});

test('token endpoint failure surfaces a fixed code without the response body', async () => {
 const clockRef = {now: Date.now()};
 const {client} = world({clockRef, tokenStatus: 401});
 await assert.rejects(client.request('/v1/x'), (e) => e.code === 'token_request_failed' && !/unauthorized_client/.test(e.message));
});

test('tenant selectors are refused in query, body, and nested body, before any token request', async () => {
 const clockRef = {now: Date.now()};
 const {client, seen} = world({clockRef});
 await assert.rejects(client.request('/v1/x', {query: {organisation_id: 'abc'}}), (e) => e.code === 'tenant_param_forbidden');
 await assert.rejects(client.request('/v1/x', {method: 'POST', body: {tenant: 'abc'}}), (e) => e.code === 'tenant_param_forbidden');
 await assert.rejects(client.request('/v1/x', {method: 'POST', body: {filter: {cohort: 'x'}}}), (e) => e.code === 'tenant_param_forbidden');
 await assert.rejects(client.request('/v1/x', {query: {Organization_ID: 'abc'}}), (e) => e.code === 'tenant_param_forbidden');
 assert.equal(seen.token.length, 0);
 assert.equal(seen.api.length, 0);
});

test('bad paths that escape the API base are refused', async () => {
 const clockRef = {now: Date.now()};
 const {client} = world({clockRef});
 for (const p of ['https://evil.example/x', '//evil.example/x', 'v1/x', '/../secret']) {
  await assert.rejects(client.request(p), (e) => e.code === 'bad_path', p);
 }
});

test('assertNoTenantParams passes ordinary payloads', () => {
 assertNoTenantParams({name: 'job', items: [{id: 1}], nested: {visit: 'x'}});
 assert.throws(() => assertNoTenantParams({a: {b: {c: {d: {e: {f: {g: {h: {i: {tenant: 1}}}}}}}}}}), /payload_too_deep/);
 assert.throws(() => assertNoTenantParams({a: {b: {c: {d: {e: {f: {g: {h: {tenant: 1}}}}}}}}}), /tenant_param_forbidden/);
});
