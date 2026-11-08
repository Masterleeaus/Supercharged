import test from 'node:test';
import assert from 'node:assert/strict';
// Register the @shared/* alias hook before loading embed-cors.ts.
await import('../engines/loader-hook.mjs');
const { applyEmbedCors } = await import('../../server/middleware/embed-cors.ts');

// Fake Express request/response and a fake Drizzle-style db. No network, no real database.
// The allowlist is cached for 60s per process, so every case here uses an empty or failing
// read. The failing case runs first so it is not masked by a cached empty result.

function fakeRes() {
  const headers = {};
  const calls = [];
  return {
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; calls.push(name); },
    vary(value) { headers.vary = value; },
  };
}

function fakeDb(rowsOrError) {
  return {
    select: () => ({
      from: () => {
        if (rowsOrError instanceof Error) return Promise.reject(rowsOrError);
        return Promise.resolve(rowsOrError);
      },
    }),
  };
}

const req = (origin) => ({ headers: origin === undefined ? {} : { origin } });

test('failed allowlist read fails closed', async () => {
  const res = fakeRes();
  const ok = await applyEmbedCors(fakeDb(new Error('db down')), req('https://example.com'), res);
  assert.equal(ok, false);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('empty allowlist sends no Access-Control-Allow-Origin', async () => {
  const res = fakeRes();
  const ok = await applyEmbedCors(fakeDb([]), req('https://example.com'), res);
  assert.equal(ok, false);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.headers.vary, 'Origin');
});

test('rows with no usable domains also send no Access-Control-Allow-Origin', async () => {
  const res = fakeRes();
  const rows = [{ allowedDomains: null }, { allowedDomains: [] }, { allowedDomains: ['', '*', 'http://x.com'] }];
  const ok = await applyEmbedCors(fakeDb(rows), req('https://example.com'), res);
  assert.equal(ok, false);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('empty allowlist refuses a preflight-style request with any origin', async () => {
  const res = fakeRes();
  const ok = await applyEmbedCors(fakeDb([]), req('https://shop.example.com'), res);
  assert.equal(ok, false);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('missing Origin header with empty allowlist sends no header', async () => {
  const res = fakeRes();
  const ok = await applyEmbedCors(fakeDb([]), req(undefined), res);
  assert.equal(ok, false);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});
