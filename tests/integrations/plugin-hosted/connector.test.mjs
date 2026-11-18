/**
 * Hosted tzfd-ai/1 connector endpoint tests. Offline: fake feature, in-memory secrets, injected clock.
 * Request values come from the PHP-generated fixture in fixtures/tzfd-ai-v1.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createConnectorHandler, CONSENT_VERSION } from '../../../server/integrations/plugin-hosted/connector.ts';
import { createMemoryNonceStore } from '../../../server/integrations/plugin-hosted/nonce-store.ts';
import { defaultFeatureImplementation } from '../../../server/integrations/plugin-hosted/features.ts';
import { TEST_SECRET, TEST_SITE, PHP_REQUEST } from './fixtures/tzfd-ai-v1.mjs';

const NOW_S = Number(PHP_REQUEST.timestamp);
const ALL_GRANTED = ['faq.read', 'reports.read', 'customer.read', 'booking.read', 'booking.write'];
const nonceOf = (n) => n.toString(16).padStart(32, '0');
const sign = (secret, ts, nonce, body) => 'sha256=' + createHmac('sha256', secret).update(`${ts}.${nonce}.${body}`).digest('hex');

function spyFeature(outcome = { status: 'ok', data: { answer: 'Open 8 to 5' }, usage: { tokens_in: 10, tokens_out: 20, cache_hit: false } }) {
  const calls = [];
  const feature = async (request) => {
    calls.push(request);
    return typeof outcome === 'function' ? outcome(request) : outcome;
  };
  feature.calls = calls;
  return feature;
}

function makeHandler({ feature = spyFeature(), granted = ALL_GRANTED, nowMs = NOW_S * 1000, secretForSite } = {}) {
  return createConnectorHandler({
    secretForSite: secretForSite ?? ((site) => (site === TEST_SITE ? TEST_SECRET : null)),
    grantedScopes: () => granted,
    feature,
    now: () => nowMs,
  });
}

function defaultBody(overrides = {}) {
  return JSON.stringify({
    contract: 'tzfd-ai/1',
    site: TEST_SITE,
    feature: 'faq.answer',
    consent: { version: CONSENT_VERSION, scopes: ['faq.read'] },
    payload: { question: 'Open on Sunday?' },
    ...overrides,
  });
}

/** Builds a request signed with the given secret. Pass undefined in headers to drop one. */
function buildRequest({ body = defaultBody(), secret = TEST_SECRET, ts = String(NOW_S), nonce = nonceOf(1), site = TEST_SITE, headers = {}, signature, method = 'POST' } = {}) {
  const sig = signature ?? sign(secret, ts, nonce, body);
  return {
    method,
    body,
    headers: {
      'X-TZFD-Contract': 'tzfd-ai/1',
      'X-TZFD-Site': site,
      'X-TZFD-Timestamp': ts,
      'X-TZFD-Nonce': nonce,
      'X-TZFD-Signature': sig,
      ...headers,
    },
  };
}

/** The plugin-side check on a response: signature over "<ts>.<nonce>.<body>", nonce echoed, site named. */
function pluginAcceptsResponse(response, request, secret = TEST_SECRET) {
  const ts = response.headers['X-TZFD-Timestamp'];
  const nonce = response.headers['X-TZFD-Nonce'];
  const ok = nonce === request.headers['X-TZFD-Nonce']
    && response.headers['X-TZFD-Signature'] === sign(secret, ts, nonce, response.body);
  return ok && JSON.parse(response.body).site === TEST_SITE;
}

const refused = (response) => JSON.parse(response.body);

test('PHP-signed request reaches the feature exactly once', async () => {
  const feature = spyFeature();
  const handler = makeHandler({ feature });
  const response = await handler({ method: 'POST', headers: PHP_REQUEST.headers, body: PHP_REQUEST.body });
  assert.equal(response.status, 200);
  assert.equal(feature.calls.length, 1);
  assert.deepEqual(feature.calls[0], {
    site: TEST_SITE,
    feature: 'faq.answer',
    payload: { question: 'Are you open on Sunday?' },
    scopes: ['faq.read'],
  });
});

test('valid reply is HTTP 200, echoes the nonce and carries a plugin-verifiable signature', async () => {
  const request = { method: 'POST', headers: PHP_REQUEST.headers, body: PHP_REQUEST.body };
  const response = await makeHandler()(request);
  assert.equal(response.status, 200);
  assert.equal(response.headers['X-TZFD-Nonce'], PHP_REQUEST.nonce);
  assert.equal(response.headers['X-TZFD-Timestamp'], String(NOW_S));
  assert.deepEqual(JSON.parse(response.body), {
    contract: 'tzfd-ai/1',
    site: TEST_SITE,
    status: 'ok',
    data: { answer: 'Open 8 to 5' },
    usage: { tokens_in: 10, tokens_out: 20, embedding_tokens: 0, cache_hit: false },
  });
  assert.equal(pluginAcceptsResponse(response, request), true);
});

test('a replayed nonce is refused with 409 and the feature is not called again', async () => {
  const feature = spyFeature();
  const handler = makeHandler({ feature });
  const request = buildRequest();
  assert.equal((await handler(request)).status, 200);
  const replay = await handler(request);
  assert.equal(replay.status, 409);
  assert.equal(refused(replay).reason, 'replay');
  assert.equal(feature.calls.length, 1);
});

test('nonce store refuses a nonce until it expires, then accepts it again', () => {
  const store = createMemoryNonceStore({ sweepEveryMs: 1 });
  assert.equal(store.claim('n1', 1000, 0), true);
  assert.equal(store.claim('n1', 1000, 500), false);
  assert.equal(store.claim('n1', 2000, 1000), true);
  assert.equal(store.claim('n2', 5000, 1001), true);
});

test('unknown contract header is refused with 426 before any other check', async () => {
  const feature = spyFeature();
  const response = await makeHandler({ feature })(buildRequest({ headers: { 'X-TZFD-Contract': 'tzfd-ai/2' } }));
  assert.equal(response.status, 426);
  assert.equal(refused(response).reason, 'contract_unsupported');
  assert.equal(response.headers['X-TZFD-Signature'], undefined);
  assert.equal(feature.calls.length, 0);
});

test('body contract other than tzfd-ai/1 is refused with 426', async () => {
  const body = defaultBody({ contract: 'tzfd-ai/9' });
  const response = await makeHandler()(buildRequest({ body }));
  assert.equal(response.status, 426);
  assert.equal(refused(response).reason, 'contract_unsupported');
});

test('malformed site header is refused with 400', async () => {
  const response = await makeHandler()(buildRequest({ site: 'bad site!' }));
  assert.equal(response.status, 400);
  assert.equal(refused(response).reason, 'invalid_request');
});

test('missing or repeated required header is refused with 400', async () => {
  const handler = makeHandler();
  assert.equal((await handler(buildRequest({ headers: { 'X-TZFD-Timestamp': undefined } }))).status, 400);
  const repeated = buildRequest();
  repeated.headers['x-tzfd-nonce'] = [nonceOf(1), nonceOf(1)];
  assert.equal((await handler(repeated)).status, 400);
});

test('malformed nonce is refused with 400', async () => {
  const response = await makeHandler()(buildRequest({ nonce: 'XYZ' }));
  assert.equal(response.status, 400);
  assert.equal(refused(response).reason, 'invalid_request');
});

test('malformed signature header is refused with 401 bad_signature', async () => {
  const response = await makeHandler()(buildRequest({ signature: 'sha1=' + 'a'.repeat(40) }));
  assert.equal(response.status, 401);
  assert.equal(refused(response).reason, 'bad_signature');
});

test('timestamp older than 300 s is refused with 401, and the edge at 300 s is accepted', async () => {
  const handler = makeHandler();
  const stale = await handler(buildRequest({ ts: String(NOW_S - 301), nonce: nonceOf(2) }));
  assert.equal(stale.status, 401);
  assert.equal(refused(stale).reason, 'stale_timestamp');
  const edge = await handler(buildRequest({ ts: String(NOW_S - 300), nonce: nonceOf(3) }));
  assert.equal(edge.status, 200);
});

test('timestamp more than 300 s in the future is refused with 401', async () => {
  const response = await makeHandler()(buildRequest({ ts: String(NOW_S + 301), nonce: nonceOf(4) }));
  assert.equal(response.status, 401);
  assert.equal(refused(response).reason, 'stale_timestamp');
});

test('signature over a different body is refused with 401', async () => {
  const signedBody = defaultBody();
  const request = buildRequest({ body: signedBody, signature: sign(TEST_SECRET, String(NOW_S), nonceOf(5), defaultBody({ feature: 'agent.run' })) });
  const response = await makeHandler()(request);
  assert.equal(response.status, 401);
  assert.equal(refused(response).reason, 'bad_signature');
});

test('signature made with another key is refused with 401', async () => {
  const response = await makeHandler()(buildRequest({ secret: `${TEST_SECRET}-other`, nonce: nonceOf(6) }));
  assert.equal(response.status, 401);
  assert.equal(refused(response).reason, 'bad_signature');
});

test('unknown site gets the same refusal as a bad signature', async () => {
  const response = await makeHandler()(buildRequest({ site: 'site-z', nonce: nonceOf(7), body: defaultBody({ site: 'site-z' }) }));
  assert.equal(response.status, 401);
  assert.equal(refused(response).reason, 'bad_signature');
});

test('empty site secret is treated as unknown', async () => {
  const response = await makeHandler({ secretForSite: () => '' })(buildRequest({ nonce: nonceOf(8) }));
  assert.equal(response.status, 401);
});

test('body over 16 KB is refused with 413 before any signature work', async () => {
  const feature = spyFeature();
  const body = defaultBody({ payload: { pad: 'x'.repeat(16400) } });
  const response = await makeHandler({ feature })({ method: 'POST', headers: {}, body });
  assert.equal(response.status, 413);
  assert.equal(refused(response).reason, 'body_too_large');
  assert.equal(feature.calls.length, 0);
});

test('signed body of exactly 16384 bytes is accepted for size', async () => {
  const base = defaultBody({ payload: { pad: '' } });
  const body = defaultBody({ payload: { pad: 'x'.repeat(16384 - Buffer.byteLength(base)) } });
  assert.equal(Buffer.byteLength(body), 16384);
  const feature = spyFeature();
  const response = await makeHandler({ feature })(buildRequest({ body, nonce: nonceOf(9) }));
  assert.equal(response.status, 200);
  assert.equal(feature.calls.length, 1);
});

test('invalid JSON is refused with 400', async () => {
  const response = await makeHandler()(buildRequest({ body: '{"contract":', nonce: nonceOf(10) }));
  assert.equal(response.status, 400);
  assert.equal(refused(response).reason, 'invalid_request');
});

test('tenant named in the body must match the header, and a mismatch is refused with 403', async () => {
  const feature = spyFeature();
  const response = await makeHandler({ feature })(buildRequest({ body: defaultBody({ site: 'site-b' }), nonce: nonceOf(11) }));
  assert.equal(response.status, 403);
  assert.equal(refused(response).reason, 'tenant_mismatch');
  assert.equal(feature.calls.length, 0);
});

test('feature outside the allowlist is refused with 400, including prototype names', async () => {
  for (const feature of ['gdpr.export', 'constructor', 'booking.create']) {
    const feat = spyFeature();
    const response = await makeHandler({ feature: feat })(buildRequest({ body: defaultBody({ feature }), nonce: nonceOf(12) }));
    assert.equal(response.status, 400, feature);
    assert.equal(refused(response).reason, 'feature_not_allowed', feature);
    assert.equal(feat.calls.length, 0, feature);
  }
});

test('extra granted scope the feature does not use is accepted, and the feature receives only its own scope', async () => {
  const body = defaultBody({ consent: { version: CONSENT_VERSION, scopes: ['faq.read', 'booking.write'] } });
  const feature = spyFeature();
  const response = await makeHandler({ feature })(buildRequest({ body, nonce: nonceOf(13) }));
  assert.equal(response.status, 200);
  assert.equal(feature.calls.length, 1);
  assert.deepEqual(feature.calls[0].scopes, ['faq.read']);
});

test('feature still refused with 403 when none of its required scopes is in the grant', async () => {
  const body = defaultBody({ consent: { version: CONSENT_VERSION, scopes: ['booking.write'] } });
  const feature = spyFeature();
  const response = await makeHandler({ feature })(buildRequest({ body, nonce: nonceOf(33) }));
  assert.equal(response.status, 403);
  assert.equal(refused(response).reason, 'scope_not_granted');
  assert.equal(feature.calls.length, 0);
});

test('unknown scope name in consent is refused with 400 invalid_request', async () => {
  const body = defaultBody({ consent: { version: CONSENT_VERSION, scopes: ['faq.read', 'made.up'] } });
  const feature = spyFeature();
  const response = await makeHandler({ feature })(buildRequest({ body, nonce: nonceOf(34) }));
  assert.equal(response.status, 400);
  assert.equal(refused(response).reason, 'invalid_request');
  assert.equal(feature.calls.length, 0);
});

test('non-string consent scope is refused with 400 invalid_request', async () => {
  const body = defaultBody({ consent: { version: CONSENT_VERSION, scopes: ['faq.read', 7] } });
  const feature = spyFeature();
  const response = await makeHandler({ feature })(buildRequest({ body, nonce: nonceOf(35) }));
  assert.equal(response.status, 400);
  assert.equal(refused(response).reason, 'invalid_request');
  assert.equal(feature.calls.length, 0);
});

test('consent scope the feature needs but the admin has not granted is refused with 403', async () => {
  const feature = spyFeature();
  const response = await makeHandler({ feature, granted: [] })(buildRequest({ nonce: nonceOf(14) }));
  assert.equal(response.status, 403);
  assert.equal(refused(response).reason, 'scope_not_granted');
  assert.equal(feature.calls.length, 0);
});

test('wrong consent version is refused with 400', async () => {
  const body = defaultBody({ consent: { version: 'tzfd-ai-consent-0', scopes: ['faq.read'] } });
  const response = await makeHandler()(buildRequest({ body, nonce: nonceOf(15) }));
  assert.equal(response.status, 400);
});

test('payload must be an object or array; an empty PHP array is accepted', async () => {
  const handler = makeHandler();
  const bad = await handler(buildRequest({ body: defaultBody({ payload: 'text' }), nonce: nonceOf(16) }));
  assert.equal(bad.status, 400);
  const emptyArray = await handler(buildRequest({ body: defaultBody({ payload: [] }), nonce: nonceOf(17) }));
  assert.equal(emptyArray.status, 200);
});

test('non-POST method is refused with 405', async () => {
  const response = await makeHandler()(buildRequest({ method: 'GET', nonce: nonceOf(18) }));
  assert.equal(response.status, 405);
});

test('a feature that throws gets a signed service_error with no secret or error text', async () => {
  const request = buildRequest({ nonce: nonceOf(19) });
  const response = await makeHandler({ feature: async () => { throw new Error(`boom ${TEST_SECRET}`); } })(request);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).status, 'service_error');
  assert.equal(response.body.includes('boom'), false);
  assert.equal(pluginAcceptsResponse(response, request), true);
});

test('a feature returning an unknown status is answered as a signed service_error', async () => {
  const response = await makeHandler({ feature: () => ({ status: 'banana' }) })(buildRequest({ nonce: nonceOf(20) }));
  assert.equal(JSON.parse(response.body).status, 'service_error');
});

test('a reply over 64 KB is replaced with a signed service_error', async () => {
  const request = buildRequest({ nonce: nonceOf(21) });
  const feature = () => ({ status: 'ok', data: { blob: 'x'.repeat(70000) } });
  const response = await makeHandler({ feature })(request);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).status, 'service_error');
  assert.equal(pluginAcceptsResponse(response, request), true);
});

test('default feature implementation answers service_error with no model call', async () => {
  assert.deepEqual(await defaultFeatureImplementation({ site: TEST_SITE, feature: 'faq.answer', payload: {}, scopes: [] }), { status: 'service_error' });
  const handler = createConnectorHandler({
    secretForSite: (site) => (site === TEST_SITE ? TEST_SECRET : null),
    grantedScopes: () => ALL_GRANTED,
    now: () => NOW_S * 1000,
  });
  const response = await handler(buildRequest({ nonce: nonceOf(22) }));
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).status, 'service_error');
});

test('a secret lookup that throws becomes a structured 500 refusal', async () => {
  const response = await makeHandler({ secretForSite: () => { throw new Error('db down'); } })(buildRequest({ nonce: nonceOf(23) }));
  assert.equal(response.status, 500);
  assert.equal(refused(response).reason, 'internal_error');
  assert.equal(response.body.includes('db down'), false);
});

test('no refusal leaks the secret, and no feature runs on any refusal', async () => {
  const feature = spyFeature();
  const handler = makeHandler({ feature });
  const cases = [
    buildRequest({ headers: { 'X-TZFD-Contract': 'nope' } }),
    buildRequest({ site: 'bad site!' }),
    buildRequest({ ts: String(NOW_S - 999), nonce: nonceOf(30) }),
    buildRequest({ secret: 'wrong', nonce: nonceOf(31) }),
    buildRequest({ body: defaultBody({ feature: 'nope' }), nonce: nonceOf(32) }),
    { method: 'POST', headers: {}, body: 'x'.repeat(16500) },
  ];
  for (const request of cases) {
    const response = await handler(request);
    assert.ok(response.status >= 400, `expected refusal, got ${response.status}`);
    assert.equal(response.body.includes(TEST_SECRET), false);
    assert.equal(response.headers['X-TZFD-Signature'], undefined);
  }
  assert.equal(feature.calls.length, 0);
});

test('Origin and Referer are not identity: a spoofed Origin does not pass a bad signature, and a missing Origin does not block a good one', async () => {
  const feature = spyFeature();
  const handler = makeHandler({ feature });
  const badSigned = await handler(buildRequest({ nonce: nonceOf(9), signature: 'sha256=' + '0'.repeat(64), headers: { Origin: `https://${TEST_SITE}.example` } }));
  assert.equal(badSigned.status, 401);
  assert.equal(refused(badSigned).reason, 'bad_signature');
  const goodNoOrigin = await handler(buildRequest({ nonce: nonceOf(10), headers: { Origin: 'https://evil.example', Referer: 'https://evil.example/' } }));
  assert.equal(goodNoOrigin.status, 200);
  assert.equal(feature.calls.length, 1);
});
