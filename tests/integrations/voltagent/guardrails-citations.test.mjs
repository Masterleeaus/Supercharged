import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlockedTermGuardrail } from '../../../server/services/ai-runtime/guardrail.ts';
import { toVoltGuardrail, VOLTAGENT_COMPANY_KEY } from '../../../server/integrations/voltagent/guardrails/adapter.ts';
import { createVoltCitationResolver } from '../../../server/integrations/voltagent/citations/adapter.ts';

// VoltAgent 2.11.1 input guardrail args: inputText + context.context (Map). Tenant lives in the Map.
const args = (inputText, companyId = 'co-1') => {  // pass null to omit the tenant
  const map = new Map();
  if (companyId !== null) map.set(VOLTAGENT_COMPANY_KEY, companyId);
  return { inputText, context: { context: map } };
};

test('blocked term is refused with action block and a message', async () => {
  const guard = toVoltGuardrail(createBlockedTermGuardrail({ blocked_terms: ['wire money'] }));
  const out = await guard(args('please wire money now'));
  assert.equal(out.pass, false);
  assert.equal(out.action, 'block');
  assert.equal(typeof out.message, 'string');
});

test('clean text passes with action allow', async () => {
  const guard = toVoltGuardrail(createBlockedTermGuardrail({ blocked_terms: ['wire money'] }));
  assert.deepEqual(await guard(args('book a clean on Friday')), { pass: true, action: 'allow' });
});

test('a missing tenant in the operation context blocks before screening', async () => {
  let called = false;
  const guard = toVoltGuardrail({ evaluate: () => { called = true; return { pass: true }; } });
  const out = await guard(args('hi', null));
  assert.equal(out.pass, false);
  assert.equal(out.action, 'block');
  assert.equal(called, false);
});

test('an invalid tenant value blocks (text cannot supply the tenant)', async () => {
  const guard = toVoltGuardrail({ evaluate: () => ({ pass: true }) });
  assert.equal((await guard(args('co-1', '  bad id  '))).pass, false);
});

test('a verdict that is not exactly pass true blocks (fail closed)', async () => {
  const guard = toVoltGuardrail({ evaluate: () => ({ pass: 'yes' }) });
  assert.equal((await guard(args('hi'))).pass, false);
});

test('a guardrail that throws blocks (fail closed)', async () => {
  const guard = toVoltGuardrail({ evaluate: () => { throw new Error('boom'); } });
  const out = await guard(args('hi'));
  assert.equal(out.pass, false);
  assert.equal(out.action, 'block');
});

const result = (document_id, chunk_index) => ({
  chunk_id: `${document_id}:${chunk_index}`, document_id, chunk_index, text: 'x', metadata: {},
});

test('citations map to the app source shape and keep the tenant', async () => {
  const resolve = createVoltCitationResolver(async (keys, co) =>
    keys.map((k) => ({
      company_id: co, document_id: k.document_id, chunk_index: k.chunk_index,
      content: 'Price list for spring.', content_hash: 'h1', document_title: 'Prices', document_source: 'https://example.com/p',
    })),
  );
  const out = await resolve([result(7, 0)], 'co-1');
  assert.equal(out.sources.length, 1);
  assert.equal(out.sources[0].url, 'https://example.com/p');
  assert.equal(out.sources[0].chunk.document_id, 7);
  assert.equal(out.unresolved, 0);
});

test('a chunk loaded for another tenant is dropped', async () => {
  const resolve = createVoltCitationResolver(async (keys) =>
    keys.map((k) => ({
      company_id: 'co-OTHER', document_id: k.document_id, chunk_index: k.chunk_index,
      content: 'secret', content_hash: 'h', document_title: 't', document_source: 'doc-ref',
    })),
  );
  const out = await resolve([result(9, 1)], 'co-1');
  assert.equal(out.sources.length, 0);
  assert.equal(out.unresolved, 1);
});

test('no results means no citations and no loader call', async () => {
  let called = false;
  const resolve = createVoltCitationResolver(async () => { called = true; return []; });
  assert.deepEqual(await resolve([], 'co-1'), { sources: [], unresolved: 0 });
  assert.equal(called, false);
});

test('a missing tenant on citations throws before any loader call', async () => {
  let called = false;
  const resolve = createVoltCitationResolver(async () => { called = true; return []; });
  await assert.rejects(resolve([result(1, 0)], ''));
  assert.equal(called, false);
});
