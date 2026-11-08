import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// zod is listed in package.json but is not installed in this checkout. When a
// plain import fails, route 'zod' to a copy outside the repo (default:
// /opt/npm-tools/node_modules/zod, override with ZOD_FALLBACK_ENTRY). Hooks are
// registered before the catalogue modules are imported below.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const lib = await import('../../server/workforce/catalogue/index.ts');
const { role: example } = await import('../../server/workforce/catalogue/roles/_example.ts');

const clone = (value) => structuredClone(value);
const seedPath = fileURLToPath(new URL('../../server/seed-agent-templates.ts', import.meta.url));

test('accepts the example role and applies the assist default', () => {
  const raw = clone(example);
  delete raw.autonomy;
  const result = lib.validateRoleDefinition(raw);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.role.autonomy, 'assist');
  assert.equal(result.role.companyScope, 'required');
});

test('rejects a missing required field', () => {
  const raw = clone(example);
  delete raw.name;
  const result = lib.validateRoleDefinition(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'name'), JSON.stringify(result.errors));
});

test('rejects company data smuggled into a role (strict shape)', () => {
  const result = lib.validateRoleDefinition({ ...clone(example), company_id: 'c_123' });
  assert.equal(result.ok, false);
});

test('rejects a critical tool with predictive and accepts auto', () => {
  const raw = clone(example);
  raw.tools.push('invoices.refund');
  raw.toolRisk['invoices.refund'] = 'critical';
  raw.autonomy = 'predictive';
  const rejected = lib.validateRoleDefinition(raw);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((e) => e.path === 'autonomy'), JSON.stringify(rejected.errors));

  raw.autonomy = 'auto';
  assert.equal(lib.validateRoleDefinition(raw).ok, true);
});

test('rejects a tool with no risk level', () => {
  const raw = clone(example);
  delete raw.toolRisk['clients.list'];
  const result = lib.validateRoleDefinition(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'toolRisk.clients.list'));
});

test('rejects a duplicate role id across the catalogue', () => {
  const result = lib.validateCatalogue([clone(example), { ...clone(example), name: 'Second Role' }]);
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => e.path === 'roles[1].id' && /duplicate role id/.test(e.message)),
    JSON.stringify(result.errors),
  );
});

test('rejects a handoff to an unknown role id, and accepts a handoff to a known one', () => {
  const bad = lib.validateCatalogue([{ ...clone(example), handoffTo: ['no-such-role'] }]);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.path === 'roles[0].handoffTo.0'), JSON.stringify(bad.errors));

  const target = { ...clone(example), id: 'example-booking-coordinator', name: 'Example Booking Coordinator', sourceRef: 'booking' };
  const good = lib.validateCatalogue([{ ...clone(example), handoffTo: ['example-booking-coordinator'] }, target]);
  assert.equal(good.ok, true, JSON.stringify(good.errors));
});

test('rejects literal phone numbers, emails and API keys in the prompt', () => {
  const cases = [
    ['phone number', 'Call the office on +61 412 345 678 for urgent work.'],
    ['phone number', 'Our after-hours line is 0412 345 678.'],
    ['email address', 'Send disputes to billing@example-company.com.'],
    ['API key', 'Use key sk-ant-test1234567890ABCDEFGHIJ when calling the tool.'],
  ];
  for (const [label, sentence] of cases) {
    const raw = clone(example);
    raw.systemPrompt = `${raw.systemPrompt}\n${sentence}`;
    const result = lib.validateRoleDefinition(raw);
    assert.equal(result.ok, false, `${label} should be rejected`);
    assert.ok(
      result.errors.some((e) => e.path === 'systemPrompt' && e.message.includes(label)),
      JSON.stringify(result.errors),
    );
  }
});

test('does not flag dates, times or placeholders as phone numbers', () => {
  const raw = clone(example);
  raw.systemPrompt = `${raw.systemPrompt}\nOpen 08:00 to 17:00 on 2026-11-02, see {{company_name}} rates.`;
  assert.equal(lib.validateRoleDefinition(raw).ok, true);
});

test('the 8 Desk presets in seed-agent-templates.ts all map to valid sourceRef values', () => {
  const source = readFileSync(seedPath, 'utf8');
  const presets = [...source.matchAll(/\{\s*name: "([^"]+)",[\s\S]*?category: "([a-z_]+)"/g)]
    .filter((match) => match[2] === 'agent_preset')
    .map((match) => match[1]);

  assert.equal(presets.length, 8, `expected 8 agent presets, found ${presets.length}`);
  assert.deepEqual([...presets].sort(), [...lib.DESK_PRESET_NAMES].sort());

  for (const name of presets) {
    const result = lib.validateRoleDefinition({ ...clone(example), id: 'preset-check', sourceRef: name });
    assert.equal(result.ok, true, `${name}: ${JSON.stringify(result.errors)}`);
  }
});

test('toolAccess: a role with no toolAccess is accepted and every tool defaults to write', () => {
  const raw = clone(example);
  delete raw.toolAccess;
  const result = lib.validateRoleDefinition(raw);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(result.role.toolAccess, {});
});

test('toolAccess: refuses an access value other than read or write', () => {
  const raw = clone(example);
  raw.toolAccess = { ...raw.toolAccess, 'clients.list': 'execute' };
  const result = lib.validateRoleDefinition(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'toolAccess.clients.list'), JSON.stringify(result.errors));
});

test('toolAccess: refuses an access entry for a tool the role does not declare', () => {
  const raw = clone(example);
  raw.toolAccess = { ...raw.toolAccess, 'no.such_tool': 'read' };
  const result = lib.validateRoleDefinition(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'toolAccess.no.such_tool'), JSON.stringify(result.errors));
});

test('owner rule: an owner-approval tool must be critical', () => {
  const raw = clone(example);
  raw.tools.push('customer_messages.send');
  raw.toolRisk['customer_messages.send'] = 'low';
  raw.autonomy = 'auto';
  const result = lib.validateRoleDefinition(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'toolRisk.customer_messages.send'), JSON.stringify(result.errors));
});

test('owner rule: an owner-approval tool can never be declared read', () => {
  const raw = clone(example);
  raw.tools.push('refund_requests.create');
  raw.toolRisk['refund_requests.create'] = 'critical';
  raw.toolAccess = { ...raw.toolAccess, 'refund_requests.create': 'read' };
  raw.autonomy = 'auto';
  const result = lib.validateRoleDefinition(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'toolAccess.refund_requests.create'), JSON.stringify(result.errors));
});

test('owner rule: a critical owner-approval tool is accepted at auto, where the ladder holds it for approval', () => {
  const raw = clone(example);
  raw.tools.push('customer_messages.send');
  raw.toolRisk['customer_messages.send'] = 'critical';
  raw.toolAccess = { ...raw.toolAccess, 'customer_messages.send': 'write' };
  raw.autonomy = 'auto';
  assert.equal(lib.validateRoleDefinition(raw).ok, true);
});
