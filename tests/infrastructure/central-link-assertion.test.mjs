import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, createPublicKey, sign as edSign} from 'node:crypto';
import {
  createLinkAssertionSigner, createNonceLedger, LinkAssertionError, linkPublicJwk,
  readLinkSigningConfig, verifyLinkAssertion, LINK_FORBIDDEN_CLAIMS,
} from '../../server/infrastructure/central-sso/link-assertion.ts';

const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const pem = privateKey.export({type: 'pkcs8', format: 'pem'});
const kid = 'sc-test-2026-11';
const config = {privateKey, kid};
const input = {sub: 'central-user-1', org: 'org_123', lu: 'local-user-9', la: 'local-acct-9'};
const T0 = Date.UTC(2026, 10, 15, 12, 0, 0);

function signer(over = {}) {
  let t = T0;
  const sign = createLinkAssertionSigner({config, now: () => t, ...over});
  return {sign, setNow: (v) => { t = v; }};
}

function code(fn) {
  try { fn(); } catch (e) { return e instanceof LinkAssertionError ? e.code : `other:${e.message}`; }
  return 'no-error';
}

// Re-sign a tampered header/claims with the real key so only the rule under test fails.
function forge(headerObj, claimsObj) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const si = `${enc(headerObj)}.${enc(claimsObj)}`;
  const sig = edSign(null, Buffer.from(si), privateKey).toString('base64url');
  return `${si}.${sig}`;
}

test('signed assertion verifies and carries exact header and claims', () => {
  const {sign} = signer();
  const out = sign(input);
  const {header, claims} = verifyLinkAssertion(out.token, {publicKey, kid, now: () => T0});
  assert.deepEqual(header, {alg: 'EdDSA', typ: 'titan-link+jwt', kid});
  assert.equal(Object.keys(JSON.parse(Buffer.from(out.token.split('.')[0], 'base64url'))).length, 3);
  assert.equal(claims.iss, 'supercharged');
  assert.equal(claims.aud, 'titan-central');
  assert.equal(claims.sub, input.sub);
  assert.equal(claims.org, input.org);
  assert.equal(claims.lu, input.lu);
  assert.equal(claims.la, input.la);
  assert.equal(claims.nonce, out.nonce);
  assert.match(out.nonce, /^[A-Za-z0-9_-]{22,128}$/);
  assert.equal(claims.iat, Math.floor(T0 / 1000));
  assert.equal(claims.exp - claims.iat, 120);
});

test('nonce differs on every issue', () => {
  const {sign} = signer();
  assert.notEqual(sign(input).nonce, sign(input).nonce);
});

test('tampered signature or payload is rejected', () => {
  const {sign} = signer();
  const [h, p, s] = sign(input).token.split('.');
  const badPayload = Buffer.from(JSON.stringify({iss: 'supercharged', aud: 'titan-central', sub: 'other', org: 'o', lu: 'l', la: 'a', nonce: 'x'.repeat(22), iat: 1, exp: 2})).toString('base64url');
  assert.equal(code(() => verifyLinkAssertion(`${h}.${badPayload}.${s}`, {publicKey, now: () => T0})), 'bad_signature');
  assert.equal(code(() => verifyLinkAssertion(`${h}.${p}.${(s[0] === 'A' ? 'B' : 'A') + s.slice(1)}`, {publicKey, now: () => T0})), 'bad_signature');
});

test('a different key cannot verify the assertion', () => {
  const other = generateKeyPairSync('ed25519').publicKey;
  const {sign} = signer();
  assert.equal(code(() => verifyLinkAssertion(sign(input).token, {publicKey: other, now: () => T0})), 'bad_signature');
});

test('exact header is enforced', () => {
  const now = () => T0;
  const claims = {iss: 'supercharged', aud: 'titan-central', sub: 's', org: 'o', lu: 'l', la: 'a',
    nonce: 'a'.repeat(22), iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 60};
  const base = {alg: 'EdDSA', typ: 'titan-link+jwt', kid};
  assert.equal(code(() => verifyLinkAssertion(forge(base, claims), {publicKey, now})), 'no-error');
  assert.equal(code(() => verifyLinkAssertion(forge({...base, cty: 'JWT'}, claims), {publicKey, now})), 'header_mismatch');
  assert.equal(code(() => verifyLinkAssertion(forge({...base, typ: 'JWT'}, claims), {publicKey, now})), 'header_mismatch');
  assert.equal(code(() => verifyLinkAssertion(forge({...base, alg: 'HS256'}, claims), {publicKey, now})), 'header_mismatch');
  assert.equal(code(() => verifyLinkAssertion(forge(base, claims), {publicKey, kid: 'other-kid', now})), 'header_mismatch');
});

test('forbidden identity claims are refused at signing time', () => {
  const {sign} = signer();
  for (const name of LINK_FORBIDDEN_CLAIMS) {
    assert.equal(code(() => sign({...input, [name]: 'x'})), 'forbidden_claim', name);
  }
});

test('forbidden and unknown claims are refused at verification time', () => {
  const now = () => T0;
  const base = {alg: 'EdDSA', typ: 'titan-link+jwt', kid};
  const claims = {iss: 'supercharged', aud: 'titan-central', sub: 's', org: 'o', lu: 'l', la: 'a',
    nonce: 'a'.repeat(22), iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 60};
  assert.equal(code(() => verifyLinkAssertion(forge(base, {...claims, email: 'a@b.c'}), {publicKey, now})), 'forbidden_claim');
  assert.equal(code(() => verifyLinkAssertion(forge(base, {...claims, role: 'admin'}), {publicKey, now})), 'unknown_claim');
});

test('input must be the four local identifiers with no extras', () => {
  const {sign} = signer();
  assert.equal(code(() => sign({...input, sub: ''})), 'invalid_input');
  assert.equal(code(() => sign({...input, org: 'bad value'})), 'invalid_input');
  assert.equal(code(() => sign({sub: 'a', org: 'o', lu: 'l'})), 'invalid_input');
  assert.equal(code(() => sign({...input, iss: 'evil'})), 'unknown_claim');
  assert.equal(code(() => sign(null)), 'invalid_input');
});

test('wrong issuer and audience are rejected', () => {
  const now = () => T0;
  const base = {alg: 'EdDSA', typ: 'titan-link+jwt', kid};
  const claims = {iss: 'supercharged', aud: 'titan-central', sub: 's', org: 'o', lu: 'l', la: 'a',
    nonce: 'a'.repeat(22), iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 60};
  assert.equal(code(() => verifyLinkAssertion(forge(base, {...claims, iss: 'desk'}), {publicKey, now})), 'wrong_issuer');
  assert.equal(code(() => verifyLinkAssertion(forge(base, {...claims, aud: 'other'}), {publicKey, now})), 'wrong_audience');
});

test('nonce must be 22 to 128 base64url characters', () => {
  const now = () => T0;
  const base = {alg: 'EdDSA', typ: 'titan-link+jwt', kid};
  const claims = {iss: 'supercharged', aud: 'titan-central', sub: 's', org: 'o', lu: 'l', la: 'a',
    nonce: 'a'.repeat(22), iat: Math.floor(T0 / 1000), exp: Math.floor(T0 / 1000) + 60};
  assert.equal(code(() => verifyLinkAssertion(forge(base, {...claims, nonce: 'a'.repeat(21)}), {publicKey, now})), 'bad_nonce');
  assert.equal(code(() => verifyLinkAssertion(forge(base, {...claims, nonce: 'a'.repeat(129)}), {publicKey, now})), 'bad_nonce');
  assert.equal(code(() => verifyLinkAssertion(forge(base, {...claims, nonce: 'a+b/' + 'a'.repeat(20)}), {publicKey, now})), 'bad_nonce');
  assert.equal(code(() => verifyLinkAssertion(forge(base, {...claims, nonce: 'a'.repeat(128)}), {publicKey, now})), 'no-error');
});

test('nonce replay is refused once consumed', () => {
  const {sign} = signer();
  const token = sign(input).token;
  const ledger = createNonceLedger({now: () => T0});
  assert.equal(code(() => verifyLinkAssertion(token, {publicKey, now: () => T0, ledger})), 'no-error');
  assert.equal(code(() => verifyLinkAssertion(token, {publicKey, now: () => T0, ledger})), 'replayed_nonce');
});

test('lifetime above 300 seconds or non-positive is refused', () => {
  const now = () => T0;
  const base = {alg: 'EdDSA', typ: 'titan-link+jwt', kid};
  const iat = Math.floor(T0 / 1000);
  const claims = {iss: 'supercharged', aud: 'titan-central', sub: 's', org: 'o', lu: 'l', la: 'a', nonce: 'a'.repeat(22), iat};
  assert.equal(code(() => verifyLinkAssertion(forge(base, {...claims, exp: iat + 300}), {publicKey, now})), 'no-error');
  assert.equal(code(() => verifyLinkAssertion(forge(base, {...claims, exp: iat + 301}), {publicKey, now})), 'ttl_exceeded');
  assert.equal(code(() => verifyLinkAssertion(forge(base, {...claims, exp: iat}), {publicKey, now})), 'ttl_exceeded');
  assert.throws(() => createLinkAssertionSigner({config, ttlSeconds: 301}), RangeError);
  assert.throws(() => createLinkAssertionSigner({config, ttlSeconds: 0}), RangeError);
});

test('expired and future-issued assertions are refused', () => {
  const base = {alg: 'EdDSA', typ: 'titan-link+jwt', kid};
  const iat = Math.floor(T0 / 1000);
  const claims = {iss: 'supercharged', aud: 'titan-central', sub: 's', org: 'o', lu: 'l', la: 'a', nonce: 'a'.repeat(22), iat, exp: iat + 120};
  assert.equal(code(() => verifyLinkAssertion(forge(base, claims), {publicKey, now: () => (iat + 120) * 1000})), 'expired');
  assert.equal(code(() => verifyLinkAssertion(forge(base, claims), {publicKey, now: () => (iat - 31) * 1000})), 'issued_in_future');
  assert.equal(code(() => verifyLinkAssertion(forge(base, claims), {publicKey, now: () => (iat - 30) * 1000})), 'no-error');
});

test('malformed tokens are refused', () => {
  for (const t of [undefined, 42, 'a.b', 'a.b.c.d', '!!.!!.!!', 'e30.e30.']) {
    assert.equal(code(() => verifyLinkAssertion(t, {publicKey, now: () => T0})), 'malformed', String(t));
  }
});

test('public JWK carries no private member and matches the signing key', () => {
  const jwk = linkPublicJwk(config);
  assert.deepEqual(Object.keys(jwk).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x']);
  assert.equal(jwk.kty, 'OKP');
  assert.equal(jwk.crv, 'Ed25519');
  assert.equal(jwk.kid, kid);
  assert.equal(jwk.alg, 'EdDSA');
  const pub = createPublicKey({key: jwk, format: 'jwk'});
  const {sign} = signer();
  assert.doesNotThrow(() => verifyLinkAssertion(sign(input).token, {publicKey: pub, now: () => T0}));
});

test('signing key is read only from environment variables and validated', () => {
  assert.equal(code(() => readLinkSigningConfig({})), 'config_missing');
  assert.equal(code(() => readLinkSigningConfig({CENTRAL_LINK_SIGNING_KEY: pem})), 'config_missing');
  assert.equal(code(() => readLinkSigningConfig({CENTRAL_LINK_SIGNING_KEY: 'nope', CENTRAL_LINK_SIGNING_KID: kid})), 'config_invalid');
  assert.equal(code(() => readLinkSigningConfig({CENTRAL_LINK_SIGNING_KEY: pem, CENTRAL_LINK_SIGNING_KID: 'bad kid!'})), 'config_invalid');
  const rsa = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey.export({type: 'pkcs8', format: 'pem'});
  assert.equal(code(() => readLinkSigningConfig({CENTRAL_LINK_SIGNING_KEY: rsa, CENTRAL_LINK_SIGNING_KID: kid})), 'config_invalid');
  const escaped = pem.replace(/\n/g, '\\n');
  const cfg = readLinkSigningConfig({CENTRAL_LINK_SIGNING_KEY: escaped, CENTRAL_LINK_SIGNING_KID: kid});
  assert.equal(cfg.kid, kid);
  assert.equal(cfg.privateKey.asymmetricKeyType, 'ed25519');
});
