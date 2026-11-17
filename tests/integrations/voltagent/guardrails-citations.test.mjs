import assert from 'node:assert/strict';
import test from 'node:test';
import { createBlockedTermGuardrail } from '../../../server/services/ai-runtime/guardrail.ts';
import { toVoltGuardrail } from '../../../server/integrations/voltagent/guardrails/adapter.ts';
import { createVoltCitationResolver } from '../../../server/integrations/voltagent/citations/adapter.ts';

test('blocked term is refused with a reason', async () => {
  const guard = toVoltGuardrail(createBlockedTermGuardrail({ blocked_terms: ['wire money'] }));
  const out = await guard({ companyId: 'co-1', text: 'please wire money now' });
  assert.equal(out.pass, false);
  assert.equal(typeof out.reason, 'string');
});

test('clean text passes', async () => {
  const guard = toVoltGuardrail(createBlockedTermGuardrail({ blocked_terms: ['wire money'] }));
  assert.deepEqual(await guard({ companyId: 'co-1', text: 'book a clean on Friday' }), { pass: true });
});

test('a missing companyId is refused before screening', async () => {
  const guard = toVoltGuardrail(createBlockedTermGuardrail({ blocked_terms: [] }));
  await assert.rejects(guard({ companyId: '', text: 'hi' }));
});

test('a verdict that is not exactly pass true blocks (fail closed)', async () => {
  const guard = toVoltGuardrail({ evaluate: () => ({ pass: 'yes' }) });
  assert.equal((await guard({ companyId: 'co-1', text: 'hi' })).pass, false);
});

const result = (document_id, chunk_index) => ({
  chunk_id: `${document_id}:${chunk_index}`, document_id, chunk_index, text: 'x', metadata: {},
});

test('citations map to the VoltAgent source shape and keep the tenant', async () => {
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
