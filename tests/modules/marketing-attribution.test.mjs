// Click attribution: resolves a tracking link to a campaign and source within one company. Fail closed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrackingLink } from '../../server/modules/marketing/tracking-links.ts';
import { attributeClick } from '../../server/modules/marketing/attribution.ts';

// Silence any output from server code so the test runner IPC stays clean.
for (const method of ['log', 'info', 'warn']) console[method] = () => {};

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';
const BASE = 'https://client.example/landing';

// Fake campaign refs: a set of "company:campaign" pairs that exist, plus a log of every lookup.
function fakeRefs(existing = [`${CO_A}:camp-1`]) {
  const calls = [];
  return {
    calls,
    async campaignExists(companyId, campaignId) {
      calls.push({ companyId, campaignId });
      return existing.includes(`${companyId}:${campaignId}`);
    },
  };
}

function linkFor(companyId, overrides = {}) {
  const r = buildTrackingLink({
    baseUrl: BASE,
    companyId,
    campaignId: 'camp-1',
    channel: 'email',
    source: 'newsletter',
    ...overrides,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.url;
}

test('a click on a link minted for the company resolves to its campaign and source', async () => {
  const refs = fakeRefs();
  const result = await attributeClick({ companyId: CO_A, url: linkFor(CO_A) }, refs);
  assert.deepEqual(result, {
    ok: true,
    companyId: CO_A,
    campaignId: 'camp-1',
    channel: 'email',
    source: 'newsletter',
    tid: new URL(linkFor(CO_A)).searchParams.get('tid'),
  });
  assert.deepEqual(refs.calls, [{ companyId: CO_A, campaignId: 'camp-1' }]);
});

test('a missing company refuses as missing_company and never looks anything up', async () => {
  const refs = fakeRefs();
  for (const companyId of [undefined, null, '']) {
    assert.deepEqual(await attributeClick({ companyId, url: linkFor(CO_A) }, refs), {
      ok: false,
      reason: 'missing_company',
    });
  }
  assert.equal(refs.calls.length, 0);
});

test('a company that is not a UUID refuses as invalid_company', async () => {
  const refs = fakeRefs();
  assert.deepEqual(await attributeClick({ companyId: 'acme', url: linkFor(CO_A) }, refs), {
    ok: false,
    reason: 'invalid_company',
  });
  assert.deepEqual(await attributeClick({ companyId: 42, url: linkFor(CO_A) }, refs), {
    ok: false,
    reason: 'invalid_company',
  });
  assert.equal(refs.calls.length, 0);
});

test('a link minted for another company refuses as token_mismatch', async () => {
  const refs = fakeRefs([`${CO_B}:camp-1`]);
  assert.deepEqual(await attributeClick({ companyId: CO_B, url: linkFor(CO_A) }, refs), {
    ok: false,
    reason: 'token_mismatch',
  });
});

test('a link whose campaign was edited after minting refuses as token_mismatch', async () => {
  const refs = fakeRefs([`${CO_A}:camp-2`, `${CO_A}:camp-1`]);
  const tampered = linkFor(CO_A).replace('utm_campaign=camp-1', 'utm_campaign=camp-2');
  assert.deepEqual(await attributeClick({ companyId: CO_A, url: tampered }, refs), {
    ok: false,
    reason: 'token_mismatch',
  });
});

test('a link whose source was edited after minting refuses as token_mismatch', async () => {
  const refs = fakeRefs();
  const tampered = linkFor(CO_A).replace('utm_source=newsletter', 'utm_source=other');
  assert.deepEqual(await attributeClick({ companyId: CO_A, url: tampered }, refs), {
    ok: false,
    reason: 'token_mismatch',
  });
});

test('a campaign that does not exist in the company refuses as unknown_campaign', async () => {
  const refs = fakeRefs([]);
  assert.deepEqual(await attributeClick({ companyId: CO_A, url: linkFor(CO_A) }, refs), {
    ok: false,
    reason: 'unknown_campaign',
  });
});

test('a truthy but non-true lookup answer refuses as unknown_campaign', async () => {
  const refs = { async campaignExists() { return 'yes'; } };
  assert.deepEqual(await attributeClick({ companyId: CO_A, url: linkFor(CO_A) }, refs), {
    ok: false,
    reason: 'unknown_campaign',
  });
});

test('a lookup that throws refuses as lookup_failed with no detail', async () => {
  const refs = {
    async campaignExists() {
      throw new Error('connection to db-host:5432 refused');
    },
  };
  assert.deepEqual(await attributeClick({ companyId: CO_A, url: linkFor(CO_A) }, refs), {
    ok: false,
    reason: 'lookup_failed',
  });
});

test('a plain URL or a non-string url refuses as not_tracking_link', async () => {
  const refs = fakeRefs();
  assert.deepEqual(await attributeClick({ companyId: CO_A, url: `${BASE}?ref=abc` }, refs), {
    ok: false,
    reason: 'not_tracking_link',
  });
  assert.deepEqual(await attributeClick({ companyId: CO_A, url: null }, refs), {
    ok: false,
    reason: 'not_tracking_link',
  });
  assert.equal(refs.calls.length, 0);
});

test('the company comes from the caller, not from any company-like value in the link', async () => {
  const refs = fakeRefs();
  const url = `${linkFor(CO_A)}&company_id=${CO_B}`;
  assert.deepEqual(await attributeClick({ companyId: CO_B, url }, refs), {
    ok: false,
    reason: 'token_mismatch',
  });
  assert.equal(refs.calls.length, 0);
});
