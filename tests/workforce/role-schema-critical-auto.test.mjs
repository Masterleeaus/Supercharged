import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Narrow check of the owner rule in role.schema.ts: a critical-risk tool may sit at auto or
// predictive, and at auto the ladder holds it for a verified owner approval whoever acts.
// No network, no database. zod fallback as in catalogue.test.mjs.
try {
  await import('zod');
} catch {
  const entry = process.env.ZOD_FALLBACK_ENTRY ?? '/opt/npm-tools/node_modules/zod/index.js';
  register('./zod-fallback.hooks.mjs', import.meta.url, { data: { entry } });
}

const lib = await import('../../server/workforce/catalogue/index.ts');
const { role: example } = await import('../../server/workforce/catalogue/roles/_example.ts');
const { evaluateAuthority } = await import('../../server/modules/approvals/authority-ladder.ts');

const clone = (value) => structuredClone(value);

function withCriticalSend(autonomy) {
  const raw = clone(example);
  raw.tools.push('customer_messages.send');
  raw.toolRisk['customer_messages.send'] = 'critical';
  raw.toolAccess = { ...raw.toolAccess, 'customer_messages.send': 'write' };
  raw.autonomy = autonomy;
  return raw;
}

test('a critical tool is refused at predictive and accepted at assist, suggest and auto', () => {
  const rejected = lib.validateRoleDefinition(withCriticalSend('predictive'));
  assert.equal(rejected.ok, false, 'predictive must reject a critical tool');
  assert.ok(rejected.errors.some((e) => e.path === 'autonomy'), JSON.stringify(rejected.errors));
  for (const autonomy of ['assist', 'suggest', 'auto']) {
    const result = lib.validateRoleDefinition(withCriticalSend(autonomy));
    assert.equal(result.ok, true, `${autonomy}: ${JSON.stringify(result.errors)}`);
  }
});

test('a critical tool at auto is accepted by the schema, because the ladder holds it for approval', () => {
  assert.equal(lib.validateRoleDefinition(withCriticalSend('auto')).ok, true);
});

test('the ladder requires owner approval for a critical tool at auto, for writes and reads, human or agent', () => {
  for (const access of ['write', 'read']) {
    for (const actorIsHuman of [false, true]) {
      const result = evaluateAuthority({
        tier: 'critical',
        autonomy: 'auto',
        access,
        humanApproved: false,
        actorIsHuman,
      });
      assert.equal(result.decision, 'require_approval', `access=${access} actorIsHuman=${actorIsHuman}`);
    }
  }
});

test('an owner-approval tool cannot be declared below critical at auto', () => {
  const raw = withCriticalSend('auto');
  raw.toolRisk['customer_messages.send'] = 'high';
  const result = lib.validateRoleDefinition(raw);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'toolRisk.customer_messages.send'), JSON.stringify(result.errors));
});
