import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, generateKeyPairSync, randomBytes, sign as cryptoSign} from 'node:crypto';
import {createCentralOidcFlow, createMemoryPendingStore} from '../../server/infrastructure/central-sso/oidc-flow.ts';
import {createDatabasePendingStore, pendingStateHash} from '../../server/infrastructure/central-sso/pending-store-db.ts';

// Fixtures only. No real database, Logto, or Central endpoint is contacted.
// FakeDb models one shared table, the way two app processes share one Postgres table.
// Each store instance below is a separate "process" holding the same FakeDb.
class FakeDb {
 constructor() { this.rows = new Map(); this.now = 1_000_000; this.seen = []; }
 async query(text, values = []) {
  this.seen.push({text, values});
  if (text.startsWith('DELETE FROM central_sso_pending_logins WHERE expires_at <= now()')) {
   let n = 0;
   for (const [k, r] of this.rows) if (r.expiresAt <= this.now) { this.rows.delete(k); n++; }
   return {rows: [], rowCount: n};
  }
  if (text.includes('INSERT INTO central_sso_pending_logins')) {
   const [hash, verifier, nonce, ttl, cap] = values;
   if (this.rows.has(hash) || this.rows.size >= cap) return {rows: [], rowCount: 0};
   this.rows.set(hash, {codeVerifier: verifier, nonce, expiresAt: this.now + ttl});
   return {rows: [{state_hash: hash}], rowCount: 1};
  }
  if (text.startsWith('DELETE FROM central_sso_pending_logins WHERE state_hash')) {
   const hash = values[0];
   const r = this.rows.get(hash);
   if (!r) return {rows: [], rowCount: 0};
   this.rows.delete(hash);
   return {rows: [{code_verifier: r.codeVerifier, nonce: r.nonce, live: r.expiresAt > this.now}], rowCount: 1};
  }
  throw new Error(`unexpected SQL in fixture: ${text.slice(0, 60)}`);
 }
}

const REC = {codeVerifier: 'v'.repeat(43), nonce: 'n-1'};
const SEAL_KEY = randomBytes(32);
const OTHER_KEY = randomBytes(32);
const STATE = 'state-value-for-test-0000000000000000000000';

test('a stored pending login is returned once, then gone (single use)', async () => {
 const db = new FakeDb();
 const store = createDatabasePendingStore({db, sealKey: SEAL_KEY});
 assert.equal(await store.put(STATE, REC, 60_000), true);
 assert.deepEqual(await store.take(STATE), REC);
 assert.equal(await store.take(STATE), null);
});

test('a second process reading the same pending login consumes it, and the first process gets nothing', async () => {
 const db = new FakeDb();
 const processA = createDatabasePendingStore({db, sealKey: SEAL_KEY});
 const processB = createDatabasePendingStore({db, sealKey: SEAL_KEY});
 await processA.put(STATE, REC, 60_000);
 assert.deepEqual(await processB.take(STATE), REC);
 assert.equal(await processA.take(STATE), null);
});

test('an expired pending login is never returned and its row is removed', async () => {
 const db = new FakeDb();
 const store = createDatabasePendingStore({db, sealKey: SEAL_KEY});
 await store.put(STATE, REC, 1_000);
 db.now += 1_000; // exactly at expiry is dead
 assert.equal(await store.take(STATE), null);
 assert.equal(db.rows.size, 0);
});

test('put sweeps expired rows before storing new ones', async () => {
 const db = new FakeDb();
 const store = createDatabasePendingStore({db, sealKey: SEAL_KEY});
 await store.put('old-state-0000000000000000000000000000000000', REC, 500);
 db.now += 501;
 await store.put(STATE, REC, 60_000);
 assert.equal(db.rows.size, 1);
 assert.ok(db.rows.has(pendingStateHash(STATE)));
});

test('the raw state and the raw store key are never written to the database', async () => {
 const db = new FakeDb();
 const store = createDatabasePendingStore({db, sealKey: SEAL_KEY});
 await store.put(STATE, REC, 60_000);
 await store.take(STATE);
 const everything = JSON.stringify(db.seen);
 assert.equal(everything.includes(STATE), false);
 assert.equal(pendingStateHash(STATE), createHash('sha256').update(STATE).digest('hex'));
 assert.equal(/^[0-9a-f]{64}$/.test(pendingStateHash(STATE)), true);
});

test('the stored row does not contain the PKCE code_verifier, in any column or in any statement', async () => {
 const db = new FakeDb();
 const store = createDatabasePendingStore({db, sealKey: SEAL_KEY});
 await store.put(STATE, REC, 60_000);
 const row = [...db.rows.values()][0];
 assert.equal(JSON.stringify(row).includes(REC.codeVerifier), false);
 assert.equal(JSON.stringify(db.seen).includes(REC.codeVerifier), false);
 assert.match(row.codeVerifier, /^v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}$/);
 assert.deepEqual(await store.take(STATE), REC);
});

test('each seal uses a fresh IV, so the same verifier never produces the same stored value', async () => {
 const db = new FakeDb();
 const store = createDatabasePendingStore({db, sealKey: SEAL_KEY});
 await store.put('x1'.padEnd(43, 'x'), REC, 60_000);
 await store.put('x2'.padEnd(43, 'x'), REC, 60_000);
 const [a, b] = [...db.rows.values()].map((r) => r.codeVerifier);
 assert.notEqual(a, b);
 assert.notEqual(a.split(':')[1], b.split(':')[1]);
});

test('a sealed verifier cannot be opened with a different key, and the login is refused', async () => {
 const db = new FakeDb();
 await createDatabasePendingStore({db, sealKey: SEAL_KEY}).put(STATE, REC, 60_000);
 assert.equal(await createDatabasePendingStore({db, sealKey: OTHER_KEY}).take(STATE), null);
});

test('a sealed verifier moved to another state row fails to open (state hash is bound)', async () => {
 const db = new FakeDb();
 const store = createDatabasePendingStore({db, sealKey: SEAL_KEY});
 const other = 'other-state-0000000000000000000000000000000';
 await store.put(STATE, REC, 60_000);
 await store.put(other, {codeVerifier: 'w'.repeat(43), nonce: 'n-2'}, 60_000);
 db.rows.get(pendingStateHash(other)).codeVerifier = db.rows.get(pendingStateHash(STATE)).codeVerifier;
 assert.equal(await store.take(other), null);
});

test('the store refuses to build without a 32-byte seal key (no plaintext fallback)', () => {
 const db = new FakeDb();
 assert.throws(() => createDatabasePendingStore({db}), TypeError);
 assert.throws(() => createDatabasePendingStore({db, sealKey: randomBytes(16)}), TypeError);
 assert.throws(() => createDatabasePendingStore({db, sealKey: 'x'.repeat(32)}), TypeError);
});

test('a TTL above the 10 minute ceiling is clamped, and a non-positive TTL is raised to 1 ms', async () => {
 const db = new FakeDb();
 const store = createDatabasePendingStore({db, sealKey: SEAL_KEY});
 await store.put('a'.repeat(43), REC, 99_999_999);
 assert.equal(db.rows.get(pendingStateHash('a'.repeat(43))).expiresAt, db.now + 600_000);
 await store.put('b'.repeat(43), REC, 0);
 assert.equal(db.rows.get(pendingStateHash('b'.repeat(43))).expiresAt, db.now + 1);
});

test('the store refuses new logins at the cap instead of growing without bound', async () => {
 const db = new FakeDb();
 const store = createDatabasePendingStore({db, sealKey: SEAL_KEY, maxEntries: 2});
 assert.equal(await store.put('s1'.padEnd(43, 'x'), REC, 60_000), true);
 assert.equal(await store.put('s2'.padEnd(43, 'x'), REC, 60_000), true);
 assert.equal(await store.put('s3'.padEnd(43, 'x'), REC, 60_000), false);
});

test('memory store reports a full table as a refused put', async () => {
 const store = createMemoryPendingStore({maxEntries: 1});
 assert.equal(store.put('a', REC, 1000), true);
 assert.equal(store.put('b', REC, 1000), false);
});

// ---- end to end: start in one process, callback in another, same database ----

const ISSUER = 'https://central.example';
const COMPANY = '00000000-0000-4000-8000-000000000001';
const META = {issuer: ISSUER, authorizationEndpoint: 'https://central.example/authorize', tokenEndpoint: 'https://central.example/token', jwksUri: 'https://central.example/jwks'};
const config = {
 enabled: true, issuer: ISSUER, clientId: 'desk-client-test', clientSecret: 'test-only-client-secret',
 redirectUri: 'https://desk.example/auth/central/callback', audience: 'desk-audience-test', companyClaim: 'company_id',
};
const rsa = generateKeyPairSync('rsa', {modulusLength: 2048});
const rsaJwk = {...rsa.publicKey.export({format: 'jwk'}), kid: 'rsa-1', alg: 'RS256', use: 'sig'};
const b64u = (x) => Buffer.from(x).toString('base64url');
function makeIdToken(nonce) {
 const now = Math.floor(Date.now() / 1000);
 const h = b64u(JSON.stringify({alg: 'RS256', kid: 'rsa-1', typ: 'JWT'}));
 const p = b64u(JSON.stringify({iss: ISSUER, aud: config.audience, sub: 'central-user-1', iat: now, exp: now + 300, nonce, company_id: COMPANY}));
 const sig = cryptoSign('sha256', Buffer.from(`${h}.${p}`), rsa.privateKey);
 return `${h}.${p}.${sig.toString('base64url')}`;
}
function makeProcess(db, tokenState) {
 const fetchImpl = async (url) => {
  if (url !== META.tokenEndpoint) throw new Error(`unexpected fetch ${url}`);
  return new Response(JSON.stringify({id_token: tokenState.idToken, access_token: 'x'}), {status: 200, headers: {'content-type': 'application/json'}});
 };
 return createCentralOidcFlow({
  config,
  discovery: async () => META,
  jwksKeys: async (kid) => (kid === 'rsa-1' ? rsaJwk : null),
  pending: createDatabasePendingStore({db, sealKey: SEAL_KEY}),
  fetchImpl,
 });
}

test('a login started in one process completes in another process that shares the database', async () => {
 const db = new FakeDb();
 const tokenState = {idToken: null};
 const started = makeProcess(db, tokenState);
 const callback = makeProcess(db, tokenState);
 const s = await started.start();
 assert.equal(s.ok, true);
 tokenState.idToken = makeIdToken(new URL(s.redirectUrl).searchParams.get('nonce'));
 const done = await callback.complete({query: {code: 'auth-code-1', state: s.state}, cookieState: s.state});
 assert.equal(done.ok, true);
 assert.equal(done.selection.companyId, COMPANY);
 const replay = await callback.complete({query: {code: 'auth-code-1', state: s.state}, cookieState: s.state});
 assert.deepEqual(replay, {ok: false, reason: 'unknown_state'});
});

test('a callback after the 10 minute window is refused as unknown_state', async () => {
 const db = new FakeDb();
 const tokenState = {idToken: null};
 const started = makeProcess(db, tokenState);
 const callback = makeProcess(db, tokenState);
 const s = await started.start();
 tokenState.idToken = makeIdToken(new URL(s.redirectUrl).searchParams.get('nonce'));
 db.now += 10 * 60 * 1000;
 const late = await callback.complete({query: {code: 'auth-code-1', state: s.state}, cookieState: s.state});
 assert.deepEqual(late, {ok: false, reason: 'unknown_state'});
});

test('start fails closed with session_unavailable when the pending store is full', async () => {
 const db = new FakeDb();
 const flow = createCentralOidcFlow({
  config,
  discovery: async () => META,
  jwksKeys: async () => null,
  pending: createDatabasePendingStore({db, sealKey: SEAL_KEY, maxEntries: 0}),
  fetchImpl: async () => { throw new Error('no network in test'); },
 });
 assert.deepEqual(await flow.start(), {ok: false, reason: 'session_unavailable'});
});
