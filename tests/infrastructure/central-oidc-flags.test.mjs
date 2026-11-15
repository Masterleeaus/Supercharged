// Issue #196: flag reads return declared defaults on every failure, and cache only real answers.
// Calls go through the merged service client from central-link (issue #214). No live calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlagReader, UndeclaredFlagError, DECLARED_FLAGS, MAX_FLAG_CACHE_MS } from '../../server/infrastructure/central-oidc/feature-flags.ts';
import { createCentralServiceClient } from '../../server/infrastructure/central-link/service-client.ts';
import { ORIGIN, TOKEN, PRODUCT_AUDIENCE, routedFetch } from './central-oidc-fixtures.mjs';

const CLIENT = { origin: ORIGIN, tokenUrl: TOKEN, clientId: 'svc-client-test', clientSecret: 'svc-secret-placeholder-value', audience: PRODUCT_AUDIENCE };
const DECLARED = Object.freeze({
  show_beta: { type: 'boolean', default: false },
  page_size: { type: 'integer', default: 25 },
  theme: { type: 'string', default: 'light', allowed: ['light', 'dark'] },
});

function jwt(aud) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'EdDSA', typ: 'JWT' })}.${enc({ aud, sub: 'svc' })}.c2ln`;
}

/** Builds a reader over the real service client with fake HTTP for token and flag routes. */
function readerWith(flagHandler, { clock = () => 0, timeoutMs, cacheTtlMs } = {}) {
  const tokenHandler = () => ({ body: { access_token: jwt(PRODUCT_AUDIENCE), token_type: 'Bearer', expires_in: 3600 } });
  const { fetcher, calls } = routedFetch({
    [TOKEN]: tokenHandler,
    [`${ORIGIN}/internal/v1/config/staging/show_beta`]: flagHandler,
    [`${ORIGIN}/internal/v1/config/staging/page_size`]: flagHandler,
    [`${ORIGIN}/internal/v1/config/staging/theme`]: flagHandler,
  });
  const client = createCentralServiceClient({ config: CLIENT, fetchImpl: fetcher, nowMs: clock });
  const read = createFlagReader({ declared: DECLARED, environment: 'staging', request: client.request, clock, timeoutMs, cacheTtlMs });
  return { read, calls };
}

const answer = (key, value, source = 'global') => ({ body: { key, value, source, revision: 3 } });

test('a valid 200 returns Central value and sends no tenant, cohort or query data', async () => {
  const { read, calls } = readerWith(() => answer('show_beta', true));
  assert.equal(await read('show_beta'), true);
  const flagCall = calls.find((c) => c.url.includes('/internal/v1/config/'));
  assert.equal(flagCall.url, `${ORIGIN}/internal/v1/config/staging/show_beta`);
  assert.equal(flagCall.init.headers.Authorization.startsWith('Bearer '), true);
  assert.equal(flagCall.url.includes('?'), false);
});

test('unreachable Central, a non-200, a bad body and a fallback all return the declared default', async () => {
  const cases = {
    'network error': () => { throw new Error('connect refused'); },
    'server error': { status: 500, body: {} },
    'wrong key echoed': answer('other_flag', true),
    'wrong type': answer('show_beta', 'yes'),
    'unknown source': { body: { key: 'show_beta', value: true, source: 'magic', revision: 1 } },
    'fallback answer': answer('show_beta', true, 'fallback'),
    'value outside allowed set': answer('theme', 'neon'),
  };
  for (const [name, handler] of Object.entries(cases)) {
    const key = name === 'value outside allowed set' ? 'theme' : 'show_beta';
    const { read } = readerWith(handler);
    const expected = key === 'theme' ? 'light' : false;
    assert.equal(await read(key), expected, name);
  }
});

test('a slow Central returns the default at the timeout', async () => {
  const slow = () => new Promise((resolve) => setTimeout(() => resolve(answer('show_beta', true)), 200));
  const { read } = readerWith(slow, { timeoutMs: 20 });
  assert.equal(await read('show_beta'), false);
});

test('a token for another audience makes the read fall back to the default', async () => {
  const { fetcher } = routedFetch({
    [TOKEN]: { body: { access_token: jwt('urn:titan-central:product:other'), token_type: 'Bearer', expires_in: 3600 } },
    [`${ORIGIN}/internal/v1/config/staging/show_beta`]: answer('show_beta', true),
  });
  const client = createCentralServiceClient({ config: CLIENT, fetchImpl: fetcher, nowMs: () => 0 });
  const read = createFlagReader({ declared: DECLARED, environment: 'staging', request: client.request, clock: () => 0 });
  assert.equal(await read('show_beta'), false);
});

test('a non-fallback answer is cached for at most 60 seconds, and a fallback is never cached', async () => {
  let now = 0;
  let hits = 0;
  const { read, calls } = readerWith(() => { hits += 1; return answer('show_beta', true); }, { clock: () => now });
  assert.equal(await read('show_beta'), true);
  now = MAX_FLAG_CACHE_MS - 1;
  assert.equal(await read('show_beta'), true);
  assert.equal(hits, 1, 'second read inside the window is served from cache');
  now = MAX_FLAG_CACHE_MS + 1;
  assert.equal(await read('show_beta'), true);
  assert.equal(hits, 2);
  const { read: readFallback } = readerWith(() => answer('show_beta', true, 'fallback'), { clock: () => now });
  assert.equal(await readFallback('show_beta'), false);
  assert.ok(calls.length >= 1);
});

test('reading an undeclared or malformed key throws and never defaults silently', async () => {
  const { read } = readerWith(() => answer('show_beta', true));
  await assert.rejects(read('not_declared'), UndeclaredFlagError);
  await assert.rejects(read('Bad-Key'), UndeclaredFlagError);
  await assert.rejects(read('__proto__'), UndeclaredFlagError);
});

test('the production declaration set is empty until Central declares flags for Supercharged', () => {
  assert.deepEqual(Object.keys(DECLARED_FLAGS), []);
});
