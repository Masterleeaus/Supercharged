import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, sign as cryptoSign} from 'node:crypto';
import {loadCentralSsoConfig, CENTRAL_SERVICE_AUDIENCE} from '../../server/infrastructure/central-sso/config.ts';
import {createPkce} from '../../server/infrastructure/central-sso/pkce.ts';
import {createCentralOidcFlow, createMemoryPendingStore, txnCookieHeader, globalLogoutUrl} from '../../server/infrastructure/central-sso/oidc-flow.ts';
import {createCentralSignIn} from '../../server/infrastructure/central-sso/sign-in.ts';
import {createDeskCentralAccountResolver} from '../../server/infrastructure/central-sso/account-resolver.ts';
import {createDiscoveryClient, createJwksClient} from '../../server/infrastructure/central-sso/discovery.ts';
import {isVerifiedDeskCentralSelection} from '../../server/infrastructure/central-sso/selection-contract.ts';

const ISSUER = 'https://central.example';
const COMPANY = '00000000-0000-4000-8000-000000000001';
const OTHER_COMPANY = '00000000-0000-4000-8000-000000000002';
const META = {
 issuer: ISSUER,
 authorizationEndpoint: 'https://central.example/authorize',
 tokenEndpoint: 'https://central.example/token',
 jwksUri: 'https://central.example/jwks',
};
// Test fixtures only. These are not real credentials.
const config = {
 enabled: true,
 issuer: ISSUER,
 clientId: 'desk-client-test',
 clientSecret: 'test-only-client-secret',
 redirectUri: 'https://desk.example/auth/central/callback',
 audience: 'desk-audience-test',
 companyClaim: 'company_id',
};

const rsa = generateKeyPairSync('rsa', {modulusLength: 2048});
const ec = generateKeyPairSync('ec', {namedCurve: 'P-256'});
const rsaJwk = {...rsa.publicKey.export({format: 'jwk'}), kid: 'rsa-1', alg: 'RS256', use: 'sig'};
const ecJwk = {...ec.publicKey.export({format: 'jwk'}), kid: 'ec-1', alg: 'ES256', use: 'sig'};
const JWKS = {keys: [rsaJwk, ecJwk]};

const b64u = (x) => Buffer.from(x).toString('base64url');
function signJwt(header, payload, {privateKey, hash, ieee}) {
 const h = b64u(JSON.stringify(header));
 const p = b64u(JSON.stringify(payload));
 const data = Buffer.from(`${h}.${p}`);
 const sig = ieee ? cryptoSign(hash, data, {key: privateKey, dsaEncoding: 'ieee-p1363'}) : cryptoSign(hash, data, privateKey);
 return `${h}.${p}.${sig.toString('base64url')}`;
}
function makeIdToken(overrides = {}, {nonce, alg = 'RS256', drop = []} = {}) {
 const now = Math.floor(Date.now() / 1000);
 const payload = {
  iss: ISSUER, aud: config.audience, sub: 'central-user-1', iat: now, exp: now + 300,
  nonce, [config.companyClaim]: COMPANY, ...overrides,
 };
 for (const k of drop) delete payload[k];
 if (alg === 'RS256') return signJwt({alg, kid: 'rsa-1', typ: 'JWT'}, payload, {privateKey: rsa.privateKey, hash: 'sha256'});
 if (alg === 'ES256') return signJwt({alg, kid: 'ec-1', typ: 'JWT'}, payload, {privateKey: ec.privateKey, hash: 'sha256', ieee: true});
 throw new Error('unsupported test alg');
}

function setup({cfg = config, status = 200, idTokenFor} = {}) {
 const ctx = {tokenCalls: [], idToken: null};
 const fetchImpl = async (url, init) => {
  if (url === META.tokenEndpoint) {
   ctx.tokenCalls.push({url, init});
   if (status !== 200) return new Response('{"error":"invalid_grant"}', {status});
   const id = idTokenFor ? idTokenFor(ctx) : ctx.idToken;
   return new Response(JSON.stringify({id_token: id, access_token: 'x'}), {status: 200, headers: {'content-type': 'application/json'}});
  }
  throw new Error(`unexpected fetch ${url}`);
 };
 const pending = createMemoryPendingStore();
 const flow = createCentralOidcFlow({
  config: cfg,
  discovery: async () => META,
  jwksKeys: async (kid) => JWKS.keys.find((k) => k.kid === kid) ?? null,
  pending,
  fetchImpl,
 });
 return {ctx, flow};
}

async function startLogin(flow, ctx) {
 const s = await flow.start();
 assert.equal(s.ok, true);
 const url = new URL(s.redirectUrl);
 const nonce = url.searchParams.get('nonce');
 ctx.lastNonce = nonce;
 ctx.idToken = makeIdToken({}, {nonce});
 return {state: s.state, nonce, url};
}

const complete = (flow, state, extra = {}, cookie = state) =>
 flow.complete({query: {code: 'auth-code-1', state, ...extra}, cookieState: cookie});

// ---- config ----

test('Central SSO is off by default and needs the exact flag value', () => {
 assert.deepEqual(loadCentralSsoConfig({}), {enabled: false});
 assert.deepEqual(loadCentralSsoConfig({CENTRAL_SSO_ENABLED: 'yes', CENTRAL_OIDC_ISSUER: 'x'}), {enabled: false});
});

test('enabled config refuses missing or unsafe values without echoing secrets', () => {
 const good = {
  CENTRAL_SSO_ENABLED: 'true', CENTRAL_OIDC_ISSUER: ISSUER, CENTRAL_OIDC_CLIENT_ID: 'c',
  CENTRAL_OIDC_CLIENT_SECRET: 'sekrit-value-xyz', CENTRAL_OIDC_REDIRECT_URI: config.redirectUri,
  TITAN_DESK_AUDIENCE: 'aud', CENTRAL_COMPANY_CLAIM: 'company_id',
 };
 assert.equal(loadCentralSsoConfig(good).enabled, true);
 for (const patch of [
  {CENTRAL_OIDC_ISSUER: 'http://central.example'},
  {CENTRAL_OIDC_ISSUER: 'https://user:pw@central.example'},
  {CENTRAL_OIDC_REDIRECT_URI: 'http://desk.example/cb'},
  {TITAN_DESK_AUDIENCE: ''},
  {CENTRAL_COMPANY_CLAIM: undefined},
  {CENTRAL_OIDC_CLIENT_SECRET: undefined},
  {CENTRAL_SERVICE_CLIENT_ID: 'only-id'},
 ]) {
  let err = null;
  try { loadCentralSsoConfig({...good, ...patch}); } catch (e) { err = e; }
  assert.ok(err, `expected refusal for ${JSON.stringify(patch)}`);
  assert.doesNotMatch(err.message, /sekrit-value-xyz/);
 }
});

test('http redirect is allowed only for localhost', () => {
 const base = {
  CENTRAL_SSO_ENABLED: 'true', CENTRAL_OIDC_ISSUER: ISSUER, CENTRAL_OIDC_CLIENT_ID: 'c',
  CENTRAL_OIDC_CLIENT_SECRET: 's', TITAN_DESK_AUDIENCE: 'aud', CENTRAL_COMPANY_CLAIM: 'company_id',
 };
 assert.equal(loadCentralSsoConfig({...base, CENTRAL_OIDC_REDIRECT_URI: 'http://localhost:3000/cb'}).enabled, true);
});

// ---- PKCE and start ----

test('PKCE S256 matches the RFC 7636 appendix B vector', () => {
 const verifierBytes = Buffer.from('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'base64url');
 const p = createPkce(() => verifierBytes);
 assert.equal(p.codeVerifier, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
 assert.equal(p.codeChallenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
 assert.equal(p.codeChallengeMethod, 'S256');
});

test('start builds a code+PKCE request on the discovered authorization endpoint', async () => {
 const {flow} = setup();
 const s = await flow.start();
 assert.equal(s.ok, true);
 const u = new URL(s.redirectUrl);
 assert.equal(u.origin + u.pathname, META.authorizationEndpoint);
 const q = Object.fromEntries(u.searchParams);
 assert.equal(q.response_type, 'code');
 assert.equal(q.client_id, config.clientId);
 assert.equal(q.redirect_uri, config.redirectUri);
 assert.equal(q.code_challenge_method, 'S256');
 assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
 assert.equal(q.state, s.state);
 assert.ok(q.nonce && q.nonce !== s.state);
 assert.equal(u.searchParams.has('implicit'), false);
 assert.equal(q.response_type.includes('token'), false);
});

test('start refuses when the flag is off', async () => {
 const {flow} = setup({cfg: {enabled: false}});
 assert.deepEqual(await flow.start(), {ok: false, reason: 'disabled'});
 assert.deepEqual(await complete(flow, 'abc'), {ok: false, reason: 'disabled'});
});

// ---- callback happy path and binding ----

test('valid callback yields a verified selection that the existing contract accepts', async () => {
 const {flow, ctx} = setup();
 const {state} = await startLogin(flow, ctx);
 const r = await complete(flow, state);
 assert.equal(r.ok, true);
 assert.deepEqual(Object.keys(r.selection).sort(), ['audience', 'authority', 'companyId', 'issuer', 'subject', 'verifiedAt']);
 assert.equal(r.selection.companyId, COMPANY);
 assert.equal(r.selection.subject, 'central-user-1');
 assert.equal(r.selection.authority, 'central-verified');
 assert.equal(isVerifiedDeskCentralSelection(r.selection), true);
});

test('token exchange sends the PKCE verifier that matches the start challenge', async () => {
 const {flow, ctx} = setup();
 const {state, url} = await startLogin(flow, ctx);
 await complete(flow, state);
 const body = ctx.tokenCalls[0].init.body;
 assert.equal(body.get('grant_type'), 'authorization_code');
 assert.equal(body.get('code'), 'auth-code-1');
 const verifier = body.get('code_verifier');
 assert.equal(createHash('sha256').update(verifier, 'ascii').digest('base64url'), url.searchParams.get('code_challenge'));
 assert.equal(ctx.tokenCalls[0].init.redirect, 'error');
});

test('state mismatch and missing browser binding fail before any token request', async () => {
 const {flow, ctx} = setup();
 const {state} = await startLogin(flow, ctx);
 assert.deepEqual(await complete(flow, state, {}, 'other-state'), {ok: false, reason: 'state_mismatch'});
 assert.deepEqual(await flow.complete({query: {code: 'auth-code-1', state}, cookieState: undefined}), {ok: false, reason: 'state_mismatch'});
 assert.equal(ctx.tokenCalls.length, 0);
});

test('a replayed callback with the same state is refused', async () => {
 const {flow, ctx} = setup();
 const {state} = await startLogin(flow, ctx);
 assert.equal((await complete(flow, state)).ok, true);
 assert.deepEqual(await complete(flow, state), {ok: false, reason: 'unknown_state'});
 assert.equal(ctx.tokenCalls.length, 1);
});

test('unknown state and provider error parameters fail closed', async () => {
 const {flow} = setup();
 assert.deepEqual(await complete(flow, 'never-issued'), {ok: false, reason: 'unknown_state'});
 assert.deepEqual(await flow.complete({query: {error: 'access_denied', state: 'x'}, cookieState: 'x'}), {ok: false, reason: 'provider_error'});
 assert.deepEqual(await flow.complete({query: {state: 'x'}, cookieState: 'x'}), {ok: false, reason: 'bad_request'});
});

test('token endpoint errors and missing id_token fail without leaking the body', async () => {
 let {flow, ctx} = setup({status: 400});
 let s = await startLogin(flow, ctx);
 assert.deepEqual(await complete(flow, s.state), {ok: false, reason: 'token_exchange'});
 ({flow, ctx} = setup({idTokenFor: () => undefined}));
 s = await startLogin(flow, ctx);
 assert.deepEqual(await complete(flow, s.state), {ok: false, reason: 'token_exchange'});
});

// ---- ID token checks ----

async function reasonFor(idTokenFor) {
 const {flow, ctx} = setup({idTokenFor});
 const {state} = await startLogin(flow, ctx);
 const r = await complete(flow, state);
 return r.ok ? 'ok' : r.reason;
}

test('ID token with the wrong audience is refused', async () => {
 assert.equal(await reasonFor((ctx) => makeIdToken({aud: 'another-app'}, {nonce: nonceOf(ctx)})), 'audience');
});

test('expired ID token is refused', async () => {
 assert.equal(await reasonFor((ctx) => makeIdToken({exp: Math.floor(Date.now() / 1000) - 3600}, {nonce: nonceOf(ctx)})), 'expired');
});

test('wrong issuer and nonce mismatch are refused', async () => {
 assert.equal(await reasonFor((ctx) => makeIdToken({iss: 'https://evil.example'}, {nonce: nonceOf(ctx)})), 'issuer');
 assert.equal(await reasonFor((ctx) => makeIdToken({}, {nonce: 'replayed-nonce'})), 'nonce');
});

test('alg none and HS256 are refused, and a tampered payload fails the signature', async () => {
 assert.equal(await reasonFor((ctx) => {
  const h = b64u(JSON.stringify({alg: 'none', kid: 'rsa-1'}));
  const p = b64u(JSON.stringify({iss: ISSUER, aud: config.audience, sub: 's', exp: 9999999999, nonce: nonceOf(ctx), company_id: COMPANY}));
  return `${h}.${p}.`;
 }), 'alg_not_allowed');
 assert.equal(await reasonFor((ctx) => {
  const h = b64u(JSON.stringify({alg: 'HS256', kid: 'rsa-1'}));
  const p = b64u(JSON.stringify({iss: ISSUER, aud: config.audience, sub: 's', exp: 9999999999, nonce: nonceOf(ctx), company_id: COMPANY}));
  const sig = createHash('sha256').update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
 }), 'alg_not_allowed');
 assert.equal(await reasonFor((ctx) => {
  const good = makeIdToken({}, {nonce: nonceOf(ctx)});
  const [h, , s] = good.split('.');
  const forged = b64u(JSON.stringify({iss: ISSUER, aud: config.audience, sub: 'someone-else', exp: 9999999999, nonce: nonceOf(ctx), company_id: COMPANY}));
  return `${h}.${forged}.${s}`;
 }), 'bad_signature');
});

test('unknown kid is refused', async () => {
 assert.equal(await reasonFor((ctx) => {
  const t = makeIdToken({}, {nonce: nonceOf(ctx)});
  const [, p, s] = t.split('.');
  return `${b64u(JSON.stringify({alg: 'RS256', kid: 'not-published'}))}.${p}.${s}`;
 }), 'unknown_key');
});

test('ES256 ID token from a published key verifies', async () => {
 assert.equal(await reasonFor((ctx) => makeIdToken({}, {nonce: nonceOf(ctx), alg: 'ES256'})), 'ok');
});

test('multi-audience token needs azp to equal the client id', async () => {
 assert.equal(await reasonFor((ctx) => makeIdToken({aud: [config.audience, 'other-app']}, {nonce: nonceOf(ctx)})), 'audience');
 assert.equal(await reasonFor((ctx) => makeIdToken({aud: [config.audience, 'other-app'], azp: config.clientId}, {nonce: nonceOf(ctx)})), 'ok');
});

// ---- company (tenant) claim ----

test('company must come from the verified claim; missing or non-UUID values fail closed', async () => {
 assert.equal(await reasonFor((ctx) => makeIdToken({}, {nonce: nonceOf(ctx), drop: ['company_id']})), 'company_claim');
 assert.equal(await reasonFor((ctx) => makeIdToken({company_id: 'Acme Ltd'}, {nonce: nonceOf(ctx)})), 'company_claim');
});

test('a company id sent in the query string is never used as the tenant', async () => {
 const {flow, ctx} = setup();
 ctx.idToken = null;
 const s = await flow.start();
 const nonce = new URL(s.redirectUrl).searchParams.get('nonce');
 ctx.idToken = makeIdToken({}, {nonce, drop: ['company_id']});
 const r = await complete(flow, s.state, {company_id: OTHER_COMPANY, email: 'boss@example.org'});
 assert.deepEqual(r, {ok: false, reason: 'company_claim'});
});

test('the selected company is the one in the verified token, not any other', async () => {
 const {flow, ctx} = setup({idTokenFor: (c) => makeIdToken({company_id: OTHER_COMPANY}, {nonce: nonceOf(c)})});
 const {state} = await startLogin(flow, ctx);
 const r = await complete(flow, state, {company_id: COMPANY});
 assert.equal(r.ok, true);
 assert.equal(r.selection.companyId, OTHER_COMPANY);
});

// helper: the nonce for the most recent start on a context. Set by startLogin via ctx.
function nonceOf(ctx) {
 return ctx.lastNonce;
}

// ---- cookies, logout, pending store ----

test('transaction cookie is host-only (__Host- prefix, no Domain), HttpOnly, Secure', () => {
 const c = txnCookieHeader('abc');
 assert.match(c, /^__Host-central_sso_txn=abc;/);
 assert.match(c, /Path=\//);
 assert.match(c, /HttpOnly/);
 assert.match(c, /Secure/);
 assert.match(c, /SameSite=Lax/);
 assert.doesNotMatch(c, /Domain=/i);
});

test('global logout uses only the configured https URL', () => {
 assert.equal(globalLogoutUrl({enabled: false}), null);
 assert.equal(globalLogoutUrl({...config, enabled: true}), null);
 assert.equal(globalLogoutUrl({...config, enabled: true, globalLogoutUrl: 'https://central.example/auth/titan/global-logout'}), 'https://central.example/auth/titan/global-logout');
});

test('pending store is single use and expires', () => {
 let now = 0;
 const store = createMemoryPendingStore({clock: () => now});
 store.put('s1', {codeVerifier: 'v', nonce: 'n'}, 1000);
 assert.deepEqual(store.take('s1'), {codeVerifier: 'v', nonce: 'n'});
 assert.equal(store.take('s1'), null);
 store.put('s2', {codeVerifier: 'v', nonce: 'n'}, 1000);
 now = 1000;
 assert.equal(store.take('s2'), null);
});

// ---- discovery and JWKS ----

test('discovery rejects an issuer mismatch and caches a good document', async () => {
 let calls = 0;
 const good = {issuer: ISSUER, authorization_endpoint: META.authorizationEndpoint, token_endpoint: META.tokenEndpoint, jwks_uri: META.jwksUri};
 const fetchImpl = async () => {
  calls++;
  return new Response(JSON.stringify(calls === 1 ? {...good, issuer: 'https://other.example'} : good), {status: 200});
 };
 const get = createDiscoveryClient({issuer: ISSUER, fetchImpl});
 await assert.rejects(get(), /issuer mismatch/);
 assert.equal((await get()).tokenEndpoint, META.tokenEndpoint);
 await get();
 assert.equal(calls, 2);
});

test('JWKS refetches on an unknown kid at most once a minute', async () => {
 let calls = 0;
 let now = 0;
 const getKey = createJwksClient({jwksUri: META.jwksUri, clock: () => now, fetchImpl: async () => {
  calls++;
  return new Response(JSON.stringify(JWKS), {status: 200});
 }});
 assert.equal(await getKey('nope'), null);
 assert.equal(await getKey('nope'), null);
 assert.equal(calls, 2);
 now = 61_000;
 assert.equal(await getKey('nope'), null);
 assert.equal(calls, 3);
});

// ---- sign-in wiring with the existing resolver and session gate ----

test('sign-in issues a native session only for a linked, active local account', async () => {
 const {flow, ctx} = setup();
 const issued = [];
 const resolver = createDeskCentralAccountResolver({
  resolveCompanyBinding: async () => COMPANY,
  authoriseCentral: async () => true,
  queryLink: async () => [{user_id: 'local-user-9', company_id: COMPANY, role: 'admin', revision: 3, is_active: true}],
 });
 const signIn = createCentralSignIn({
  complete: (input) => flow.complete(input),
  resolve: resolver,
  issueNativeToken: async (...args) => {
   issued.push(args);
   return 'n'.repeat(64);
  },
 });
 const {state} = await startLogin(flow, ctx);
 assert.deepEqual(await signIn({query: {code: 'c', state}, cookieState: state}), {ok: true, token: 'n'.repeat(64), account: {userId: 'local-user-9', companyId: COMPANY, role: 'admin', revision: 3}});
 assert.deepEqual(issued, [['local-user-9', 'admin', COMPANY]]);
});

test('sign-in with no local link or a revoked entitlement issues nothing', async () => {
 const {flow, ctx} = setup();
 const issued = [];
 const signIn = createCentralSignIn({
  complete: (input) => flow.complete(input),
  resolve: createDeskCentralAccountResolver({
   resolveCompanyBinding: async () => COMPANY,
   authoriseCentral: async () => false,
   queryLink: async () => [{user_id: 'local-user-9', company_id: COMPANY, role: 'admin', revision: 3, is_active: true}],
  }),
  issueNativeToken: async () => {
   issued.push(1);
   return 'n'.repeat(64);
  },
 });
 const {state} = await startLogin(flow, ctx);
 assert.deepEqual(await signIn({query: {code: 'c', state}, cookieState: state}), {ok: false, reason: 'no_local_account'});
 assert.equal(issued.length, 0);
});

test('the service audience constant is the value from the Central issue', () => {
 assert.equal(CENTRAL_SERVICE_AUDIENCE, 'urn:titan-central:product:supercharged');
});
