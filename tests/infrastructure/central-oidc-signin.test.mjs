// Issue #193: sign-in initiation only. Central completes the code exchange; this suite
// covers discovery, the authorize request (resource, not audience), PKCE, the transaction
// and the binding cookie. No live calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  discover, beginSignIn, isLoginTransactionLive, buildBindingCookie, buildClearBindingCookie,
  OidcLoginError, DESK_CALLBACK_PATH, LOGIN_TRANSACTION_TTL_MS,
} from '../../server/infrastructure/central-oidc/oidc-client.ts';
import { createPkce } from '../../server/infrastructure/central-oidc/pkce.ts';
import {
  ORIGIN, AUTHORIZE, CLIENT_ID, AUDIENCE, signInConfig, routedFetch, standardRoutes, discoveryDoc,
} from './central-oidc-fixtures.mjs';

const REDIRECT = `https://supercharged.example.test${DESK_CALLBACK_PATH}`;
const NOW = Date.parse('2026-11-15T10:00:00Z');

async function startLogin(random) {
  const { fetcher } = routedFetch(standardRoutes());
  const disc = await discover(ORIGIN, fetcher);
  return beginSignIn({ config: signInConfig, discovery: disc, redirectUri: REDIRECT, nowMs: NOW, random });
}

test('PKCE S256 matches the RFC 7636 appendix B vector', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const pkce = createPkce(() => Buffer.from(verifier, 'base64url'));
  assert.equal(pkce.codeVerifier, verifier);
  assert.equal(pkce.codeChallenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(pkce.codeChallengeMethod, 'S256');
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), pkce.codeChallenge);
});

test('discovery rejects insecure endpoints, missing S256 and fetch failures', async () => {
  const bad = [
    { ...discoveryDoc, authorization_endpoint: 'http://central.example.test/auth' },
    { ...discoveryDoc, code_challenge_methods_supported: ['plain'] },
    { ...discoveryDoc, code_challenge_methods_supported: undefined },
  ];
  for (const doc of bad) {
    const { fetcher } = routedFetch({ '/.well-known/openid-configuration': doc });
    await assert.rejects(discover(ORIGIN, fetcher), (e) => e instanceof OidcLoginError && e.code === 'discovery_invalid');
  }
  const down = async () => { throw new Error('connect refused'); };
  await assert.rejects(discover(ORIGIN, down), (e) => e.code === 'discovery_invalid');
});

test('authorization request carries PKCE S256, state, nonce, client and resource', async () => {
  const { url, transaction } = await startLogin();
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, AUTHORIZE);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(u.searchParams.get('resource'), AUDIENCE);
  assert.equal(u.searchParams.get('audience'), null, 'audience must not be sent on the authorize request');
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), transaction.state);
  assert.equal(u.searchParams.get('nonce'), transaction.nonce);
  assert.equal(u.searchParams.get('redirect_uri'), REDIRECT);
  assert.equal(u.searchParams.get('client_secret'), null);
  assert.equal(createHash('sha256').update(transaction.codeVerifier).digest('base64url'), u.searchParams.get('code_challenge'));
});

test('redirect URI must be the registered desk callback', async () => {
  const { fetcher } = routedFetch(standardRoutes());
  const disc = await discover(ORIGIN, fetcher);
  assert.throws(() => beginSignIn({ config: signInConfig, discovery: disc, redirectUri: 'https://x.example.test/other', nowMs: NOW }), TypeError);
  assert.throws(() => beginSignIn({ config: signInConfig, discovery: disc, redirectUri: `${REDIRECT}?x=1`, nowMs: NOW }), TypeError);
});

test('login transaction is live for 10 minutes and not before it was created', async () => {
  const { transaction } = await startLogin();
  assert.equal(isLoginTransactionLive(transaction, NOW), true);
  assert.equal(isLoginTransactionLive(transaction, NOW + LOGIN_TRANSACTION_TTL_MS), true);
  assert.equal(isLoginTransactionLive(transaction, NOW + LOGIN_TRANSACTION_TTL_MS + 1), false);
  assert.equal(isLoginTransactionLive(transaction, NOW - 1), false);
});

test('binding cookie is host-only, Secure, HttpOnly, SameSite=Lax and has no Domain', () => {
  const cookie = buildBindingCookie('a'.repeat(43));
  const attrs = cookie.split('; ');
  assert.equal(attrs[0].startsWith('titan_desk_oidc_binding='), true);
  assert.deepEqual(attrs.slice(1).sort(), ['HttpOnly', 'Max-Age=600', 'Path=/', 'SameSite=Lax', 'Secure']);
  assert.equal(/domain=/i.test(cookie), false);
  assert.throws(() => buildBindingCookie('short'), TypeError);
  assert.match(buildClearBindingCookie(), /Max-Age=0/);
});
