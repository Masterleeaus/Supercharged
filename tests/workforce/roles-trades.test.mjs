import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

// Same zod fallback as tests/workforce/catalogue.test.mjs: zod is declared in
// package.json but may be missing from this checkout.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const lib = await import('../../server/workforce/catalogue/index.ts');
const rolesDir = new URL('../../server/workforce/catalogue/roles/', import.meta.url);

const BATCH = [
  'trades-urgent-callout-triage',
  'trades-gas-electrical-safety-escalation',
  'trades-after-hours-triage',
  'trades-after-hours-handover-summary',
  'trades-quote-request-intake',
  'trades-quote-drafting-assist',
  'trades-quote-follow-up',
  'trades-job-scheduling-coordinator',
  'trades-reschedule-and-access-handler',
  'trades-technician-dispatch-support',
  'trades-booking-confirmation',
  'trades-parts-and-materials-check',
  'trades-supplier-order-draft',
  'trades-compliance-certificate-reminders',
  'trades-gas-compliance-tracker',
  'trades-electrical-test-certificate-tracker',
  'trades-backflow-test-reminder',
  'trades-service-agreement-renewal',
  'trades-service-agreement-lapse-watch',
  'trades-seasonal-maintenance-reminder',
  'trades-job-completion-readiness',
  'trades-job-completion-follow-up',
  'trades-review-request',
  'trades-warranty-callback-triage',
  'trades-job-notes-summariser',
];

const SAFETY_TRADES = ['plumbing', 'electrical', 'hvac'];

async function loadBatch() {
  const loaded = [];
  for (const id of BATCH) {
    const file = new URL(`${id}.ts`, rolesDir);
    assert.ok(existsSync(file), `missing role file for ${id}`);
    const mod = await import(file.href);
    loaded.push({ id, mod });
  }
  return loaded;
}

test('batch has 25 role files, each named after its id and exporting a role object', async () => {
  assert.equal(BATCH.length, 25);
  const onDisk = readdirSync(rolesDir)
    .filter((f) => f.endsWith('.ts') && !f.startsWith('_') && f.startsWith('trades-'))
    .map((f) => f.replace(/\.ts$/, ''))
    .sort();
  assert.deepEqual(onDisk, [...BATCH].sort());
  for (const { id, mod } of await loadBatch()) {
    assert.ok(mod.role && typeof mod.role === 'object', `${id} must export role`);
    assert.equal(mod.role.id, id, `${id}: id must match file name`);
  }
});

test('every batch role passes validateRoleDefinition', async () => {
  for (const { id, mod } of await loadBatch()) {
    const result = lib.validateRoleDefinition(mod.role);
    assert.equal(result.ok, true, `${id}: ${JSON.stringify(result.ok ? [] : result.errors)}`);
  }
});

test('batch passes validateCatalogue, so every handoff resolves to a role in the batch', async () => {
  const roles = (await loadBatch()).map(({ mod }) => mod.role);
  const result = lib.validateCatalogue(roles);
  assert.equal(result.ok, true, JSON.stringify(result.ok ? [] : result.errors));
});

test('no role is predictive by default: autonomy is never predictive', async () => {
  for (const { id, mod } of await loadBatch()) {
    assert.notEqual(mod.role.autonomy, 'predictive', `${id} must not be predictive`);
  }
});

test('mutating tools are never used at suggest or assist autonomy', async () => {
  const writeTools = /\.(create|update|send|bulk|draft|page_on_call|escalate_to_human|draft_renewal)$|^(parts_list|purchase_orders|compliance_reminders|customer_messages|safety|after_hours|visits|project_visits)\./;
  for (const { id, mod } of await loadBatch()) {
    const { autonomy, tools } = mod.role;
    if (autonomy !== 'suggest' && autonomy !== 'assist') continue;
    const mutating = tools.filter((t) => writeTools.test(t) && !/\.list$|\.get$/.test(t));
    // safety.escalate_to_human is the one write allowed under suggest: it notifies a person and changes no record.
    const allowed = new Set(['safety.escalate_to_human']);
    const bad = mutating.filter((t) => !allowed.has(t));
    assert.deepEqual(bad, [], `${id} is ${autonomy} but lists mutating tools`);
  }
});

test('gas and electrical safety roles tell the model to escalate immediately', async () => {
  const safetyIds = [
    'trades-urgent-callout-triage',
    'trades-gas-electrical-safety-escalation',
    'trades-after-hours-triage',
  ];
  for (const { id, mod } of await loadBatch()) {
    if (!safetyIds.includes(id)) continue;
    const text = mod.role.guardrails.join(' ');
    assert.match(text, /immediately|at once|straight away/i, `${id} must escalate safety reports immediately`);
    assert.ok(mod.role.tools.includes('safety.escalate_to_human') || mod.role.tools.includes('after_hours.page_on_call'),
      `${id} must have an escalation tool`);
  }
});

test('plumbing, electrical and HVAC roles never run autonomously on safety-critical work', async () => {
  for (const { id, mod } of await loadBatch()) {
    if (!mod.role.verticals.some((v) => SAFETY_TRADES.includes(v))) continue;
    assert.ok(
      ['suggest', 'auto'].includes(mod.role.autonomy),
      `${id} must stay at suggest or auto`,
    );
  }
});

test('auto roles that send to customers carry a critical-risk tool', async () => {
  for (const { id, mod } of await loadBatch()) {
    const { tools, toolRisk, autonomy } = mod.role;
    if (tools.includes('customer_messages.send')) {
      assert.equal(toolRisk['customer_messages.send'], 'critical', `${id} customer messages must be critical risk`);
      assert.equal(autonomy, 'auto', `${id} must require approval before sending to customers`);
    }
  }
});

test('every sourceRef is a Desk preset, a Field native id, or new', async () => {
  const allowed = new Set([
    'Virtual Receptionist Agent', 'Appointment Setter Agent', 'Lead Qualification Agent',
    'Survey & Feedback Agent', 'Customer Service Agent', 'Outbound Sales Agent',
    'Debt Collection Agent', 'Event Registration Agent',
    'reception', 'sales', 'booking', 'scheduling', 'jobs', 'customer_care', 'new',
  ]);
  for (const { id, mod } of await loadBatch()) {
    assert.ok(allowed.has(mod.role.sourceRef), `${id} has unknown sourceRef`);
  }
});
