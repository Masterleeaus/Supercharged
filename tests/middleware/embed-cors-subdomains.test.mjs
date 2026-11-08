import test from 'node:test';
import assert from 'node:assert/strict';
// Register the @shared/* alias hook before loading embed-cors.ts. A static import
// would be resolved before this module body runs, so the hook would not be active.
await import('../engines/loader-hook.mjs');
const { matchOrigin } = await import('../../server/middleware/embed-cors.ts');

// Pure logic only. No network, no database, no Express.

const ENTRIES = ['example.com'];

test('exact https origin of an allowed domain is allowed', () => {
  assert.equal(matchOrigin('https://example.com', ENTRIES), true);
});

test('subdomain of an allowed domain is allowed', () => {
  assert.equal(matchOrigin('https://shop.example.com', ENTRIES), true);
  assert.equal(matchOrigin('https://deep.shop.example.com', ENTRIES), true);
});

test('lookalike suffix without a dot boundary is denied', () => {
  assert.equal(matchOrigin('https://evilexample.com', ENTRIES), false);
  assert.equal(matchOrigin('https://shop.evilexample.com', ENTRIES), false);
});

test('http origin is denied even when the host is allowed', () => {
  assert.equal(matchOrigin('http://example.com', ENTRIES), false);
  assert.equal(matchOrigin('http://shop.example.com', ENTRIES), false);
});

test('unlisted origin is denied', () => {
  assert.equal(matchOrigin('https://other.org', ENTRIES), false);
  assert.equal(matchOrigin('https://example.org', ENTRIES), false);
});

test('wildcard entry is treated as its base domain', () => {
  assert.equal(matchOrigin('https://shop.example.com', ['*.example.com']), true);
  assert.equal(matchOrigin('https://evilexample.com', ['*.example.com']), false);
});

test('unparseable, empty and non-string origins are denied', () => {
  assert.equal(matchOrigin('null', ENTRIES), false);
  assert.equal(matchOrigin('', ENTRIES), false);
  assert.equal(matchOrigin(undefined, ENTRIES), false);
});
