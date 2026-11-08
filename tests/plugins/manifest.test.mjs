import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { validatePluginManifest } = await import('../../server/plugins/manifest.ts');
const { MODE_MODULES, exclusiveModules } = await import('../../server/modules/desk-modes/mode-modules.ts');

const repo = fileURLToPath(new URL('../../', import.meta.url));
const readJson = (rel) => JSON.parse(readFileSync(`${repo}${rel}`, 'utf8'));

const base = () => ({
  name: 'test-plugin',
  displayName: 'Test Plugin',
  version: '0.1.0',
  description: 'A fixture plugin used only by the manifest validator tests.',
  author: 'Test',
  entryPoint: 'index.mjs',
  registerFunction: 'registerPlugin',
  mode: 'comms',
  modules: ['chatbot'],
});

const errorPaths = (result) => (result.ok ? [] : result.errors.map((e) => e.path));
const errorText = (result) => (result.ok ? '' : result.errors.map((e) => `${e.path}: ${e.message}`).join(' | '));

test('accepts a well-formed comms plugin and returns a normalised copy', () => {
  const result = validatePluginManifest(base());
  assert.equal(result.ok, true, errorText(result));
  assert.equal(result.manifest.mode, 'comms');
  assert.deepEqual(result.manifest.modules, ['chatbot']);
});

test('rejects a comms plugin that names a workforce-only module', () => {
  for (const mod of exclusiveModules('workforce')) {
    const raw = { ...base(), modules: [mod] };
    const result = validatePluginManifest(raw);
    assert.equal(result.ok, false, `${mod} should be rejected for comms`);
    assert.ok(errorPaths(result).includes('modules.0'), errorText(result));
    assert.match(errorText(result), new RegExp(`"${mod}" belongs only to the workforce mode`));
  }
});

test('rejects a workforce plugin that names a comms-only module', () => {
  const raw = { ...base(), mode: 'workforce', modules: ['workforce-runtime', 'chatbot'] };
  const result = validatePluginManifest(raw);
  assert.equal(result.ok, false);
  assert.deepEqual(errorPaths(result), ['modules.1']);
  assert.match(errorText(result), /"chatbot" belongs only to the comms mode/);
});

test('rejects a module that no Desk mode mounts', () => {
  const result = validatePluginManifest({ ...base(), modules: ['no-such-module'] });
  assert.equal(result.ok, false);
  assert.match(errorText(result), /"no-such-module" is not mounted by any Desk mode/);
});

test('accepts a shared module (approvals) in either mode', () => {
  for (const mode of ['workforce', 'comms']) {
    const result = validatePluginManifest({ ...base(), mode, modules: ['approvals'] });
    assert.equal(result.ok, true, `${mode}: ${errorText(result)}`);
  }
});

test('reports every module problem in one pass, with its index', () => {
  const result = validatePluginManifest({
    ...base(),
    modules: ['chatbot', 'booking-agent', 'chatbot', 'ghost'],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(errorPaths(result), ['modules.1', 'modules.2', 'modules.3']);
});

test('rejects an unknown mode, and an empty or missing module list', () => {
  assert.ok(errorPaths(validatePluginManifest({ ...base(), mode: 'both' })).includes('mode'));
  assert.ok(errorPaths(validatePluginManifest({ ...base(), modules: [] })).includes('modules'));
  const { modules, ...noModules } = base();
  assert.ok(errorPaths(validatePluginManifest(noModules)).includes('modules'));
});

test('rejects a name that is not kebab-case or cannot be a folder name', () => {
  for (const name of ['Comms', 'my_plugin', '1plugin', 'a', '../escape']) {
    const result = validatePluginManifest({ ...base(), name });
    assert.equal(result.ok, false, name);
    assert.ok(errorPaths(result).includes('name'), name);
  }
});

test('rejects an entry point that escapes the plugin folder or is not a module file', () => {
  for (const entryPoint of ['../index.mjs', '/abs/index.mjs', 'lib\\index.mjs', 'index.json', 'sub/../../x.mjs']) {
    const result = validatePluginManifest({ ...base(), entryPoint });
    assert.equal(result.ok, false, entryPoint);
    assert.ok(errorPaths(result).includes('entryPoint'), entryPoint);
  }
});

test('rejects a register function name that is not an identifier', () => {
  const result = validatePluginManifest({ ...base(), registerFunction: 'register plugin()' });
  assert.ok(errorPaths(result).includes('registerFunction'));
});

test('rejects a bad semantic version and missing required text fields', () => {
  const result = validatePluginManifest({ ...base(), version: 'v1', description: 'short', author: '' });
  assert.deepEqual(errorPaths(result).sort(), ['author', 'description', 'version']);
});

test('rejects unknown top-level keys, so company data cannot ride along in a manifest', () => {
  const result = validatePluginManifest({ ...base(), company_id: 'c_123' });
  assert.equal(result.ok, false);
  assert.ok(errorPaths(result).includes('company_id'));
});

test('rejects a non-object manifest', () => {
  for (const raw of [null, 'plugin', ['chatbot'], 7]) {
    assert.equal(validatePluginManifest(raw).ok, false);
  }
});

test('the validator source is pure: no I/O or framework imports', () => {
  const source = readFileSync(`${repo}server/plugins/manifest.ts`, 'utf8');
  const imports = [...source.matchAll(/^import .* from '([^']+)';/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['../modules/desk-modes/mode-modules.ts', '../modules/desk-modes/mode-resolver.ts']);
  assert.doesNotMatch(source, /\b(fs|node:fs|process\.env|fetch\(|express)\b/);
});

test('the real comms and workforce-runtime manifests validate', () => {
  for (const rel of ['plugins/comms/plugin.json', 'plugins/workforce-runtime/plugin.json']) {
    const result = validatePluginManifest(readJson(rel));
    assert.equal(result.ok, true, `${rel}: ${errorText(result)}`);
  }
});

test('the comms manifest lists no workforce-only module, and the workforce manifest lists no comms-only module', () => {
  const comms = readJson('plugins/comms/plugin.json');
  const workforce = readJson('plugins/workforce-runtime/plugin.json');
  for (const mod of comms.modules) assert.ok(!exclusiveModules('workforce').includes(mod), mod);
  for (const mod of workforce.modules) assert.ok(!exclusiveModules('comms').includes(mod), mod);
  assert.equal(comms.mode, 'comms');
  assert.equal(workforce.mode, 'workforce');
});

test('each plugin folder name equals its manifest name (the loader keys plugins by name)', () => {
  for (const folder of ['comms', 'workforce-runtime']) {
    assert.equal(readJson(`plugins/${folder}/plugin.json`).name, folder);
  }
});

test('plugins/ holds only validated manifests, and the template is not among them', () => {
  const pluginsDir = `${repo}plugins`;
  const withManifest = readdirSync(pluginsDir).filter((entry) =>
    existsSync(`${pluginsDir}/${entry}/plugin.json`),
  );
  assert.deepEqual(withManifest.sort(), ['comms', 'titan-workforce-bridge', 'workforce-runtime']);
  assert.ok(statSync(`${repo}docs/templates/plugin/plugin.json`).isFile());
  assert.equal(existsSync(`${pluginsDir}/plugin`), false, 'template must not sit under plugins/');
});

test('each wrapper maps exactly the modules in its manifest, and every entry point exists', async () => {
  for (const folder of ['comms', 'workforce-runtime']) {
    const manifest = readJson(`plugins/${folder}/plugin.json`);
    const wrapper = await import(`../../plugins/${folder}/index.mjs`);
    assert.deepEqual(Object.keys(wrapper.MODULE_ENTRIES).sort(), [...manifest.modules].sort(), folder);
    for (const [name, rel] of Object.entries(wrapper.MODULE_ENTRIES)) {
      assert.ok(existsSync(new URL(`../../plugins/${folder}/${rel}`, import.meta.url)), `${folder}/${name}: ${rel}`);
      assert.ok(MODE_MODULES[manifest.mode].includes(name), `${folder}/${name} not in ${manifest.mode} mode`);
    }
  }
});

test('wrappers register nothing unless their env flag is exactly "true"', async () => {
  const wrapper = await import('../../plugins/comms/index.mjs');
  const app = { get() {} };
  const saved = process.env.TITAN_COMMS_ENABLED;
  try {
    delete process.env.TITAN_COMMS_ENABLED;
    assert.equal(wrapper.registerPlugin(app, { adminAuthMiddleware() {} }).registered, false);
    process.env.TITAN_COMMS_ENABLED = 'TRUE';
    assert.equal(wrapper.registerPlugin(app, { adminAuthMiddleware() {} }).registered, false);
    process.env.TITAN_COMMS_ENABLED = 'true';
    assert.equal(wrapper.registerPlugin(app, { adminAuthMiddleware() {} }).registered, false);
  } finally {
    if (saved === undefined) delete process.env.TITAN_COMMS_ENABLED;
    else process.env.TITAN_COMMS_ENABLED = saved;
  }
});
