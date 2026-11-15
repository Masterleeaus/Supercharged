import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readSignInConfig, readConfigEnvironment, readEventSecret, CentralConfigError, isSecureEndpoint,
} from '../../server/infrastructure/central-oidc/config.ts';

const SECRET = 'p'.repeat(48);
const full = Object.freeze({
  CENTRAL_ORIGIN: 'https://central.example.test',
  TITAN_DESK_AUDIENCE: 'urn:placeholder:desk',
  TITAN_DESK_OIDC_CLIENT_ID: 'placeholder-client-id',
  TITAN_DESK_OIDC_CLIENT_SECRET: SECRET,
  TITAN_CONFIG_ENVIRONMENT: 'staging',
  TITAN_CENTRAL_EVENT_SECRET: SECRET,
});

test('sign-in config reads every variable from the environment', () => {
  const c = readSignInConfig(full);
  assert.equal(c.centralOrigin, 'https://central.example.test');
  assert.equal(c.audience, 'urn:placeholder:desk');
  assert.equal(c.clientId, 'placeholder-client-id');
  assert.equal(c.clientSecret, SECRET);
  assert.equal(Object.isFrozen(c), true);
});

test('each unset sign-in variable fails clearly and never prints a value', () => {
  for (const name of ['CENTRAL_ORIGIN', 'TITAN_DESK_AUDIENCE', 'TITAN_DESK_OIDC_CLIENT_ID', 'TITAN_DESK_OIDC_CLIENT_SECRET']) {
    const env = { ...full, [name]: undefined };
    assert.throws(() => readSignInConfig(env), (e) => {
      assert.ok(e instanceof CentralConfigError);
      assert.equal(e.variable, name);
      assert.match(e.message, new RegExp(name));
      assert.equal(e.message.includes(SECRET), false);
      return true;
    }, name);
  }
});

test('blank values count as unset', () => {
  assert.throws(() => readSignInConfig({ ...full, TITAN_DESK_OIDC_CLIENT_SECRET: '   ' }), CentralConfigError);
});

test('origin must be https with no path, query or credentials', () => {
  for (const bad of ['http://central.example.test', 'https://central.example.test/oidc', 'https://u:p@central.example.test', 'https://central.example.test?x=1']) {
    assert.throws(() => readSignInConfig({ ...full, CENTRAL_ORIGIN: bad }), (e) => e.variable === 'CENTRAL_ORIGIN', bad);
  }
});

test('plain http is allowed only for localhost with the explicit dev switch', () => {
  const local = { ...full, CENTRAL_ORIGIN: 'http://localhost:4010' };
  assert.throws(() => readSignInConfig(local), CentralConfigError);
  assert.equal(readSignInConfig({ ...local, TITAN_ALLOW_INSECURE_LOCALHOST: '1' }).centralOrigin, 'http://localhost:4010');
  assert.equal(isSecureEndpoint('http://example.test', true), false);
});

test('config environment must be development, staging or production', () => {
  assert.equal(readConfigEnvironment(full), 'staging');
  assert.throws(() => readConfigEnvironment({ ...full, TITAN_CONFIG_ENVIRONMENT: 'qa' }), (e) => e.variable === 'TITAN_CONFIG_ENVIRONMENT');
  assert.throws(() => readConfigEnvironment({}), (e) => e.variable === 'TITAN_CONFIG_ENVIRONMENT');
});

test('event secret must be at least 32 characters', () => {
  assert.equal(readEventSecret(full), SECRET);
  assert.throws(() => readEventSecret({ ...full, TITAN_CENTRAL_EVENT_SECRET: 'short' }), (e) => e.variable === 'TITAN_CENTRAL_EVENT_SECRET');
  assert.throws(() => readEventSecret({}), (e) => e.variable === 'TITAN_CENTRAL_EVENT_SECRET');
});
