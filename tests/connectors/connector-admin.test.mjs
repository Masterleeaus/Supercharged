import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const manifestMod = await import('../../server/plugins/manifest.ts');
const registryMod = await import('../../server/connectors/registry.ts');
const contract = await import('../../server/connectors/sdk/contract.ts');
const vaultMod = await import('../../server/connectors/vault/credential-vault.ts');
const { createSecretBox, SECRET_KEY_ENV } = await import('../../server/modules/chatbot/secrets/secret-box.ts');
const { FAILURE_GUIDE, GUIDED_ERROR_CODES, guideFor } = await import('../../server/connectors/admin/failure-guide.ts');
const { buildConnectorHealth, buildCompanyHealth, EXPIRY_WARNING_MS } = await import('../../server/connectors/admin/health.ts');
const { createMemoryStateStore } = await import('../../server/connectors/admin/state.ts');
const { createConnectorAdmin } = await import('../../server/connectors/admin/actions.ts');

const FIXTURE = fileURLToPath(new URL('./fixtures/manifests/fake-crm/connector.json', import.meta.url));
const CO1 = '11111111-1111-4111-8111-111111111111';
const CO2 = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-18T12:00:00Z';
const API_KEY = 'ADMIN-TEST-KEY-VALUE';

const ERROR_CODE_LIST = contract.ERROR_CODES;

function fakeDefinition() {
  let fail = null;
  return {
    def: {
      id: 'fake-crm',
      auth: 'api_key',
      capabilities: ['read'],
      entities: ['contact'],
      actions: { ping: { kind: 'read', entity: 'contact' } },
      async execute(req, creds) {
        if (fail) {
          const f = fail;
          fail = null;
          throw contract.errorFromStatus(f);
        }
        if (creds.type !== 'api_key' || creds.apiKey !== API_KEY) throw new contract.ConnectorError('auth', 'refused');
        return { ok: true };
      },
    },
    failNext(status) {
      fail = status;
    },
  };
}

function setup() {
  const manifest = manifestMod.validateConnectorManifest(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')));
  assert.equal(manifest.ok, true);
  const fake = fakeDefinition();
  const registry = registryMod.createConnectorRegistry({
    discovery: { manifests: [manifest.manifest], rejected: [] },
    implementations: new Map([['fake-crm', fake.def]]),
    isFlagOn: () => true,
    settings: registryMod.createMemorySettingsStore(),
  });
  const key = randomBytes(32).toString('base64');
  const vault = new vaultMod.CredentialVault(createSecretBox({ env: { [SECRET_KEY_ENV]: key } }), vaultMod.createMemoryCredentialStore());
  const state = createMemoryStateStore();
  const auditRows = [];
  const admin = createConnectorAdmin({
    registry,
    vault,
    state,
    audit: async (r) => { auditRows.push(r); },
    credentialsFor: (c, id) => vault.load(c, id).then((s) => ({ type: 'api_key', apiKey: s.apiKey })),
    now: () => new Date(NOW),
  });
  return { admin, fake, vault, state, registry, auditRows };
}

test('every SDK error code and every sync reason has a plain-language message and a fix', () => {
  const syncReasons = ['validation', 'conflict_manual', 'auth', 'rate_limited', 'upstream', 'unknown'];
  for (const code of [...ERROR_CODE_LIST, ...syncReasons]) {
    const g = FAILURE_GUIDE[code];
    assert.ok(g, `missing guide for ${code}`);
    assert.ok(g.message.length > 10 && g.fix.length > 10, `guide for ${code} is too thin`);
  }
  assert.ok(GUIDED_ERROR_CODES.length === ERROR_CODE_LIST.length);
  assert.equal(guideFor('no-such-code'), FAILURE_GUIDE.unknown);
});

test('guides never leak vendor detail or credentials', () => {
  for (const g of Object.values(FAILURE_GUIDE)) {
    assert.doesNotMatch(`${g.message} ${g.fix}`, /token|secret|password|api key value|\{|\}/i);
  }
});

test('health: a connected, synced connector with no problems is healthy', () => {
  const h = buildConnectorHealth({
    connectorId: 'a', displayName: 'A', connected: true, enabled: true, paused: false,
    lastSuccessAt: '2026-11-18T11:00:00Z', errorCount: 0, lastErrorCode: null, deadLetterCount: 0, tokenExpiresAt: null,
  }, NOW);
  assert.equal(h.state, 'healthy');
  assert.deepEqual(h.problems, []);
});

test('health: dead letters, expiring tokens, expired tokens, pause and never-synced each show a problem with a fix', () => {
  const base = { connectorId: 'a', displayName: 'A', connected: true, enabled: true, paused: false, lastSuccessAt: '2026-11-18T11:00:00Z', errorCount: 0, lastErrorCode: null, deadLetterCount: 0, tokenExpiresAt: null };
  const dl = buildConnectorHealth({ ...base, deadLetterCount: 2 }, NOW);
  assert.equal(dl.state, 'attention');
  assert.equal(dl.problems[0].code, 'dead_letters');

  const soon = new Date(Date.parse(NOW) + EXPIRY_WARNING_MS / 2).toISOString();
  assert.equal(buildConnectorHealth({ ...base, tokenExpiresAt: soon }, NOW).problems[0].code, 'token_expiring');

  const past = '2026-11-18T10:00:00Z';
  const expired = buildConnectorHealth({ ...base, tokenExpiresAt: past }, NOW);
  assert.equal(expired.state, 'failing');
  assert.equal(expired.problems[0].code, 'token_expired');

  assert.equal(buildConnectorHealth({ ...base, paused: true }, NOW).state, 'paused');
  assert.equal(buildConnectorHealth({ ...base, lastSuccessAt: null }, NOW).problems[0].code, 'never_synced');
  assert.equal(buildConnectorHealth({ ...base, connected: false }, NOW).state, 'not_connected');
});

test('health: a last error makes the connector failing and names the code', () => {
  const h = buildConnectorHealth({
    connectorId: 'a', displayName: 'A', connected: true, enabled: true, paused: false,
    lastSuccessAt: null, errorCount: 3, lastErrorCode: 'auth', deadLetterCount: 0, tokenExpiresAt: null,
  }, NOW);
  assert.equal(h.state, 'failing');
  assert.equal(h.problems.find((p) => p.code === 'auth').fix, FAILURE_GUIDE.auth.fix);
});

test('company health lists the worst connectors first', () => {
  const rows = buildCompanyHealth([
    { connectorId: 'ok', displayName: 'Ok', connected: true, enabled: true, paused: false, lastSuccessAt: NOW, errorCount: 0, lastErrorCode: null, deadLetterCount: 0, tokenExpiresAt: null },
    { connectorId: 'bad', displayName: 'Bad', connected: true, enabled: true, paused: false, lastSuccessAt: NOW, errorCount: 1, lastErrorCode: 'upstream', deadLetterCount: 0, tokenExpiresAt: null },
    { connectorId: 'off', displayName: 'Off', connected: false, enabled: false, paused: false, lastSuccessAt: null, errorCount: 0, lastErrorCode: null, deadLetterCount: 0, tokenExpiresAt: null },
  ], NOW);
  assert.deepEqual(rows.map((r) => r.connectorId), ['bad', 'off', 'ok']);
});

test('connect with an API key stores it sealed and enables the connector; test then records success', async () => {
  const { admin, state, vault, registry } = setup();
  await admin.connectApiKey(CO1, 'fake-crm', API_KEY, { region: 'au' });
  assert.equal((await vault.load(CO1, 'fake-crm')).apiKey, API_KEY);
  assert.ok((await registry.forCompany(CO1, 'fake-crm')).definition);
  const result = await admin.test(CO1, 'fake-crm');
  assert.equal(result.ok, true);
  assert.equal((await state.get(CO1, 'fake-crm')).lastSuccessAt, new Date(NOW).toISOString());
});

test('a failing test returns a guided message and counts the error; a later success clears the code', async () => {
  const { admin, fake, state } = setup();
  await admin.connectApiKey(CO1, 'fake-crm', API_KEY, { region: 'au' });
  fake.failNext(401);
  const bad = await admin.test(CO1, 'fake-crm');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'auth');
  assert.equal(bad.guide.fix, FAILURE_GUIDE.auth.fix);
  assert.equal((await state.get(CO1, 'fake-crm')).errorCount, 1);
  const good = await admin.test(CO1, 'fake-crm');
  assert.equal(good.ok, true);
  assert.equal((await state.get(CO1, 'fake-crm')).lastErrorCode, null);
});

test('pause blocks test without touching credentials; resume restores it', async () => {
  const { admin, vault } = setup();
  await admin.connectApiKey(CO1, 'fake-crm', API_KEY, { region: 'au' });
  await admin.pause(CO1, 'fake-crm');
  await assert.rejects(admin.test(CO1, 'fake-crm'), (e) => e.code === 'forbidden');
  assert.ok(await vault.load(CO1, 'fake-crm'), 'credentials are kept while paused');
  await admin.resume(CO1, 'fake-crm');
  assert.equal((await admin.test(CO1, 'fake-crm')).ok, true);
});

test('disconnect removes credentials, disables the connector and clears its state', async () => {
  const { admin, vault, state, registry } = setup();
  await admin.connectApiKey(CO1, 'fake-crm', API_KEY, { region: 'au' });
  await admin.test(CO1, 'fake-crm');
  await admin.disconnect(CO1, 'fake-crm');
  assert.equal(await vault.load(CO1, 'fake-crm'), null);
  await assert.rejects(registry.forCompany(CO1, 'fake-crm'), (e) => e.code === 'forbidden');
  assert.equal((await state.get(CO1, 'fake-crm')).lastSuccessAt, null);
});

test('connections are scoped per company: company two cannot test company one connection', async () => {
  const { admin } = setup();
  await admin.connectApiKey(CO1, 'fake-crm', API_KEY, { region: 'au' });
  await assert.rejects(admin.test(CO2, 'fake-crm'), (e) => e.code === 'forbidden');
});

test('audit records are written for test calls and never contain the API key', async () => {
  const { admin, auditRows } = setup();
  await admin.connectApiKey(CO1, 'fake-crm', API_KEY, { region: 'au' });
  await admin.test(CO1, 'fake-crm');
  assert.equal(auditRows.length, 1);
  assert.equal(JSON.stringify(auditRows).includes(API_KEY), false);
});
