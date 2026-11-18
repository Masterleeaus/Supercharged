import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const manifestMod = await import('../../server/plugins/manifest.ts');
const discovery = await import('../../server/plugins/connector-discovery.ts');
const registryMod = await import('../../server/connectors/registry.ts');
const { createFakeProvider } = await import('./fixtures/fake-provider.ts');

const repo = fileURLToPath(new URL('../../', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/manifests', import.meta.url));
const readFixture = () => JSON.parse(fs.readFileSync(path.join(FIXTURE_ROOT, 'fake-crm', 'connector.json'), 'utf8'));
const CO1 = '11111111-1111-4111-8111-111111111111';
const CO2 = '22222222-2222-4222-8222-222222222222';

test('a valid connector manifest is accepted and normalised', () => {
  const r = manifestMod.validateConnectorManifest(readFixture());
  assert.equal(r.ok, true);
  assert.equal(r.manifest.id, 'fake-crm');
  assert.equal(r.manifest.configSchema.region.required, true);
});

test('invalid connector manifests fail closed with paths for every problem', () => {
  const cases = [
    [{ ...readFixture(), extra: 1 }, 'extra'],
    [{ ...readFixture(), id: 'Bad Id' }, 'id'],
    [{ ...readFixture(), version: 'one' }, 'version'],
    [{ ...readFixture(), auth: 'basic' }, 'auth'],
    [{ ...readFixture(), entities: ['contact', 'spaceship'] }, 'entities.1'],
    [{ ...readFixture(), featureFlag: 'Has-Dash' }, 'featureFlag'],
    [{ ...readFixture(), configSchema: { x: { type: 'date' } } }, 'configSchema.x.type'],
    [{ ...readFixture(), requiredScopes: 'contacts.read' }, 'requiredScopes'],
    ['not an object', '(root)'],
  ];
  for (const [raw, path] of cases) {
    const r = manifestMod.validateConnectorManifest(raw);
    assert.equal(r.ok, false, `expected rejection for ${path}`);
    assert.ok(r.errors.some((e) => e.path.startsWith(path)), `missing error at ${path}`);
  }
});

test('discovery returns valid connectors and reports each bad one without dropping the rest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connectors-'));
  try {
    fs.cpSync(path.join(FIXTURE_ROOT, 'fake-crm'), path.join(root, 'fake-crm'), { recursive: true });
    fs.mkdirSync(path.join(root, 'broken'));
    fs.writeFileSync(path.join(root, 'broken', 'connector.json'), '{ not json');
    fs.mkdirSync(path.join(root, 'mismatch'));
    fs.writeFileSync(path.join(root, 'mismatch', 'connector.json'), JSON.stringify({ ...readFixture(), id: 'other-crm' }));
    fs.mkdirSync(path.join(root, 'no-manifest'));
    const out = discovery.discoverConnectorManifests(root);
    assert.deepEqual(out.manifests.map((m) => m.id), ['fake-crm']);
    assert.deepEqual(out.rejected.map((r) => r.directory).sort(), ['broken', 'mismatch']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('every connector manifest in the repository validates', () => {
  const out = discovery.discoverConnectorManifests(path.join(repo, 'plugins'));
  assert.deepEqual(out.rejected, []);
});

test('a connector registers only with a consistent implementation and its feature flag on', async () => {
  const discovered = { manifests: [readFixture()], rejected: [] };
  const off = registryMod.createConnectorRegistry({
    discovery: discovered, implementations: new Map([['fake-crm', createFakeProvider()]]),
    isFlagOn: () => false, settings: registryMod.createMemorySettingsStore(),
  });
  assert.equal(off.registered().length, 0);
  assert.equal(off.skipped()[0].reason, 'feature flag off');

  const on = registryMod.createConnectorRegistry({
    discovery: discovered, implementations: new Map([['fake-crm', createFakeProvider()]]),
    isFlagOn: (f) => f === 'connector_fake_crm', settings: registryMod.createMemorySettingsStore(),
  });
  assert.equal(on.registered().length, 1);

  const noImpl = registryMod.createConnectorRegistry({ discovery: discovered, implementations: new Map(), isFlagOn: () => true, settings: registryMod.createMemorySettingsStore() });
  assert.equal(noImpl.skipped()[0].reason, 'no implementation');

  const wrongAuth = createFakeProvider();
  wrongAuth.auth = 'oauth2';
  const mismatch = registryMod.createConnectorRegistry({ discovery: discovered, implementations: new Map([['fake-crm', wrongAuth]]), isFlagOn: () => true, settings: registryMod.createMemorySettingsStore() });
  assert.equal(mismatch.registered().length, 0);
  assert.match(mismatch.skipped()[0].reason, /auth does not match/);
});

test('connectors are disabled per company by default, and enable and disable need no code change', async () => {
  const registry = registryMod.createConnectorRegistry({
    discovery: { manifests: [readFixture()], rejected: [] },
    implementations: new Map([['fake-crm', createFakeProvider()]]),
    isFlagOn: () => true, settings: registryMod.createMemorySettingsStore(),
  });
  await assert.rejects(registry.forCompany(CO1, 'fake-crm'), (e) => e.code === 'forbidden');
  await assert.rejects(registry.enable(CO1, 'fake-crm', {}), (e) => e.code === 'validation');
  await registry.enable(CO1, 'fake-crm', { region: 'au-east', pageSize: 50 });
  assert.equal((await registry.forCompany(CO1, 'fake-crm')).manifest.id, 'fake-crm');
  await assert.rejects(registry.forCompany(CO2, 'fake-crm'), (e) => e.code === 'forbidden', 'enable must not leak to another company');
  await registry.disable(CO1, 'fake-crm');
  await assert.rejects(registry.forCompany(CO1, 'fake-crm'), (e) => e.code === 'forbidden');
  await assert.rejects(registry.enable(CO1, 'fake-crm', { region: 'x', surprise: true }), (e) => e.code === 'validation');
});

test('loader exposes connector discovery over the plugins root without importing the database', () => {
  const src = fs.readFileSync(path.join(repo, 'server/plugins/loader.ts'), 'utf8');
  assert.match(src, /export function discoverConnectors\(\): ConnectorDiscovery/);
  assert.match(src, /discoverConnectorManifests\(pluginsDir\)/);
});

test('the connector manifest validator copies the SDK auth and entity lists exactly', async () => {
  const contract = await import('../../server/connectors/sdk/contract.ts');
  const src = fs.readFileSync(path.join(repo, 'server/plugins/manifest.ts'), 'utf8');
  assert.match(src, new RegExp(`AUTH_TYPES = \\[${contract.AUTH_TYPES.map((v) => `'${v}'`).join(', ')}\\]`));
  assert.match(src, new RegExp(`ENTITY_TYPES = \\[${contract.ENTITY_TYPES.map((v) => `'${v}'`).join(', ')}\\]`));
});

test('startup: every repository manifest validates, has an implementation, and registers only with its flag', async () => {
  const boot = await import('../../server/connectors/bootstrap.ts');
  const settings = registryMod.createMemorySettingsStore();
  const implementations = boot.createConnectorImplementations({
    http: {}, fetch: async () => new Response('{}'), jobberApiVersion: '2025-01-01',
  });
  const discovered = boot.discoverAllConnectorManifests(repo);
  assert.deepEqual(discovered.rejected, []);
  assert.ok(discovered.manifests.length >= 6, 'expected the shipped connector manifests to be discovered');

  const flagsOff = boot.buildConnectorRegistry({ repoRoot: repo, implementations, isFlagOn: () => false, settings });
  assert.equal(flagsOff.registered().length, 0, 'no connector registers while its flag is off');
  assert.equal(flagsOff.skipped().length, discovered.manifests.length);
  assert.ok(flagsOff.skipped().every((s) => s.reason === 'feature flag off'), JSON.stringify(flagsOff.skipped()));

  const flagsOn = boot.buildConnectorRegistry({ repoRoot: repo, implementations, isFlagOn: () => true, settings });
  assert.deepEqual(flagsOn.skipped(), []);
  assert.deepEqual(flagsOn.registered().map((r) => r.manifest.id).sort(), discovered.manifests.map((m) => m.id).sort());
});

test('a duplicate connector id across manifest roots is rejected and the first copy is kept', async () => {
  const boot = await import('../../server/connectors/bootstrap.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-roots-'));
  try {
    for (const dir of ['a', 'b']) {
      fs.mkdirSync(path.join(root, dir, 'fake-crm'), { recursive: true });
      fs.writeFileSync(path.join(root, dir, 'fake-crm', 'connector.json'), JSON.stringify(readFixture()));
    }
    const out = boot.discoverAllConnectorManifests(root, ['a', 'b']);
    assert.deepEqual(out.manifests.map((m) => m.id), ['fake-crm']);
    assert.equal(out.rejected.length, 1);
    assert.match(out.rejected[0].errors[0].message, /duplicate connector id/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
