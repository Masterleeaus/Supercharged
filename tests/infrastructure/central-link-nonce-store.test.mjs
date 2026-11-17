import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, verify} from 'node:crypto';
import {
  signLinkAssertionShared,
  createMemoryNonceStore,
  createDatabaseNonceStore,
  LINK_NONCE_TABLE,
  LinkAssertionError,
} from '../../server/infrastructure/central-link/link-assertion.ts';

const {privateKey, publicKey} = generateKeyPairSync('ed25519');
const config = {issuer: 'supercharged', audience: 'titan-central', kid: 'test-kid-1', privateKey};
const NOW_MS = Date.UTC(2026, 10, 15, 12, 0, 0);
const input = () => ({sub: 'usr_7f3k2m9a', org: 'org_4hq8c1zd', lu: 'supercharged-user-1842', la: 'supercharged-acct-2291'});

/** Fake shared table with the same semantics as the migration: primary key on nonce, expiry purge. */
function fakeSharedTable() {
  const rows = new Map();
  return {
    rows,
    async query(text, values = []) {
      if (text.startsWith('DELETE FROM')) {
        for (const [k, v] of rows) if (v <= values[0]) rows.delete(k);
        return {rowCount: 0};
      }
      if (text.startsWith('INSERT INTO')) {
        const [nonce, exp] = values;
        if (rows.has(nonce)) return {rowCount: 0};
        rows.set(nonce, exp);
        return {rowCount: 1};
      }
      throw new Error('unexpected query');
    },
  };
}

test('shared signing returns a token that verifies with the public key only', async () => {
  const store = createMemoryNonceStore();
  const {token} = await signLinkAssertionShared(config, input(), {store, nowMs: NOW_MS});
  const [h, p, s] = token.split('.');
  assert.equal(verify(null, Buffer.from(`${h}.${p}`, 'ascii'), publicKey, Buffer.from(s, 'base64url')), true);
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url').toString('utf8')), {alg: 'EdDSA', typ: 'titan-link+jwt', kid: 'test-kid-1'});
});

test('memory store refuses a second use of the same nonce', async () => {
  const store = createMemoryNonceStore();
  assert.equal(await store.reserve('n'.repeat(22), 2000, 1000), true);
  assert.equal(await store.reserve('n'.repeat(22), 2000, 1001), false);
});

test('memory store accepts a nonce again only after it has expired', async () => {
  const store = createMemoryNonceStore();
  assert.equal(await store.reserve('m'.repeat(22), 2000, 1000), true);
  assert.equal(await store.reserve('m'.repeat(22), 3000, 2000), true);
});

test('database store is single use across instances that share the table', async () => {
  const table = fakeSharedTable();
  const instanceA = createDatabaseNonceStore({db: table});
  const instanceB = createDatabaseNonceStore({db: table});
  assert.equal(await instanceA.reserve('a'.repeat(30), 5000, 1000), true);
  assert.equal(await instanceB.reserve('a'.repeat(30), 5000, 1001), false);
  assert.equal(table.rows.size, 1);
});

test('database store purges expired nonces on reserve', async () => {
  const table = fakeSharedTable();
  const store = createDatabaseNonceStore({db: table});
  await store.reserve('e'.repeat(30), 1100, 1000);
  await store.reserve('f'.repeat(30), 5000, 1200);
  assert.equal(table.rows.has('e'.repeat(30)), false);
  assert.equal(table.rows.has('f'.repeat(30)), true);
});

test('database store uses the migration table name and an insert that cannot overwrite', async () => {
  const seen = [];
  const store = createDatabaseNonceStore({
    db: {async query(text, values) { seen.push(text); return {rowCount: 1}; }},
  });
  await store.reserve('g'.repeat(30), 5000, 1000);
  assert.equal(LINK_NONCE_TABLE, 'central_link_issued_nonces');
  assert.match(seen[1], /INSERT INTO central_link_issued_nonces .* ON CONFLICT \(nonce\) DO NOTHING/);
});

test('a store that reports a nonce as already reserved makes signing fail with nonce_reused', async () => {
  await assert.rejects(
    () => signLinkAssertionShared(config, input(), {store: {reserve: async () => false}, nowMs: NOW_MS}),
    (err) => err instanceof LinkAssertionError && err.code === 'nonce_reused',
  );
});

test('forbidden claims are refused before any nonce is reserved', async () => {
  let reserved = 0;
  const store = {reserve: async () => { reserved++; return true; }};
  await assert.rejects(
    () => signLinkAssertionShared(config, {...input(), email: 'a@b.c'}, {store, nowMs: NOW_MS}),
    (err) => err instanceof LinkAssertionError && err.code === 'forbidden_claim',
  );
  assert.equal(reserved, 0);
});

test('lifetime above 300 seconds is refused before any nonce is reserved', async () => {
  let reserved = 0;
  const store = {reserve: async () => { reserved++; return true; }};
  await assert.rejects(
    () => signLinkAssertionShared(config, {...input(), ttlSeconds: 301}, {store, nowMs: NOW_MS}),
    (err) => err instanceof LinkAssertionError && err.code === 'invalid_lifetime',
  );
  assert.equal(reserved, 0);
});
