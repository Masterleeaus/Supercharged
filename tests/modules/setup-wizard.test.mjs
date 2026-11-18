// Setup wizard (#363): a test business goes from sign-up to one successful test enquiry and an
// explicit go-live, inside 30 minutes. Connector port is a fake. Nothing is sent.
import test from 'node:test';
import assert from 'node:assert/strict';
import { STARTER_PACKS } from '../../server/modules/starter-packs/packs/index.ts';
import { emptyCompany, loadPack } from '../../server/modules/starter-packs/load.ts';
import {
  startSetup,
  recordTools,
  choosePack,
  connectAll,
  previewFieldMap,
  confirmFieldMap,
  runTestEnquiry,
  buildPreview,
  goLive,
  WIZARD_STEPS,
  proposeSetup,
  nextStep,
} from '../../server/modules/starter-packs/setup-wizard.ts';

const CO = '22222222-2222-4222-8222-222222222222';
const OWNER = 'owner-1';
const T0 = new Date('2026-11-18T00:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);
const POOL = STARTER_PACKS.find((p) => p.vertical === 'pool');

function okPort() {
  const calls = [];
  return {
    calls,
    async connect(companyId, connectorId) {
      calls.push({ companyId, connectorId });
      return { ok: true };
    },
  };
}

function failingPort(failId) {
  return {
    async connect(_c, connectorId) {
      return { ok: connectorId !== failId };
    },
  };
}

/** Runs the whole flow up to the review step, with the test business's answers. */
async function runFlow({ port = okPort(), startMin = 0 } = {}) {
  let state = startSetup(CO, at(startMin));
  state = recordTools(state, ['Gmail', 'Twilio', 'Typeform'], OWNER, at(startMin + 1));
  const chosen = choosePack(state, POOL, OWNER, at(startMin + 2));
  assert.equal(chosen.ok, true);
  state = chosen.state;
  const pack = chosen.pack;

  const connected = await connectAll(state, pack, port, OWNER, at(startMin + 4));
  state = connected.state;

  const config = loadPack({ pack, company: emptyCompany(CO, 'Test Pool Co') });
  assert.equal(config.ok, true);

  const mapping = {
    'Service Type': 'service_type',
    'Pool or spa': 'pool_kind',
    Suburb: 'suburb',
    'Size (square metres)': 'size_sqm',
  };
  const fm = confirmFieldMap(state, pack, mapping, OWNER, at(startMin + 6));
  assert.equal(fm.ok, true, fm.ok ? '' : fm.errors.join('; '));
  state = fm.state;

  state = runTestEnquiry(state, config.config, pack, OWNER, at(startMin + 8));
  return { state, pack, config: config.config, blocked: connected.blocked };
}

test('a test business goes from sign-up to live in under 30 minutes with one passing test enquiry', async () => {
  const { state, pack, config } = await runFlow();
  assert.equal(state.testEnquiryPassed, true);

  const preview = buildPreview(state, config);
  const result = goLive(state, pack, config, { confirmHash: preview.hash, actorId: OWNER, now: at(12) });
  assert.equal(result.ok, true, result.ok ? '' : result.errors.join('; '));
  assert.equal(result.withinBudget, true);
  assert.ok(result.minutes < 30);
  assert.ok(result.state.liveAt);
});

test('every step is logged with who decided it and when', async () => {
  const { state, pack, config } = await runFlow();
  const preview = buildPreview(state, config);
  const { state: live } = goLive(state, pack, config, { confirmHash: preview.hash, actorId: OWNER, now: at(12) });
  const steps = new Set(live.log.map((l) => l.step));
  for (const step of ['tools', 'pack', 'connect', 'fieldMap', 'test', 'live']) {
    assert.ok(steps.has(step), `missing log for ${step}`);
  }
  assert.ok(live.log.every((l) => l.actorId === OWNER && !Number.isNaN(Date.parse(l.at))));
  assert.deepEqual(WIZARD_STEPS.filter((s) => live.completed.includes(s)).sort(), [...new Set(live.log.map((l) => l.step))].sort());
});

test('tools map to connectors, and an unknown tool is flagged for setup by hand', () => {
  const state = recordTools(startSetup(CO, T0), ['Gmail', 'Typeform', ' Jobber '], OWNER, T0);
  assert.equal(state.tools.find((t) => t.name === 'Gmail').connectorId, 'email');
  assert.equal(state.tools.find((t) => t.name === 'Typeform').connectorId, null);
  assert.equal(state.tools.find((t) => t.name === 'Jobber').connectorId, 'jobber');
  assert.match(state.log[0].decision, /1 to set up by hand \(Typeform\)/);
});

test('a failed required connector blocks the wizard, and go-live is refused', async () => {
  const { state, pack, config, blocked } = await runFlow({ port: failingPort('email') });
  assert.deepEqual(blocked, ['email']);
  const preview = buildPreview(state, config);
  const result = goLive(state, pack, config, { confirmHash: preview.hash, actorId: OWNER, now: at(12) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /required connector email is not connected/.test(e)));
});

test('go-live is refused before the test enquiry has passed', async () => {
  let state = startSetup(CO, T0);
  state = recordTools(state, ['Gmail'], OWNER, at(1));
  const chosen = choosePack(state, POOL, OWNER, at(2));
  state = chosen.state;
  const config = loadPack({ pack: POOL, company: emptyCompany(CO, 'Test Pool Co') }).config;
  const preview = buildPreview(state, config);
  const result = goLive(state, POOL, config, { confirmHash: preview.hash, actorId: OWNER, now: at(3) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('field map not confirmed'));
  assert.ok(result.errors.includes('test enquiry has not passed'));
});

test('a confirmation that does not match the preview shown is refused', async () => {
  const { state, pack, config } = await runFlow();
  const result = goLive(state, pack, config, { confirmHash: 'not-the-hash', actorId: OWNER, now: at(12) });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('confirmation does not match the preview shown'));
  assert.equal(state.liveAt, null);
});

test('the preview lists exactly what will go out, with no price in it', async () => {
  const { state, pack, config } = await runFlow();
  const preview = buildPreview(state, config);
  assert.ok(preview.items.some((i) => i.kind === 'connector' && /email/.test(i.label)));
  assert.ok(preview.items.some((i) => i.kind === 'template' && /enquiry_ack/.test(i.label)));
  assert.ok(preview.items.some((i) => i.kind === 'compliance'));
  assert.ok(!JSON.stringify(preview).match(/\bprice\b|\$\s?\d/i));
  // A changed preview has a different hash, so an old confirmation cannot be reused.
  const changed = { ...state, connectors: { ...state.connectors, sms: 'failed' } };
  assert.notEqual(buildPreview(changed, config).hash, preview.hash);
  assert.equal(goLive(state, pack, config, { confirmHash: preview.hash, actorId: OWNER, now: at(12) }).ok, true);
  assert.equal(goLive(changed, pack, config, { confirmHash: preview.hash, actorId: OWNER, now: at(12) }).ok, false);
});

test('a setup that takes longer than 30 minutes still goes live, but is marked over budget', async () => {
  const { state, pack, config } = await runFlow();
  const preview = buildPreview(state, config);
  const result = goLive(state, pack, config, { confirmHash: preview.hash, actorId: OWNER, now: at(45) });
  assert.equal(result.ok, true);
  assert.equal(result.withinBudget, false);
});

test('field map preview finds required fields that are not covered, and confirmation refuses them', () => {
  const preview = previewFieldMap(['Suburb', 'Frequency'], POOL);
  assert.equal(preview.rows.find((r) => r.source === 'Suburb').target, 'suburb');
  assert.ok(preview.missingRequired.includes('service_type'));
  assert.ok(preview.missingRequired.includes('pool_kind'));

  const bad = confirmFieldMap(startSetup(CO, T0), POOL, { Suburb: 'suburb', Mystery: 'no_such_field' }, OWNER, T0);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => /unknown field no_such_field/.test(e)));
  assert.ok(bad.errors.some((e) => /required field service_type is not mapped/.test(e)));
});

test('a pack that is not valid is refused at the pack step', () => {
  const broken = structuredClone(POOL);
  broken.services[0].price = 99;
  const r = choosePack(startSetup(CO, T0), broken, OWNER, T0);
  assert.equal(r.ok, false);
});

test('proposeSetup maps tools to connectors, flags unknown tools, and suggests the pack with most overlap', () => {
  const proposal = proposeSetup(['Gmail', 'Twilio', 'Typeform', 'gmail'], STARTER_PACKS);
  assert.deepEqual(proposal.connectors, ['email', 'sms']);
  assert.deepEqual(proposal.manualTools, ['Typeform']);
  const expected = STARTER_PACKS.map((p) => ({ id: `${p.id}@${p.version}`, n: p.connectorPresets.filter((c) => ['email', 'sms'].includes(c.connectorId)).length }));
  const best = expected.reduce((a, b) => (b.n > a.n ? b : a));
  assert.equal(proposal.suggestedPackId, best.id);
  assert.equal(proposal.coveredPresets, best.n);
});

test('proposeSetup with no known tools still suggests a pack, with nothing covered', () => {
  const proposal = proposeSetup([], STARTER_PACKS);
  assert.deepEqual(proposal.connectors, []);
  assert.equal(proposal.coveredPresets, 0);
  assert.equal(proposal.suggestedPackId, `${STARTER_PACKS[0].id}@${STARTER_PACKS[0].version}`);
});

test('proposeSetup refuses an empty pack list', () => {
  assert.throws(() => proposeSetup(['Gmail'], []), /at least one starter pack/);
});

test('nextStep walks the steps in order and returns null when all are done', async () => {
  let state = startSetup(CO, at(0));
  assert.equal(nextStep(state), 'tools');
  state = recordTools(state, ['Gmail'], OWNER, at(1));
  assert.equal(nextStep(state), 'pack');
  const chosen = choosePack(state, POOL, OWNER, at(2));
  state = chosen.state;
  assert.equal(nextStep(state), 'connect');
  state = (await connectAll(state, chosen.pack, okPort(), OWNER, at(3))).state;
  assert.equal(nextStep(state), 'fieldMap');
  const config = loadPack({ pack: chosen.pack, company: emptyCompany(CO, 'Test Pool Co') });
  const mapping = {
    'Service Type': 'service_type',
    'Pool or spa': 'pool_kind',
    Suburb: 'suburb',
    'Size (square metres)': 'size_sqm',
  };
  state = confirmFieldMap(state, chosen.pack, mapping, OWNER, at(4)).state;
  assert.equal(nextStep(state), 'test');
  state = runTestEnquiry(state, config.config, chosen.pack, OWNER, at(5));
  assert.equal(nextStep(state), 'review');
});
