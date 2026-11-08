/**
 * Template tests. Run from the repo root:
 *   node --test tests/templates/templates.test.mjs
 *
 * Generator checks run in a throwaway copy under os.tmpdir(), never in the repo.
 * No database is opened and no server is started.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const GEN = path.join(REPO, 'scripts', 'new-module.mjs');
const MODULE_TPL = path.join(REPO, 'server', 'modules', '_template');
const PLUGIN_TPL = path.join(REPO, 'docs', 'templates', 'plugin');
const LEFTOVER = /\{\{\s*[A-Za-z_]\w*\s*\}\}/;
const MODULE_FILES = ['index.ts', 'template-routes.ts', 'template-service.ts', 'template-storage.ts', 'README.md'];
const PLUGIN_FILES = ['plugin.json', 'index.mjs', 'README.md'];
const REQUIRED_MANIFEST_KEYS = ['name', 'displayName', 'version', 'description', 'author', 'entryPoint', 'registerFunction', 'features'];

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'titan-tpl-test-'));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

function fakeApp() {
  const calls = [];
  return { calls, get(p, ...handlers) { calls.push({ method: 'get', path: p, handlers }); } };
}

test('module template: every file exists', () => {
  for (const f of MODULE_FILES) {
    assert.ok(fs.existsSync(path.join(MODULE_TPL, f)), `missing server/modules/_template/${f}`);
  }
});

test('plugin template: every file exists', () => {
  for (const f of PLUGIN_FILES) {
    assert.ok(fs.existsSync(path.join(PLUGIN_TPL, f)), `missing docs/templates/plugin/${f}`);
  }
});

test('plugin template: plugin.json is valid JSON with required keys', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_TPL, 'plugin.json'), 'utf8'));
  for (const key of REQUIRED_MANIFEST_KEYS) {
    assert.ok(key in manifest, `plugin.json missing "${key}"`);
  }
  assert.ok(Array.isArray(manifest.features), 'features must be an array');
  assert.ok(fs.existsSync(path.join(PLUGIN_TPL, manifest.entryPoint)), 'entryPoint file missing');
  const src = fs.readFileSync(path.join(PLUGIN_TPL, manifest.entryPoint), 'utf8');
  assert.match(src, new RegExp(`export function ${manifest.registerFunction}\\b`), 'registerFunction not exported');
});

test('plugin template: registers nothing when the env flag is unset', async () => {
  const saved = process.env.TITAN_TEMPLATE_CHECK_ENABLED;
  delete process.env.TITAN_TEMPLATE_CHECK_ENABLED;
  try {
    const mod = await import(pathToFileURL(path.join(PLUGIN_TPL, 'index.mjs')).href);
    const app = fakeApp();
    const result = mod.registerPlugin(app, { adminAuthMiddleware: () => {} });
    assert.equal(result.registered, false);
    assert.deepEqual([...result.paths], []);
    assert.equal(app.calls.length, 0, 'no route may be mounted while disabled');
  } finally {
    if (saved !== undefined) process.env.TITAN_TEMPLATE_CHECK_ENABLED = saved;
  }
});

test('module template: index exports a register function; routes use requireRole and safeParse', () => {
  const index = fs.readFileSync(path.join(MODULE_TPL, 'index.ts'), 'utf8');
  assert.match(index, /export function register\{\{pascal\}\}Module\(/);
  const routes = fs.readFileSync(path.join(MODULE_TPL, 'template-routes.ts'), 'utf8');
  assert.match(routes, /requireRole\(/);
  assert.match(routes, /safeParse\(/);
});

test('generator: builds a module and a plugin in a temp copy with no leftover tokens', () => {
  const root = path.join(TMP, 'repo');
  fs.mkdirSync(path.join(root, 'server', 'modules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'templates'), { recursive: true });
  fs.cpSync(MODULE_TPL, path.join(root, 'server', 'modules', '_template'), { recursive: true });
  fs.cpSync(PLUGIN_TPL, path.join(root, 'docs', 'templates', 'plugin'), { recursive: true });

  const mod = spawnSync(process.execPath, [GEN, 'my-thing', '--root', root], { encoding: 'utf8' });
  assert.equal(mod.status, 0, mod.stderr);
  const modDir = path.join(root, 'server', 'modules', 'my-thing');
  for (const f of ['index.ts', 'my-thing-routes.ts', 'my-thing-service.ts', 'my-thing-storage.ts', 'README.md']) {
    assert.ok(fs.existsSync(path.join(modDir, f)), `generated module missing ${f}`);
  }
  for (const file of walk(modDir)) {
    assert.doesNotMatch(path.basename(file), /^template-/, 'template- prefix survived in a file name');
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), LEFTOVER, `leftover token in ${file}`);
  }
  const routes = fs.readFileSync(path.join(modDir, 'my-thing-routes.ts'), 'utf8');
  assert.match(routes, /from "\.\.\/\.\.\/middleware\/auth"/);
  assert.match(routes, /createMyThingRouter/);
  assert.match(fs.readFileSync(path.join(modDir, 'index.ts'), 'utf8'), /from "\.\/my-thing-routes"/);

  const plug = spawnSync(process.execPath, [GEN, 'my-thing', '--plugin', '--root', root], { encoding: 'utf8' });
  assert.equal(plug.status, 0, plug.stderr);
  const plugDir = path.join(root, 'plugins', 'my-thing');
  const manifest = JSON.parse(fs.readFileSync(path.join(plugDir, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'my-thing');
  assert.equal(manifest.displayName, 'My Thing');
  for (const file of walk(plugDir)) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), LEFTOVER, `leftover token in ${file}`);
  }
  assert.match(fs.readFileSync(path.join(plugDir, 'index.mjs'), 'utf8'), /TITAN_MY_THING_ENABLED/);
});

test('generator: generated plugin is fail-closed and gated by TITAN_<NAME>_ENABLED', async () => {
  const root = path.join(TMP, 'repo');
  const entry = pathToFileURL(path.join(root, 'plugins', 'my-thing', 'index.mjs')).href;
  const mod = await import(entry);
  const saved = process.env.TITAN_MY_THING_ENABLED;
  try {
    delete process.env.TITAN_MY_THING_ENABLED;
    const off = fakeApp();
    assert.equal(mod.registerPlugin(off, { adminAuthMiddleware: () => {} }).registered, false);
    assert.equal(off.calls.length, 0);

    process.env.TITAN_MY_THING_ENABLED = 'true';
    const noAuth = fakeApp();
    assert.equal(mod.registerPlugin(noAuth, {}).registered, false, 'must not mount without auth middleware');
    assert.equal(noAuth.calls.length, 0);

    const on = fakeApp();
    const result = mod.registerPlugin(on, { adminAuthMiddleware: () => {} });
    assert.equal(result.registered, true);
    assert.deepEqual([...result.paths], ['/api/plugins/my-thing/status']);
    assert.equal(on.calls.length, 1);
  } finally {
    if (saved === undefined) delete process.env.TITAN_MY_THING_ENABLED;
    else process.env.TITAN_MY_THING_ENABLED = saved;
  }
});

test('generator: refuses existing destinations and invalid names, writing nothing', () => {
  const root = path.join(TMP, 'repo');
  const again = spawnSync(process.execPath, [GEN, 'my-thing', '--root', root], { encoding: 'utf8' });
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already exists/);

  for (const bad of ['My_Thing', 'template', '9lives', 'a--b']) {
    const r = spawnSync(process.execPath, [GEN, bad, '--root', root], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, `"${bad}" should be rejected`);
    assert.equal(fs.existsSync(path.join(root, 'server', 'modules', bad)), false);
  }
});

test('generator run in tests never writes into the repo', () => {
  assert.equal(fs.existsSync(path.join(REPO, 'server', 'modules', 'my-thing')), false);
  assert.equal(fs.existsSync(path.join(REPO, 'plugins', 'my-thing')), false);
});
