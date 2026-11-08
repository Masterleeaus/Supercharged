import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// Tests the global JSON body limit (issue #36) on a small express app that uses the same
// perRouteBodyParser wrapper as server/index.ts. The full server is not booted.
const { perRouteBodyParser, bodyLimitFor, DEFAULT_BODY_LIMIT } =
  await import('../../server/middleware/body-limits.ts');

const MB = 1024 * 1024;
let server;
let base;

before(async () => {
  const app = express();
  app.use(perRouteBodyParser((limit) => express.json({ limit })));
  app.post('/echo', (req, res) => res.json({ ok: true, keys: Object.keys(req.body ?? {}) }));
  app.post('/api/knowledge-base/text', (req, res) => res.json({ ok: true }));
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
});

function postJson(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('default JSON limit is 1mb', () => {
  assert.equal(DEFAULT_BODY_LIMIT, '1mb');
  assert.equal(bodyLimitFor('POST', '/echo'), '1mb');
});

test('a body over the default limit is rejected with 413', async () => {
  const res = await postJson('/echo', { text: 'a'.repeat(MB + 1024) });
  assert.equal(res.status, 413);
});

test('a small body succeeds', async () => {
  const res = await postJson('/echo', { name: 'small' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, keys: ['name'] });
});

test('the listed knowledge base text route accepts a body over 1mb', async () => {
  const res = await postJson('/api/knowledge-base/text', { text: 'a'.repeat(MB + 1024) });
  assert.equal(res.status, 200);
});

test('the exception applies only to its method and path', () => {
  assert.equal(bodyLimitFor('POST', '/api/knowledge-base/text?x=1'), '2mb');
  assert.equal(bodyLimitFor('GET', '/api/knowledge-base/text'), '1mb');
  assert.equal(bodyLimitFor('PATCH', '/api/flow-automation/flows/abc-123'), '2mb');
  assert.equal(bodyLimitFor('POST', '/api/flow-automation/flows/abc-123'), '1mb');
  assert.equal(bodyLimitFor('POST', '/api/webhooks/elevenlabs/rag-tool/x'), '1mb');
});
