/**
 * H1 hosted endpoint tests (tzfd-ai/1). Fake registry and handlers only: no network, no database.
 * Covers the positive path and every negative case listed in docs/PLUGIN_CONNECTOR_TZFD_AI_1.md.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTzfdRequest, createMemoryNonceStore } from '../../../server/integrations/plugin-hosted/handler.ts';
import { tzfdSign, tzfdVerify } from '../../../server/integrations/plugin-hosted/contract.ts';

const SECRET = 'TEST-H1-SECRET-NOT-REAL-0123456789-ABCDEF';
const SITE = 'site_front_desk_1';
const TENANT = 'company_42';
const NOW_MS = Date.parse('2026-11-18T00:00:00Z');
const NOW_S = Math.floor(NOW_MS / 1000);
const NONCE = '0123456789abcdef0123456789abcdef';

function makeRegistry(extra = {}) {
  const sites = {
    [SITE]: { siteId: SITE, tenantId: TENANT, secret: SECRET, grantedScopes: ['faq.read', 'customer.read'] },
    ...extra,
  };
  return { lookup: (id) => sites[id] ?? null };
}

function makeOpts(overrides = {}) {
  const calls = [];
  const handlers = {
    'faq.answer': async (ctx) => {
      calls.push(ctx);
      return { status: 'ok', data: { answer: 'grounded' }, usage: { tokens_in: 5, tokens_out: 7, embedding_tokens: 0, cache_hit: false } };
    },
  };
  return {
    opts: {
      registry: makeRegistry(),
      nonces: createMemoryNonceStore(),
      handlers,
      now: () => NOW_MS,
      ...overrides,
    },
    calls,
  };
}

function envelope(overrides = {}) {
  return {
    contract: 'tzfd-ai/1',
    site: SITE,
    feature: 'faq.answer',
    consent: { version: 'tzfd-ai-consent-1', scopes: ['faq.read'] },
    payload: { question: 'Do you clean carpets?' },
    ...overrides,
  };
}

/** Builds a correctly signed request. `mutate` can change any part afterwards for negative tests. */
function signedRequest({ body = JSON.stringify(envelope()), secret = SECRET, timestamp = String(NOW_S), nonce = NONCE, site = SITE, method = 'POST', contract = 'tzfd-ai/1', mutate } = {}) {
  const sig = tzfdSign(secret, timestamp, nonce, body);
  const req = {
    method,
    headers: {
      'X-TZFD-Contract': contract,
      'X-TZFD-Site': site,
      'X-TZFD-Timestamp': timestamp,
      'X-TZFD-Nonce': nonce,
      'X-TZFD-Signature': sig,
      'Content-Type': 'application/json',
    },
    body,
  };
  if (mutate) mutate(req);
  return req;
}

function parseSigned(res) {
  return JSON.parse(res.body);
}

test('valid signed request runs the handler with the registry tenant and returns a signed response', async () => {
  const { opts, calls } = makeOpts();
  const res = await handleTzfdRequest(opts, signedRequest());
  assert.equal(res.status, 200);
  const body = parseSigned(res);
  assert.equal(body.status, 'ok');
  assert.equal(body.site, SITE);
  assert.deepEqual(body.data, { answer: 'grounded' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tenantId, TENANT);
  assert.equal(res.headers['X-TZFD-Nonce'], NONCE, 'response echoes the request nonce');
  assert.equal(
    tzfdVerify(SECRET, res.headers['X-TZFD-Timestamp'], res.headers['X-TZFD-Nonce'], res.body, res.headers['X-TZFD-Signature']),
    true,
    'response signature verifies with the site secret',
  );
});

test('tenant comes from the registry, not from the body', async () => {
  const { opts, calls } = makeOpts();
  const body = JSON.stringify(envelope({ tenant_id: 'company_99', company_id: 'company_99' }));
  const res = await handleTzfdRequest(opts, signedRequest({ body }));
  assert.equal(res.status, 200);
  assert.equal(calls[0].tenantId, TENANT);
});

test('a site with no registry entry is refused unsigned', async () => {
  const { opts } = makeOpts();
  const res = await handleTzfdRequest(opts, signedRequest({ site: 'site_unknown' }));
  assert.equal(res.status, 401);
  assert.equal(res.headers['X-TZFD-Signature'], undefined);
});

test('forged signature is refused and the handler never runs', async () => {
  const { opts, calls } = makeOpts();
  const res = await handleTzfdRequest(opts, signedRequest({ secret: 'z'.repeat(48) }));
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('a body changed after signing is refused', async () => {
  const { opts, calls } = makeOpts();
  const res = await handleTzfdRequest(opts, signedRequest({ mutate: (r) => { r.body = JSON.stringify(envelope({ payload: { question: 'changed' } })); } }));
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('replayed nonce is refused the second time', async () => {
  const { opts, calls } = makeOpts();
  const first = await handleTzfdRequest(opts, signedRequest());
  const second = await handleTzfdRequest(opts, signedRequest());
  assert.equal(first.status, 200);
  assert.equal(second.status, 401);
  assert.equal(calls.length, 1);
});

test('same nonce for a different site is not a replay', async () => {
  const other = 'site_other_2';
  const { opts } = makeOpts({
    registry: makeRegistry({ [other]: { siteId: other, tenantId: 'company_7', secret: SECRET, grantedScopes: ['faq.read'] } }),
  });
  assert.equal((await handleTzfdRequest(opts, signedRequest())).status, 200);
  assert.equal((await handleTzfdRequest(opts, signedRequest({ site: other }))).status, 200);
});

test('expired timestamp (more than 300 s old) is refused', async () => {
  const { opts } = makeOpts();
  const old = String(NOW_S - 301);
  assert.equal((await handleTzfdRequest(opts, signedRequest({ timestamp: old }))).status, 401);
});

test('timestamp too far in the future is refused', async () => {
  const { opts } = makeOpts();
  assert.equal((await handleTzfdRequest(opts, signedRequest({ timestamp: String(NOW_S + 301) }))).status, 401);
});

test('timestamp at the edge of the window is accepted', async () => {
  const { opts } = makeOpts();
  assert.equal((await handleTzfdRequest(opts, signedRequest({ timestamp: String(NOW_S - 300) }))).status, 200);
});

test('wrong site id in the header is refused even when signed with the same secret', async () => {
  const { opts, calls } = makeOpts();
  const res = await handleTzfdRequest(opts, signedRequest({ mutate: (r) => { r.headers['X-TZFD-Site'] = 'bad id!'; } }));
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('body naming a different site is a signed tenant-mismatch refusal', async () => {
  const { opts, calls } = makeOpts();
  const body = JSON.stringify(envelope({ site: 'site_someone_else' }));
  const res = await handleTzfdRequest(opts, signedRequest({ body }));
  assert.equal(res.status, 200);
  assert.equal(parseSigned(res).status, 'service_error');
  assert.equal(calls.length, 0);
});

test('oversized body (over 16 KB) is refused before signature work', async () => {
  const { opts, calls } = makeOpts();
  const body = JSON.stringify(envelope({ payload: { question: 'x'.repeat(16 * 1024 + 10) } }));
  const res = await handleTzfdRequest(opts, signedRequest({ body }));
  assert.equal(res.status, 413);
  assert.equal(calls.length, 0);
});

test('feature outside the allowlist is refused with contract_unsupported and the handler does not run', async () => {
  const { opts, calls } = makeOpts();
  const body = JSON.stringify(envelope({ feature: 'admin.dump' }));
  const res = await handleTzfdRequest(opts, signedRequest({ body }));
  assert.equal(res.status, 200);
  assert.equal(parseSigned(res).status, 'contract_unsupported');
  assert.equal(calls.length, 0);
});

test('allowlisted feature with no handler is contract_unsupported', async () => {
  const { opts } = makeOpts({
    registry: makeRegistry({ [SITE]: { siteId: SITE, tenantId: TENANT, secret: SECRET, grantedScopes: ['reports.read'] } }),
  });
  const body = JSON.stringify(envelope({ feature: 'insight.monthly', consent: { version: 'tzfd-ai-consent-1', scopes: ['reports.read'] } }));
  const res = await handleTzfdRequest(opts, signedRequest({ body }));
  assert.equal(parseSigned(res).status, 'contract_unsupported');
});

test('prototype-chain feature names are refused', async () => {
  const { opts } = makeOpts();
  const body = JSON.stringify(envelope({ feature: 'constructor' }));
  const res = await handleTzfdRequest(opts, signedRequest({ body }));
  assert.equal(parseSigned(res).status, 'contract_unsupported');
});

test('scope claimed in the body but not granted on the server record is refused', async () => {
  const { opts, calls } = makeOpts({
    registry: makeRegistry({ [SITE]: { siteId: SITE, tenantId: TENANT, secret: SECRET, grantedScopes: [] } }),
  });
  const res = await handleTzfdRequest(opts, signedRequest());
  assert.equal(parseSigned(res).status, 'service_error');
  assert.equal(calls.length, 0);
});

test('scope granted on the server but not claimed in the body is refused', async () => {
  const { opts, calls } = makeOpts();
  const body = JSON.stringify(envelope({ consent: { version: 'tzfd-ai-consent-1', scopes: [] } }));
  const res = await handleTzfdRequest(opts, signedRequest({ body }));
  assert.equal(parseSigned(res).status, 'service_error');
  assert.equal(calls.length, 0);
});

test('wrong consent version is refused', async () => {
  const { opts, calls } = makeOpts();
  const body = JSON.stringify(envelope({ consent: { version: 'tzfd-ai-consent-0', scopes: ['faq.read'] } }));
  const res = await handleTzfdRequest(opts, signedRequest({ body }));
  assert.equal(parseSigned(res).status, 'contract_unsupported');
  assert.equal(calls.length, 0);
});

test('wrong contract in the body is refused', async () => {
  const { opts } = makeOpts();
  const body = JSON.stringify(envelope({ contract: 'tzfd-ai/2' }));
  assert.equal(parseSigned(await handleTzfdRequest(opts, signedRequest({ body }))).status, 'contract_unsupported');
});

test('wrong contract header is a downgrade or unknown version and is refused unsigned', async () => {
  const { opts, calls } = makeOpts();
  const res = await handleTzfdRequest(opts, signedRequest({ contract: 'tzfd-ai/0' }));
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('non-POST method is refused', async () => {
  const { opts } = makeOpts();
  assert.equal((await handleTzfdRequest(opts, signedRequest({ method: 'GET' }))).status, 405);
});

test('non-JSON body is a signed contract_unsupported refusal', async () => {
  const { opts } = makeOpts();
  const res = await handleTzfdRequest(opts, signedRequest({ body: '{not json' }));
  assert.equal(parseSigned(res).status, 'contract_unsupported');
});

test('a handler that throws returns a signed service_error without leaking its message', async () => {
  const { opts } = makeOpts({
    handlers: { 'faq.answer': async () => { throw new Error('db password is hunter2'); } },
  });
  const res = await handleTzfdRequest(opts, signedRequest());
  const body = parseSigned(res);
  assert.equal(body.status, 'service_error');
  assert.ok(!res.body.includes('hunter2'));
});

test('a handler returning an unknown status is turned into service_error', async () => {
  const { opts } = makeOpts({
    handlers: { 'faq.answer': async () => ({ status: 'anything_else' }) },
  });
  assert.equal(parseSigned(await handleTzfdRequest(opts, signedRequest())).status, 'service_error');
});

test('allowance_exhausted from a handler is passed through signed', async () => {
  const { opts } = makeOpts({
    handlers: { 'faq.answer': async () => ({ status: 'allowance_exhausted' }) },
  });
  assert.equal(parseSigned(await handleTzfdRequest(opts, signedRequest())).status, 'allowance_exhausted');
});

test('a response body over 64 KB is replaced by a signed service_error', async () => {
  const { opts } = makeOpts({
    handlers: { 'faq.answer': async () => ({ status: 'ok', data: { big: 'y'.repeat(70 * 1024) } }) },
  });
  const res = await handleTzfdRequest(opts, signedRequest());
  assert.equal(parseSigned(res).status, 'service_error');
  assert.ok(Buffer.byteLength(res.body, 'utf8') <= 64 * 1024);
});

test('a short site secret is refused unsigned', async () => {
  const { opts } = makeOpts({
    registry: makeRegistry({ [SITE]: { siteId: SITE, tenantId: TENANT, secret: 'short', grantedScopes: ['faq.read'] } }),
  });
  assert.equal((await handleTzfdRequest(opts, signedRequest({ secret: 'short' }))).status, 401);
});

test('a missing signature header is refused', async () => {
  const { opts, calls } = makeOpts();
  const res = await handleTzfdRequest(opts, signedRequest({ mutate: (r) => { delete r.headers['X-TZFD-Signature']; } }));
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('a malformed nonce is refused', async () => {
  const { opts } = makeOpts();
  assert.equal((await handleTzfdRequest(opts, signedRequest({ nonce: 'not-hex' }))).status, 401);
});

test('header lookup ignores header-name case', async () => {
  const { opts } = makeOpts();
  const res = await handleTzfdRequest(opts, signedRequest({
    mutate: (r) => {
      const h = r.headers;
      r.headers = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
    },
  }));
  assert.equal(res.status, 200);
});
