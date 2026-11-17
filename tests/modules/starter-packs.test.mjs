// Starter packs (#362): the pack format, the four shipped packs, loading into an empty company,
// per-company overrides, and the enquiry-to-quote flow run on each pack's demo fixture.
// No database, no network. Pure functions only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validatePack } from '../../server/modules/starter-packs/pack.schema.ts';
import { STARTER_PACKS } from '../../server/modules/starter-packs/packs/index.ts';
import { emptyCompany, loadPack, runEnquiry } from '../../server/modules/starter-packs/load.ts';

const ROOT = new URL('../../', import.meta.url).pathname;
const CO = '11111111-1111-4111-8111-111111111111';
const clone = (v) => structuredClone(v);

function freshCompany() {
  return emptyCompany(CO, 'Sparkle Co');
}

function loadOk(pack, overrides) {
  const r = loadPack({ pack, company: freshCompany(), overrides });
  assert.equal(r.ok, true, r.ok ? '' : r.errors.join('; '));
  return r.config;
}

test('the four starter packs are present, valid, and cover the four verticals', () => {
  const verticals = STARTER_PACKS.map((p) => p.vertical).sort();
  assert.deepEqual(verticals, ['cleaning', 'garden', 'handyman', 'pool']);
  for (const pack of STARTER_PACKS) {
    const r = validatePack(pack);
    assert.equal(r.ok, true, `${pack.id}: ${r.ok ? '' : r.errors.join('; ')}`);
  }
});

test('every agent role a pack names is a real workforce catalogue role', () => {
  for (const pack of STARTER_PACKS) {
    for (const roleId of pack.agentRoles) {
      const file = join(ROOT, 'server/workforce/catalogue/roles', `${roleId}.ts`);
      assert.ok(existsSync(file), `${pack.id} names missing role ${roleId}`);
    }
  }
});

test('the format is strict: a pack cannot carry a price or any unknown field', () => {
  const base = clone(STARTER_PACKS[0]);
  const withPrice = clone(base);
  withPrice.services[0].price = 120;
  assert.equal(validatePack(withPrice).ok, false);

  const withSetting = clone(base);
  withSetting.defaultRate = 80;
  assert.equal(validatePack(withSetting).ok, false);
});

test('no pack carries a money field anywhere in its data', () => {
  const banned = new Set(['price', 'amount', 'rate', 'cost', 'fee', 'unitPrice', 'hourlyRate']);
  const keys = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (v && typeof v === 'object') {
      for (const [k, child] of Object.entries(v)) {
        keys.push(k);
        walk(child);
      }
    }
  };
  STARTER_PACKS.forEach(walk);
  assert.deepEqual(keys.filter((k) => banned.has(k)), []);
});

test('cross references are checked: unknown quote field, unknown placeholder, sms with a subject', () => {
  const badField = clone(STARTER_PACKS[0]);
  badField.services[0].quoteFieldKeys = ['no_such_field'];
  const r1 = validatePack(badField);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some((e) => /unknown field no_such_field/.test(e)));

  const badPlaceholder = clone(STARTER_PACKS[0]);
  badPlaceholder.messageTemplates[0].body = 'Hi {{clientNmae}}, thanks for asking about the clean.';
  const r2 = validatePack(badPlaceholder);
  assert.equal(r2.ok, false);
  assert.ok(r2.errors.some((e) => /unknown placeholder clientNmae/.test(e)));

  const smsSubject = clone(STARTER_PACKS[0]);
  smsSubject.messageTemplates[2].subject = 'Hi';
  assert.equal(validatePack(smsSubject).ok, false);
});

test('a pack loads into an empty company and lists what changed', () => {
  const r = loadPack({ pack: STARTER_PACKS[0], company: freshCompany() });
  assert.equal(r.ok, true);
  assert.equal(r.config.packId, 'cleaning-starter@1');
  assert.ok(r.config.services.length > 0);
  assert.ok(r.changes[0].startsWith('loaded Cleaning starter'));
});

test('a pack will not load into a company that already has one, or into a non-empty company', () => {
  const loaded = loadOk(STARTER_PACKS[1]);
  const again = loadPack({ pack: STARTER_PACKS[2], company: loaded });
  assert.equal(again.ok, false);
  assert.match(again.errors[0], /already has pack/);

  const busy = { ...freshCompany(), services: [{ id: 'x', name: 'Existing', pricingUnit: 'job', quoteFieldKeys: ['suburb'] }] };
  const notEmpty = loadPack({ pack: STARTER_PACKS[0], company: busy });
  assert.equal(notEmpty.ok, false);
  assert.match(notEmpty.errors[0], /not empty/);
});

test('per-company overrides change one service by id and are validated again', () => {
  const config = loadOk(STARTER_PACKS[3], {
    services: [{ id: 'lawn-mowing', name: 'Fortnightly lawn mow', pricingUnit: 'visit' }],
  });
  assert.equal(config.services.find((s) => s.id === 'lawn-mowing').name, 'Fortnightly lawn mow');
  assert.equal(STARTER_PACKS[3].services.find((s) => s.id === 'lawn-mowing').name, 'Lawn mowing', 'the shipped pack is not changed');

  const unknown = loadPack({ pack: STARTER_PACKS[3], company: freshCompany(), overrides: { services: [{ id: 'no-such', name: 'x' }] } });
  assert.equal(unknown.ok, false);

  const badUnit = loadPack({ pack: STARTER_PACKS[3], company: freshCompany(), overrides: { services: [{ id: 'lawn-mowing', pricingUnit: 'bags' }] } });
  assert.equal(badUnit.ok, false);

  const badPlaceholder = loadPack({
    pack: STARTER_PACKS[3],
    company: freshCompany(),
    overrides: { messageTemplates: [{ id: 'garden-quote-chaser', body: 'Hi {{nope}}, checking your garden quote.' }] },
  });
  assert.equal(badPlaceholder.ok, false);
});

test('an enquiry missing required answers asks only for those, with the question wording', () => {
  const config = loadOk(STARTER_PACKS[0]);
  const r = runEnquiry(config, {
    serviceId: 'home-clean',
    answers: { clean_type: 'home', suburb: 'Carlton' },
    clientName: 'Sam',
  });
  assert.equal(r.status, 'needs_info');
  const ids = r.missing.map((m) => m.questionId).sort();
  assert.deepEqual(ids, ['frequency', 'property-size'].sort());
  assert.ok(r.missing.every((m) => typeof m.prompt === 'string' && m.prompt.endsWith('?')));
});

test('an unknown service is reported, not guessed', () => {
  const config = loadOk(STARTER_PACKS[2]);
  assert.deepEqual(runEnquiry(config, { serviceId: 'hot-tub-magic', answers: {}, clientName: 'Sam' }), { status: 'unknown_service' });
});

for (const pack of STARTER_PACKS) {
  test(`${pack.id}: demo tenant runs its fixture enquiry to a pending quote draft with no price and nothing sent`, () => {
    const config = loadOk(pack);
    const r = runEnquiry(config, {
      serviceId: pack.fixture.enquiry.serviceId,
      answers: pack.fixture.enquiry.answers,
      clientName: 'Demo Client',
    });
    assert.equal(r.status, 'ready', r.status === 'needs_info' ? JSON.stringify(r.missing) : r.status);
    assert.equal(r.draft.serviceId, pack.fixture.enquiry.serviceId);
    assert.equal(r.draft.price, null);
    assert.equal(r.draft.state, 'pending_staff_pricing');
    assert.equal(r.sent, false);
    assert.ok(r.acknowledgement, 'pack has an enquiry acknowledgement');
    assert.match(r.acknowledgement.body, /Demo Client/);
    assert.ok(!r.acknowledgement.body.includes('{{'), 'no placeholder is left unfilled');
  });
}
