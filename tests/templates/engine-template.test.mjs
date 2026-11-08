import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = join(REPO, 'server', 'engines', '_template');
const GENERATOR = join(REPO, 'scripts', 'new-engine.mjs');
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const LEFTOVER_RE = /__(ENGINE|PROVIDER)_[A-Z_]+__|gateways\/_provider|\{\{[A-Za-z_]+\}\}/;
const CAN_STRIP_TYPES = Boolean(process.features?.typescript);

const REQUIRED_TEMPLATE_FILES = [
  'index.ts',
  'config.ts',
  'types.ts',
  'registry.ts',
  'audit.ts',
  'webhook-helper.ts',
  'VERSION',
  'CHANGELOG.md',
  'README.md',
  'gateways/_provider/index.ts',
  'gateways/_provider/handlers.ts',
  'gateways/_provider/service.ts',
  'gateways/_provider/routes.ts',
];

const work = mkdtempSync(join(tmpdir(), 'engine-template-test-'));
after(() => rmSync(work, { recursive: true, force: true }));

// Build a throwaway repo root that holds a copy of the template, then generate from it.
// The real merged3 tree is only read, never written.
const fakeRoot = join(work, 'root');
cpSync(TEMPLATE, join(fakeRoot, 'server', 'engines', '_template'), { recursive: true });
writeFileSync(join(fakeRoot, 'package.json'), '{"type":"module"}\n');
const GENERATED = join(fakeRoot, 'server', 'engines', 'billing');
execFileSync(process.execPath, [GENERATOR, 'billing', 'stripe', '--root', fakeRoot], { stdio: 'pipe' });

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function read(base, rel) {
  return readFileSync(join(base, rel), 'utf8');
}

test('template contains every required file', () => {
  for (const rel of REQUIRED_TEMPLATE_FILES) {
    const full = join(TEMPLATE, rel);
    assert.ok(existsSync(full), `missing ${rel}`);
    assert.ok(statSync(full).isFile(), `${rel} is not a file`);
  }
});

test('VERSION is semver in the template and in the generated engine', () => {
  assert.match(read(TEMPLATE, 'VERSION').trim(), SEMVER_RE);
  assert.match(read(GENERATED, 'VERSION').trim(), SEMVER_RE);
});

test('generator output has no leftover placeholder tokens', () => {
  assert.ok(existsSync(join(GENERATED, 'gateways', 'stripe')), 'provider folder not renamed to gateways/stripe');
  assert.equal(existsSync(join(GENERATED, 'gateways', '_provider')), false, 'gateways/_provider still present');
  for (const rel of ['index.ts', 'handlers.ts', 'service.ts', 'routes.ts']) {
    assert.ok(existsSync(join(GENERATED, 'gateways', 'stripe', rel)), `missing gateways/stripe/${rel}`);
  }
  for (const file of walk(GENERATED)) {
    const text = readFileSync(file, 'utf8');
    assert.doesNotMatch(text, LEFTOVER_RE, `placeholder left in ${file}`);
  }
});

test('generator fills engine name, flag, version and provider', () => {
  assert.match(read(GENERATED, 'config.ts'), /ENGINE_FLAG = 'TITAN_ENGINE_BILLING_ENABLED'/);
  assert.match(read(GENERATED, 'config.ts'), /ENGINE_VERSION = '0\.1\.0'/);
  assert.match(read(GENERATED, 'config.ts'), /PROVIDER_ID = 'stripe'/);
  assert.equal(read(GENERATED, 'VERSION').trim(), '0.1.0');
  assert.match(read(GENERATED, 'index.ts'), /export function registerBillingEngine\(/);
  assert.match(read(GENERATED, 'gateways/stripe/service.ts'), /export function createStripeAdapter\(/);
});

test('generator refuses to overwrite an existing engine and rejects bad names', () => {
  assert.throws(() =>
    execFileSync(process.execPath, [GENERATOR, 'billing', 'stripe', '--root', fakeRoot], { stdio: 'pipe' })
  );
  assert.throws(() =>
    execFileSync(process.execPath, [GENERATOR, 'Bad_Name', 'stripe', '--root', fakeRoot], { stdio: 'pipe' })
  );
  assert.throws(() =>
    execFileSync(process.execPath, [GENERATOR, 'payments', 'stripe', '--version', 'one', '--root', fakeRoot], { stdio: 'pipe' })
  );
});

test('flag rule: the skeleton is disabled by default (static)', () => {
  const config = read(GENERATED, 'config.ts');
  assert.match(config, /return env\[ENGINE_FLAG\] === 'true';/, 'flag must be an exact "true" match');
  assert.doesNotMatch(config, /!== 'false'|=== '1'|Boolean\(/, 'flag must not accept truthy shortcuts');

  const index = read(GENERATED, 'index.ts');
  assert.match(
    index,
    /if \(!isEngineEnabled\(\)\) \{\s*return;\s*\}\s*registerProviderRoutes\(/,
    'engine register must return before mounting providers'
  );

  const routes = read(GENERATED, 'gateways/stripe/routes.ts');
  const guard = routes.search(/if \(!isEngineEnabled\(\)\) \{\s*return;\s*\}/);
  assert.ok(guard >= 0, 'provider routes need the flag guard');
  const firstRegistration = routes.search(/registerGateway\(|router\.(get|post|use)\(/);
  assert.ok(firstRegistration > guard, 'no registry or route call may precede the guard');

  for (const file of walk(GENERATED)) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /^(registerGateway|registerProviderRoutes)\(/m, `module-level mount in ${file}`);
  }
});

test('flag rule: the generated engine is off unless the flag is exactly "true" (runtime)', { skip: CAN_STRIP_TYPES ? false : 'needs Node TypeScript type stripping' }, async () => {
  const { isEngineEnabled, ENGINE_FLAG } = await import(pathToFileURL(join(GENERATED, 'config.ts')).href);
  assert.equal(ENGINE_FLAG, 'TITAN_ENGINE_BILLING_ENABLED');
  assert.equal(isEngineEnabled({}), false, 'unset must be off');
  for (const value of ['', '1', 'TRUE', 'yes', 'false', ' true']) {
    assert.equal(isEngineEnabled({ [ENGINE_FLAG]: value }), false, `value ${JSON.stringify(value)} must be off`);
  }
  assert.equal(isEngineEnabled({ [ENGINE_FLAG]: 'true' }), true);
});

test('audit wraps the shared logAuditEvent and does not write its own', () => {
  const audit = read(GENERATED, 'audit.ts');
  assert.match(audit, /import \{ logAuditEvent \} from '\.\.\/\.\.\/services\/audit-log';/);
  assert.match(audit, /await logAuditEvent\(/);
  assert.doesNotMatch(audit, /db\.insert|console\.log/);
});

test('webhook helper fails closed for every input (runtime)', { skip: CAN_STRIP_TYPES ? false : 'needs Node TypeScript type stripping' }, async () => {
  const helper = await import(pathToFileURL(join(TEMPLATE, 'webhook-helper.ts')).href);
  const body = Buffer.from('{"type":"ping"}');
  const headers = { 'x-signature': helper.hmacSha256Hex('secret', body) };
  assert.equal(helper.verifyWebhookSignature({ rawBody: body, headers, secret: null }).valid, false);
  assert.equal(helper.verifyWebhookSignature({ rawBody: body, headers, secret: 'secret' }).valid, false);
  assert.equal(helper.safeEqual('abc', 'abc'), true);
  assert.equal(helper.safeEqual('abc', 'abd'), false);
  assert.equal(helper.safeEqual('abc', 'abcd'), false);
});
