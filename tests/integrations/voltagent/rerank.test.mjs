// Licence: original TitanZero test code. No Mastra or VoltAgent source is copied. No network: fetch is mocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCohereReranker, RerankError, rerankItems } from '../../../server/integrations/voltagent/rerank/cohere-reranker.ts';

function mockFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return respond(init);
  };
  return { fn, calls };
}

const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('builds without a key is refused', () => {
  assert.throws(() => createCohereReranker({ apiKey: '' }), /rerank_api_key_required/);
  assert.throws(() => createCohereReranker({ apiKey: undefined }), /rerank_api_key_required/);
});

test('sends the query, documents and top_n to the rerank endpoint with a bearer key', async () => {
  const m = mockFetch(() => jsonResponse({ results: [{ index: 1, relevance_score: 0.9 }] }));
  const r = createCohereReranker({ apiKey: 'k_test', fetchImpl: m.fn, baseUrl: 'https://rerank.example/' });
  await r.rerank('boiler', ['pool', 'boiler'], 1);
  assert.equal(m.calls.length, 1);
  assert.equal(m.calls[0].url, 'https://rerank.example/v2/rerank');
  assert.equal(m.calls[0].init.method, 'POST');
  assert.equal(m.calls[0].init.headers.authorization, 'Bearer k_test');
  assert.deepEqual(m.calls[0].body, { model: 'rerank-v3.5', query: 'boiler', documents: ['pool', 'boiler'], top_n: 1 });
});

test('results come back sorted by score, highest first, with original indexes', async () => {
  const m = mockFetch(() => jsonResponse({ results: [{ index: 0, relevance_score: 0.2 }, { index: 2, relevance_score: 0.8 }, { index: 1, relevance_score: 0.5 }] }));
  const r = createCohereReranker({ apiKey: 'k', fetchImpl: m.fn });
  const out = await r.rerank('q', ['a', 'b', 'c']);
  assert.deepEqual(out, [{ index: 2, score: 0.8 }, { index: 1, score: 0.5 }, { index: 0, score: 0.2 }]);
});

test('empty documents return [] and make no request', async () => {
  const m = mockFetch(() => jsonResponse({ results: [] }));
  const out = await createCohereReranker({ apiKey: 'k', fetchImpl: m.fn }).rerank('q', []);
  assert.deepEqual(out, []);
  assert.equal(m.calls.length, 0);
});

test('top_n is clamped to the document count and at least 1', async () => {
  const m = mockFetch(() => jsonResponse({ results: [] }));
  const r = createCohereReranker({ apiKey: 'k', fetchImpl: m.fn });
  await r.rerank('q', ['a', 'b'], 50);
  await r.rerank('q', ['a', 'b'], 0);
  assert.equal(m.calls[0].body.top_n, 2);
  assert.equal(m.calls[1].body.top_n, 1);
});

test('a non-2xx status throws rerank_failed with the status and no key or body', async () => {
  const m = mockFetch(() => jsonResponse({ message: 'bad key k_test echoed' }, 401));
  const r = createCohereReranker({ apiKey: 'k_test', fetchImpl: m.fn });
  await assert.rejects(
    () => r.rerank('q', ['a']),
    (err) => err instanceof RerankError && err.code === 'rerank_failed' && err.status === 401 && !err.message.includes('k_test'),
  );
});

test('a network error throws rerank_failed without the underlying message', async () => {
  const r = createCohereReranker({ apiKey: 'k', fetchImpl: async () => { throw new Error('ECONNRESET to internal host'); } });
  await assert.rejects(() => r.rerank('q', ['a']), (err) => err instanceof RerankError && err.code === 'rerank_failed' && !err.message.includes('internal'));
});

test('a timeout aborts the request and throws rerank_timeout', async () => {
  const r = createCohereReranker({
    apiKey: 'k',
    timeoutMs: 100,
    fetchImpl: (url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
  await assert.rejects(() => r.rerank('q', ['a']), (err) => err instanceof RerankError && err.code === 'rerank_timeout');
});

test('malformed responses are refused', async () => {
  const bad = [
    {},
    { results: 'nope' },
    { results: [{ index: 5, relevance_score: 0.1 }] },
    { results: [{ index: -1, relevance_score: 0.1 }] },
    { results: [{ index: 0, relevance_score: 'high' }] },
    { results: [{ index: 0, relevance_score: Number.NaN }] },
    { results: [{ index: 0.5, relevance_score: 0.1 }] },
  ];
  for (const body of bad) {
    const m = mockFetch(() => jsonResponse(body));
    const r = createCohereReranker({ apiKey: 'k', fetchImpl: m.fn });
    await assert.rejects(() => r.rerank('q', ['only']), (err) => err instanceof RerankError && err.code === 'rerank_response_invalid');
  }
});

test('invalid inputs are refused before any request', async () => {
  const m = mockFetch(() => jsonResponse({ results: [] }));
  const r = createCohereReranker({ apiKey: 'k', fetchImpl: m.fn });
  await assert.rejects(() => r.rerank('   ', ['a']), /rerank_input_invalid/);
  await assert.rejects(() => r.rerank('q', ['a', 3]), /rerank_input_invalid/);
  await assert.rejects(() => r.rerank('q', Array.from({ length: 1001 }, () => 'x')), /rerank_input_invalid/);
  assert.equal(m.calls.length, 0);
});

test('rerankItems maps scores back onto the original items', async () => {
  const m = mockFetch(() => jsonResponse({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.3 }] }));
  const r = createCohereReranker({ apiKey: 'k', fetchImpl: m.fn });
  const items = [{ id: 'a', text: 'pool' }, { id: 'b', text: 'boiler' }];
  const out = await rerankItems(r, 'boiler', items, (i) => i.text);
  assert.deepEqual(out.map((x) => [x.item.id, x.score]), [['b', 0.9], ['a', 0.3]]);
});
