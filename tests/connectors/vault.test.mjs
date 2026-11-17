import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';

const { createSecretBox, SECRET_KEY_ENV, SECRET_KEYRING_ENV, SECRET_KEY_VERSION_ENV } = await import('../../server/modules/chatbot/secrets/secret-box.ts');
const vaultMod = await import('../../server/connectors/vault/credential-vault.ts');
const flowMod = await import('../../server/connectors/vault/oauth-flow.ts');

const CO1 = '11111111-1111-4111-8111-111111111111';
const CO2 = '22222222-2222-4222-8222-222222222222';
const K1 = randomBytes(32).toString('base64');
const K2 = randomBytes(32).toString('base64');
const box1 = () => createSecretBox({ env: { [SECRET_KEY_ENV]: K1 } });
const ring = (current) => ({ [SECRET_KEY_ENV]: K1, [SECRET_KEYRING_ENV]: JSON.stringify({ v2: K2 }), [SECRET_KEY_VERSION_ENV]: current });

test('credentials round trip, are scoped to one company and one connector, and never sit in plain storage', async () => {
  const store = vaultMod.createMemoryCredentialStore();
  const vault = new vaultMod.CredentialVault(box1(), store);
  await vault.save(CO1, 'fake-crm', { type: 'api_key', apiKey: 'SECRET-VALUE-123' });
  const row = await store.get(CO1, 'fake-crm');
  assert.equal(row.sealed.includes('SECRET-VALUE-123'), false);
  assert.deepEqual(await vault.load(CO1, 'fake-crm'), { type: 'api_key', apiKey: 'SECRET-VALUE-123' });
  assert.equal(await vault.load(CO2, 'fake-crm'), null);

  // Move a row to another company, and to another connector: it must not open.
  await store.put({ ...row, companyId: CO2 });
  await assert.rejects(vault.load(CO2, 'fake-crm'), (e) => e.code === 'auth' && !String(e.message).includes('SECRET'));
  await store.put({ ...row, connectorId: 'other' });
  await assert.rejects(vault.load(CO1, 'other'), (e) => e.code === 'auth');
});

test('invalid credential shapes are refused before anything is stored', async () => {
  const store = vaultMod.createMemoryCredentialStore();
  const vault = new vaultMod.CredentialVault(box1(), store);
  await assert.rejects(vault.save(CO1, 'fake-crm', { type: 'api_key', apiKey: '' }), (e) => e.code === 'validation');
  await assert.rejects(vault.save(CO1, 'fake-crm', { type: 'basic', user: 'x' }), (e) => e.code === 'validation');
  assert.equal(await store.get(CO1, 'fake-crm'), null);
});

test('rotation: old rows still open after a key-version change, and re-saving moves them to the new version', async () => {
  const store = vaultMod.createMemoryCredentialStore();
  const before = new vaultMod.CredentialVault(box1(), store);
  await before.save(CO1, 'fake-crm', { type: 'api_key', apiKey: 'old-key' });
  assert.equal((await store.get(CO1, 'fake-crm')).keyVersion, 'v1');

  const rotated = new vaultMod.CredentialVault(createSecretBox({ env: ring('v2') }), store);
  assert.equal(rotated.currentKeyVersion(), 'v2');
  assert.deepEqual(await rotated.load(CO1, 'fake-crm'), { type: 'api_key', apiKey: 'old-key' }, 'old credential must still decrypt');
  assert.equal(await rotated.needsRotation(CO1, 'fake-crm'), true);

  assert.equal(await rotated.rotate(CO1, 'fake-crm'), true);
  assert.equal((await store.get(CO1, 'fake-crm')).keyVersion, 'v2');
  assert.equal(await rotated.needsRotation(CO1, 'fake-crm'), false);
  assert.deepEqual(await rotated.load(CO1, 'fake-crm'), { type: 'api_key', apiKey: 'old-key' });
});

test('a key version missing from the keyring fails closed with a generic error', async () => {
  const store = vaultMod.createMemoryCredentialStore();
  await new vaultMod.CredentialVault(box1(), store).save(CO1, 'fake-crm', { type: 'api_key', apiKey: 'k' });
  const onlyV2 = createSecretBox({ env: { [SECRET_KEY_ENV]: K2, [SECRET_KEY_VERSION_ENV]: 'v1' } });
  const vault = new vaultMod.CredentialVault(onlyV2, store);
  await assert.rejects(vault.load(CO1, 'fake-crm'), (e) => e.code === 'auth' && !String(e.message).includes(K1));
});

// ---- OAuth connect flow, with a scripted provider and poster (no network) ----

function scriptedPoster(responses) {
  const calls = [];
  return {
    calls,
    async postForm(url, form) {
      calls.push({ url, form });
      const next = responses.shift();
      if (!next) throw new Error('no scripted response');
      return next;
    },
  };
}
const PROVIDER = {
  connectorId: 'fake-oauth',
  authorizeUrl: 'https://auth.example.test/authorize',
  tokenUrl: 'https://auth.example.test/token',
  revokeUrl: 'https://auth.example.test/revoke',
  clientId: 'client-public-id',
  clientSecret: 'CLIENT-SECRET-VALUE',
  redirectUri: 'https://app.example.test/connectors/callback',
  scopes: ['contacts.read', 'bookings.write'],
};
function setup(responses, now = () => 1_000_000) {
  const store = vaultMod.createMemoryCredentialStore();
  const vault = new vaultMod.CredentialVault(box1(), store, now);
  const poster = scriptedPoster(responses);
  const flow = flowMod.createOAuthFlow({
    providers: new Map([[PROVIDER.connectorId, PROVIDER]]),
    vault, pending: flowMod.createMemoryPendingStore(), poster, now,
  });
  return { store, vault, poster, flow };
}

test('connect: the authorize URL has PKCE and state but no secret or token, and the callback stores tokens for the pending company only', async () => {
  const { vault, poster, flow } = setup([{ status: 200, body: { access_token: 'AT-1', refresh_token: 'RT-1', expires_in: 3600, token_type: 'Bearer' } }]);
  const { url } = await flow.beginConnect(CO1, 'fake-oauth');
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(parsed.searchParams.get('state').length >= 40);
  assert.equal(url.includes('CLIENT-SECRET-VALUE'), false);
  assert.equal(url.includes('AT-1'), false);

  const state = parsed.searchParams.get('state');
  const result = await flow.completeConnect(state, 'auth-code-abc');
  assert.deepEqual([result.companyId, result.connectorId], [CO1, 'fake-oauth']);
  assert.equal(JSON.stringify(result).includes('AT-1'), false, 'tokens must not be returned to the caller');
  assert.equal((await vault.load(CO1, 'fake-oauth')).accessToken, 'AT-1');
  assert.equal(poster.calls[0].form.grant_type, 'authorization_code');
  assert.ok(poster.calls[0].form.code_verifier.length >= 40);
  const challenge = createHash('sha256').update(poster.calls[0].form.code_verifier).digest('base64url');
  assert.equal(parsed.searchParams.get('code_challenge'), challenge);
});

test('callback: unknown, reused or expired state is refused, and bad codes are refused before any call', async () => {
  let clock = 1_000_000;
  const { poster, flow } = setup([{ status: 200, body: { access_token: 'AT' } }, { status: 200, body: { access_token: 'AT' } }], () => clock);
  await assert.rejects(flow.completeConnect('never-issued', 'code'), (e) => e.code === 'auth');
  const s1 = new URL((await flow.beginConnect(CO1, 'fake-oauth')).url).searchParams.get('state');
  await flow.completeConnect(s1, 'code-1');
  await assert.rejects(flow.completeConnect(s1, 'code-1'), (e) => e.code === 'auth', 'state is single use');
  const s2 = new URL((await flow.beginConnect(CO1, 'fake-oauth')).url).searchParams.get('state');
  clock += 11 * 60 * 1000;
  await assert.rejects(flow.completeConnect(s2, 'code-2'), (e) => e.code === 'auth', 'state expires after 10 minutes');
  const before = poster.calls.length;
  await assert.rejects(flow.completeConnect('x', 'bad code with spaces'), (e) => e.code === 'validation');
  assert.equal(poster.calls.length, before);
});

test('refresh: an expiring token is refreshed automatically, the new one is saved, and concurrent callers share one refresh', async () => {
  let clock = 1_000_000;
  const { vault, poster, flow } = setup([
    { status: 200, body: { access_token: 'AT-NEW', expires_in: 3600 } },
  ], () => clock);
  await vault.save(CO1, 'fake-oauth', { type: 'oauth2', accessToken: 'AT-OLD', refreshToken: 'RT-1', expiresAt: clock + 30_000 });
  const [a, b] = await Promise.all([flow.credentialsFor(CO1, 'fake-oauth'), flow.credentialsFor(CO1, 'fake-oauth')]);
  assert.equal(a.accessToken, 'AT-NEW');
  assert.equal(b.accessToken, 'AT-NEW');
  assert.equal(poster.calls.length, 1);
  assert.equal(poster.calls[0].form.grant_type, 'refresh_token');
  assert.equal((await vault.load(CO1, 'fake-oauth')).refreshToken, 'RT-1', 'refresh token is kept when the provider does not rotate it');
});

test('refresh: a refused refresh token removes the stored credential and asks for a reconnect', async () => {
  const { vault, flow } = setup([{ status: 400, body: { error: 'invalid_grant', refresh_token: 'RT-LEAK?' } }]);
  await vault.save(CO1, 'fake-oauth', { type: 'oauth2', accessToken: 'AT', refreshToken: 'RT', expiresAt: 0 });
  await assert.rejects(flow.credentialsFor(CO1, 'fake-oauth'), (e) => e.code === 'auth' && e.message === 'reconnect required');
  assert.equal(await vault.load(CO1, 'fake-oauth'), null);
});

test('revoke: calls the provider, always removes the local copy, and reports whether the provider confirmed', async () => {
  const { vault, poster, flow } = setup([{ status: 200, body: {} }, { status: 500, body: {} }]);
  await vault.save(CO1, 'fake-oauth', { type: 'oauth2', accessToken: 'AT' });
  assert.deepEqual(await flow.revoke(CO1, 'fake-oauth'), { removed: true, remoteRevoked: true });
  assert.equal(poster.calls[0].form.token, 'AT');
  assert.equal(poster.calls[0].url, PROVIDER.revokeUrl);
  await vault.save(CO1, 'fake-oauth', { type: 'oauth2', accessToken: 'AT2' });
  assert.deepEqual(await flow.revoke(CO1, 'fake-oauth'), { removed: true, remoteRevoked: false });
  assert.equal(await vault.load(CO1, 'fake-oauth'), null);
});

test('credentials are not in any URL the flow builds, and the flow module never logs', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../server/connectors/vault/oauth-flow.ts', import.meta.url), 'utf8') + fs.readFileSync(new URL('../../server/connectors/vault/credential-vault.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /console\.|logger\./);
  assert.doesNotMatch(src, /url\.searchParams\.set\(['"](access_token|refresh_token|client_secret)/);
});
