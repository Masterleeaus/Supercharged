import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// Register the @shared/* alias hook before loading embed-cors.ts.
await import('../engines/loader-hook.mjs');
const { applyEmbedCors } = await import('../../server/middleware/embed-cors.ts');

// Narrow test for the /widget static CORS path. Fake request, response and db only.
// No network, no database. Each test file runs in its own process, so the 60s allowlist
// cache here holds only the single non-empty allowlist used below.

function fakeRes() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) { headers[name.toLowerCase()] = value; },
    vary(value) { headers.vary = value; },
  };
}

function fakeDb(rows) {
  return { select: () => ({ from: () => Promise.resolve(rows) }) };
}

const req = (origin) => ({ headers: origin === undefined ? {} : { origin } });
const ROWS = [{ allowedDomains: ['example.com'] }];

test('allowlisted https origin is echoed back, not wildcarded', async () => {
  const res = fakeRes();
  const ok = await applyEmbedCors(fakeDb(ROWS), req('https://shop.example.com'), res);
  assert.equal(ok, true);
  assert.equal(res.headers['access-control-allow-origin'], 'https://shop.example.com');
  assert.notEqual(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers.vary, 'Origin');
});

test('origin not on the allowlist gets no Access-Control-Allow-Origin', async () => {
  const res = fakeRes();
  const ok = await applyEmbedCors(fakeDb(ROWS), req('https://attacker.org'), res);
  assert.equal(ok, false);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.equal(res.headers.vary, 'Origin');
});

test('lookalike origin without a dot boundary gets no header', async () => {
  const res = fakeRes();
  const ok = await applyEmbedCors(fakeDb(ROWS), req('https://evilexample.com'), res);
  assert.equal(ok, false);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('request with no Origin header gets no header', async () => {
  const res = fakeRes();
  const ok = await applyEmbedCors(fakeDb(ROWS), req(undefined), res);
  assert.equal(ok, false);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('server/index.ts /widget block delegates CORS to applyEmbedCors and sets no wildcard', () => {
  const src = fs.readFileSync(new URL('../../server/index.ts', import.meta.url), 'utf8');
  const start = src.indexOf("app.use('/widget'");
  assert.ok(start >= 0, '/widget block must exist');
  const block = src.slice(start, src.indexOf('express.static', start));
  assert.match(block, /await applyEmbedCors\(db, req, res\)/);
  assert.doesNotMatch(block, /Access-Control-Allow-Origin/i);
});
