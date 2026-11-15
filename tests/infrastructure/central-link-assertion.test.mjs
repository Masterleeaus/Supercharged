import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, verify, createPublicKey} from 'node:crypto';
import {
  readLinkSigningConfig,
  publicJwkFor,
  CentralConfigError,
} from '../../server/infrastructure/central-link/config.ts';
import {
  signLinkAssertion,
  IssuedNonceLedger,
  LinkAssertionError,
  LINK_ASSERTION_MAX_TTL_SECONDS,
} from '../../server/infrastructure/central-link/link-assertion.ts';

// Generated per run. Never a real or committed key.
const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const PRIVATE_PEM = privateKey.export({type: 'pkcs8', format: 'pem'});
const config = {issuer: 'supercharged', audience: 'titan-central', kid: 'test-kid-1', privateKey};
const NOW_MS = Date.UTC(2026, 10, 15, 12, 0, 0);
const input = () => ({
  sub: 'usr_7f3k2m9a',
  org: 'org_4hq8c1zd',
  lu: 'supercharged-user-1842',
  la: 'supercharged-acct-2291',
});

function decode(token) {
  const [h, p, s] = token.split('.');
  return {
    headerJson: Buffer.from(h, 'base64url').toString('utf8'),
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payloadJson: Buffer.from(p, 'base64url').toString('utf8'),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

test('signature round-trip verifies with the public key only', () => {
  const {token} = signLinkAssertion(config, input(), {ledger: new IssuedNonceLedger(), nowMs: NOW_MS});
  const d = decode(token);
  assert.equal(
    verify(null, Buffer.from(d.signingInput, 'ascii'), publicKey, d.signature),
    true,
  );
  const wrong = generateKeyPairSync('ed25519').publicKey;
  assert.equal(verify(null, Buffer.from(d.signingInput, 'ascii'), wrong, d.signature), false);
});

test('header is exactly alg, typ and kid, in that order', () => {
  const {token} = signLinkAssertion(config, input(), {ledger: new IssuedNonceLedger(), nowMs: NOW_MS});
  const d = decode(token);
  assert.equal(d.headerJson, '{"alg":"EdDSA","typ":"titan-link+jwt","kid":"test-kid-1"}');
  assert.deepEqual(Object.keys(d.header), ['alg', 'typ', 'kid']);
});

test('compact JWS has three base64url segments and no padding', () => {
  const {token} = signLinkAssertion(config, input(), {ledger: new IssuedNonceLedger(), nowMs: NOW_MS});
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('payload carries exactly the documented claims with the expected values', () => {
  const {token, nonce, iat, exp} = signLinkAssertion(config, input(), {
    ledger: new IssuedNonceLedger(),
    nowMs: NOW_MS,
  });
  const {payload} = decode(token);
  assert.deepEqual(Object.keys(payload), ['iss', 'aud', 'sub', 'org', 'lu', 'la', 'nonce', 'iat', 'exp']);
  assert.equal(payload.iss, 'supercharged');
  assert.equal(payload.aud, 'titan-central');
  assert.equal(payload.sub, 'usr_7f3k2m9a');
  assert.equal(payload.org, 'org_4hq8c1zd');
  assert.equal(payload.lu, 'supercharged-user-1842');
  assert.equal(payload.la, 'supercharged-acct-2291');
  assert.equal(payload.nonce, nonce);
  assert.equal(payload.iat, iat);
  assert.equal(payload.exp, exp);
  assert.equal(iat, Math.floor(NOW_MS / 1000));
});

test('lifetime is at most 300 seconds; default is shorter and 300 is accepted', () => {
  const ledger = new IssuedNonceLedger();
  const max = signLinkAssertion(config, {...input(), ttlSeconds: LINK_ASSERTION_MAX_TTL_SECONDS}, {ledger, nowMs: NOW_MS});
  assert.equal(max.exp - max.iat, 300);
  const dflt = signLinkAssertion(config, input(), {ledger, nowMs: NOW_MS});
  assert.ok(dflt.exp - dflt.iat <= 300 && dflt.exp > dflt.iat);
  for (const ttlSeconds of [0, 301, 1.5, -1, '60', Number.NaN]) {
    assert.throws(
      () => signLinkAssertion(config, {...input(), ttlSeconds}, {ledger, nowMs: NOW_MS}),
      (e) => e instanceof LinkAssertionError && e.code === 'invalid_lifetime',
    );
  }
});

test('forbidden claims are refused before anything is signed', () => {
  const forbidden = [
    'email', 'email_verified', 'name', 'given_name', 'family_name', 'display_name',
    'displayName', 'preferred_username', 'username', 'nickname', 'phone_number',
  ];
  for (const key of forbidden) {
    const ledger = new IssuedNonceLedger();
    assert.throws(
      () => signLinkAssertion(config, {...input(), [key]: 'x'}, {ledger, nowMs: NOW_MS}),
      (e) => e instanceof LinkAssertionError && e.code === 'forbidden_claim',
      key,
    );
  }
});

test('unknown fields are refused, so a claim cannot be smuggled in', () => {
  assert.throws(
    () => signLinkAssertion(config, {...input(), role: 'admin'}, {ledger: new IssuedNonceLedger(), nowMs: NOW_MS}),
    (e) => e instanceof LinkAssertionError && e.code === 'unexpected_field',
  );
});

test('identifiers must be opaque: email, whitespace and display names are refused', () => {
  for (const bad of ['jane@example.org', 'Jane Smith', 'short', 'x'.repeat(129), '']) {
    assert.throws(
      () => signLinkAssertion(config, {...input(), lu: bad}, {ledger: new IssuedNonceLedger(), nowMs: NOW_MS}),
      (e) => e instanceof LinkAssertionError && e.code === 'invalid_identifier',
      JSON.stringify(bad),
    );
  }
});

test('each assertion gets a fresh nonce of 128 bits or more, base64url, 22 to 128 characters', () => {
  const ledger = new IssuedNonceLedger();
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const {nonce} = signLinkAssertion(config, input(), {ledger, nowMs: NOW_MS});
    assert.match(nonce, /^[A-Za-z0-9_-]{22,128}$/);
    assert.ok(Buffer.from(nonce, 'base64url').length >= 16);
    seen.add(nonce);
  }
  assert.equal(seen.size, 50);
});

test('ledger refuses a nonce it already recorded until that nonce expires', () => {
  const ledger = new IssuedNonceLedger();
  ledger.record('a'.repeat(22), 1000, 900);
  assert.throws(() => ledger.record('a'.repeat(22), 1000, 901),
    (e) => e instanceof LinkAssertionError && e.code === 'nonce_reused');
  // After expiry the entry is pruned and the slot is free again.
  ledger.record('a'.repeat(22), 2000, 1001);
});

test('public JWK carries only public members and verifies the same signatures', () => {
  const jwk = publicJwkFor(privateKey);
  assert.deepEqual(Object.keys(jwk).sort(), ['crv', 'kty', 'x']);
  assert.equal(jwk.kty, 'OKP');
  assert.equal(jwk.crv, 'Ed25519');
  const rebuilt = createPublicKey({key: jwk, format: 'jwk'});
  const {token} = signLinkAssertion(config, input(), {ledger: new IssuedNonceLedger(), nowMs: NOW_MS});
  const d = decode(token);
  assert.equal(verify(null, Buffer.from(d.signingInput, 'ascii'), rebuilt, d.signature), true);
});

test('config names the missing variable and never echoes a value', () => {
  const base = {
    CENTRAL_LINK_ISSUER: 'supercharged',
    CENTRAL_LINK_AUDIENCE: 'titan-central',
    CENTRAL_LINK_KEY_ID: 'test-kid-1',
    CENTRAL_LINK_PRIVATE_KEY: PRIVATE_PEM,
  };
  for (const name of Object.keys(base)) {
    const env = {...base, [name]: undefined};
    assert.throws(
      () => readLinkSigningConfig(env),
      (e) => e instanceof CentralConfigError && e.message.includes(name),
      name,
    );
  }
  const cfg = readLinkSigningConfig(base);
  assert.equal(cfg.issuer, 'supercharged');
  assert.equal(cfg.kid, 'test-kid-1');
});

test('config accepts a PEM with escaped newlines and refuses non-Ed25519 or garbage keys', () => {
  const escaped = PRIVATE_PEM.replace(/\n/g, '\\n');
  const env = {
    CENTRAL_LINK_ISSUER: 'supercharged',
    CENTRAL_LINK_AUDIENCE: 'titan-central',
    CENTRAL_LINK_KEY_ID: 'test-kid-1',
    CENTRAL_LINK_PRIVATE_KEY: escaped,
  };
  assert.equal(readLinkSigningConfig(env).kid, 'test-kid-1');

  const rsa = generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey.export({type: 'pkcs8', format: 'pem'});
  assert.throws(() => readLinkSigningConfig({...env, CENTRAL_LINK_PRIVATE_KEY: rsa}),
    (e) => e instanceof CentralConfigError && /Ed25519/.test(e.message));
  assert.throws(() => readLinkSigningConfig({...env, CENTRAL_LINK_PRIVATE_KEY: 'not a key'}),
    (e) => e instanceof CentralConfigError && !e.message.includes('not a key'));
});
