// Issue #197: direct fixture tests for Central ID token verification.
// Keys are generated in memory per run. No Central values, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { verifyIdToken } from '../../server/infrastructure/central-sso/id-token.ts';

const ISSUER = 'https://central.example.test/oidc';
const AUDIENCE = 'urn:test:desk-audience';
const CLIENT_ID = 'desk-client-test';
const NONCE = 'nonce-fixture-1';
const KID = 'kid-fixture-rsa';
const NOW_MS = Date.parse('2026-11-15T10:00:00Z');
const NOW_S = NOW_MS / 1000;

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const rsaJwk = { ...rsa.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' };
const ecJwk = { ...ec.publicKey.export({ format: 'jwk' }), kid: 'kid-fixture-ec', alg: 'ES256', use: 'sig' };

const b64u = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');

function jwt({ header = {}, payload = {}, alg = 'RS256', kid = KID, key = rsa.privateKey } = {}) {
  const h = { alg, kid, typ: 'JWT', ...header };
  const p = {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'user-subject-1',
    nonce: NONCE,
    iat: NOW_S - 10,
    exp: NOW_S + 300,
    ...payload,
  };
  const input = `${b64u(h)}.${b64u(p)}`;
  let sig;
  if (alg === 'RS256') sig = cryptoSign('sha256', Buffer.from(input), key);
  else sig = cryptoSign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

const keys = { [KID]: rsaJwk, 'kid-fixture-ec': ecJwk };
const getKey = async (kid) => keys[kid] ?? null;
const opts = (over = {}) => ({
  issuer: ISSUER,
  audience: AUDIENCE,
  clientId: CLIENT_ID,
  nonce: NONCE,
  getKey,
  now: NOW_MS,
  ...over,
});

async function reasonOf(token, over) {
  const r = await verifyIdToken(token, opts(over));
  assert.equal(r.ok, false, 'expected refusal');
  return r.reason;
}

test('a well-formed RS256 token with matching claims verifies and returns claims', async () => {
  const r = await verifyIdToken(jwt(), opts());
  assert.equal(r.ok, true);
  assert.equal(r.claims.sub, 'user-subject-1');
});

test('an ES256 token from a published P-256 key verifies with raw r||s signatures', async () => {
  const t = jwt({ alg: 'ES256', kid: 'kid-fixture-ec', key: ec.privateKey });
  const r = await verifyIdToken(t, opts());
  assert.equal(r.ok, true);
});

test('malformed tokens fail as malformed without calling the key lookup', async () => {
  let calls = 0;
  const counting = async (kid) => { calls += 1; return getKey(kid); };
  for (const bad of ['', 'a.b', 'a.b.c.d', 'not base64!.x.y', 42, 'x'.repeat(16385)]) {
    const r = await verifyIdToken(bad, opts({ getKey: counting }));
    assert.deepEqual(r, { ok: false, reason: 'malformed' });
  }
  assert.equal(calls, 0);
});

test('a token whose header or payload is not a JSON object is malformed', async () => {
  const notObj = Buffer.from('"str"').toString('base64url');
  const t = `${notObj}.${notObj}.AAAA`;
  assert.equal(await reasonOf(t), 'malformed');
});

test('alg none, HS256 and any alg outside the allow list are refused before key lookup', async () => {
  let calls = 0;
  const counting = async (kid) => { calls += 1; return getKey(kid); };
  for (const alg of ['none', 'HS256', 'PS256', '', 'constructor']) {
    const header = b64u({ alg, kid: KID, typ: 'JWT' });
    const payload = b64u({ iss: ISSUER, aud: AUDIENCE, sub: 's', nonce: NONCE, exp: NOW_S + 60 });
    const r = await verifyIdToken(`${header}.${payload}.AAAA`, opts({ getKey: counting }));
    assert.deepEqual(r, { ok: false, reason: 'alg_not_allowed' }, alg);
  }
  assert.equal(calls, 0);
});

test('a missing, non-string or oversized kid is an unknown key', async () => {
  const noKid = b64u({ alg: 'RS256', typ: 'JWT' });
  const payload = b64u({ iss: ISSUER, aud: AUDIENCE, sub: 's', nonce: NONCE, exp: NOW_S + 60 });
  assert.equal(await reasonOf(`${noKid}.${payload}.AAAA`), 'unknown_key');
  assert.equal(await reasonOf(jwt({ header: { kid: 12 } })), 'unknown_key');
  assert.equal(await reasonOf(jwt({ kid: 'k'.repeat(257) })), 'unknown_key');
});

test('a kid the published key set does not contain is refused', async () => {
  assert.equal(await reasonOf(jwt({ kid: 'kid-not-published' })), 'unknown_key');
});

test('a key with the wrong kty, a non-sig use, or a different alg is bad_key', async () => {
  const wrongKty = { ...rsaJwk, kty: 'EC' };
  const encUse = { ...rsaJwk, use: 'enc' };
  const otherAlg = { ...rsaJwk, alg: 'RS384' };
  for (const bad of [wrongKty, encUse, otherAlg]) {
    const r = await verifyIdToken(jwt(), opts({ getKey: async () => bad }));
    assert.deepEqual(r, { ok: false, reason: 'bad_key' });
  }
});

test('an EC key on the wrong curve for ES256 is bad_key', async () => {
  const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' });
  const jwk = { ...p384.publicKey.export({ format: 'jwk' }), kid: 'kid-fixture-ec', alg: 'ES256' };
  const t = jwt({ alg: 'ES256', kid: 'kid-fixture-ec', key: ec.privateKey });
  const r = await verifyIdToken(t, opts({ getKey: async () => jwk }));
  assert.deepEqual(r, { ok: false, reason: 'bad_key' });
});

test('a signature made by a different key is bad_signature', async () => {
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal(await reasonOf(jwt({ key: other.privateKey })), 'bad_signature');
});

test('a tampered payload fails the signature check', async () => {
  const [h, , s] = jwt().split('.');
  const forged = b64u({ iss: ISSUER, aud: AUDIENCE, sub: 'someone-else', nonce: NONCE, exp: NOW_S + 300 });
  assert.equal(await reasonOf(`${h}.${forged}.${s}`), 'bad_signature');
});

test('wrong issuer and wrong audience are refused', async () => {
  assert.equal(await reasonOf(jwt({ payload: { iss: 'https://evil.example.test' } })), 'issuer');
  assert.equal(await reasonOf(jwt({ payload: { aud: 'urn:other' } })), 'audience');
});

test('multi-audience token is refused unless azp equals this client id', async () => {
  const aud = [AUDIENCE, 'urn:other'];
  assert.equal(await reasonOf(jwt({ payload: { aud } })), 'audience');
  assert.equal(await reasonOf(jwt({ payload: { aud, azp: 'someone-else' } })), 'audience');
  const ok = await verifyIdToken(jwt({ payload: { aud, azp: CLIENT_ID } }), opts());
  assert.equal(ok.ok, true);
});

test('expiry uses the skew allowance: refused past exp+skew, accepted inside it', async () => {
  assert.equal(await reasonOf(jwt({ payload: { exp: NOW_S - 120 } })), 'expired');
  const inside = await verifyIdToken(jwt({ payload: { exp: NOW_S - 30 } }), opts({ skewSeconds: 60 }));
  assert.equal(inside.ok, true);
});

test('a token without a numeric exp is expired', async () => {
  const t = jwt({ payload: { exp: 'soon' } });
  assert.equal(await reasonOf(t), 'expired');
});

test('iat or nbf in the future beyond skew is not_yet_valid', async () => {
  assert.equal(await reasonOf(jwt({ payload: { iat: NOW_S + 600 } })), 'not_yet_valid');
  assert.equal(await reasonOf(jwt({ payload: { nbf: NOW_S + 600 } })), 'not_yet_valid');
});

test('nonce mismatch and a missing nonce are refused', async () => {
  assert.equal(await reasonOf(jwt({ payload: { nonce: 'other-nonce' } })), 'nonce');
  assert.equal(await reasonOf(jwt({ payload: { nonce: undefined } })), 'nonce');
});

test('subject must be a non-empty string without control characters, at most 256 long', async () => {
  assert.equal(await reasonOf(jwt({ payload: { sub: '' } })), 'subject');
  assert.equal(await reasonOf(jwt({ payload: { sub: 'a\nb' } })), 'subject');
  assert.equal(await reasonOf(jwt({ payload: { sub: 's'.repeat(257) } })), 'subject');
  assert.equal(await reasonOf(jwt({ payload: { sub: 7 } })), 'subject');
});

test('refusal results never echo token contents', async () => {
  const t = jwt({ payload: { iss: 'https://evil.example.test', sub: 'secret-subject-value' } });
  const r = await verifyIdToken(t, opts());
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(r).includes('secret-subject-value'), false);
});
