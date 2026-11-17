import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const intake = await import('../../server/connectors/leads/lead-intake.ts');
const sdk = await import('../../server/connectors/sdk/contract.ts');
const manifestMod = await import('../../server/plugins/manifest.ts');
const fs = await import('node:fs');

const NOW = new Date('2026-11-18T01:00:00Z');
const SECRET = 'web-form-secret-value-at-least-32-chars';

test('a valid web form enquiry is canonicalised with source attribution', () => {
  const res = intake.normalizeLead('web_form', { name: '  Ana  ', email: 'Ana@Example.COM', message: 'Need a quote', sourceRef: 'form-42' }, NOW);
  assert.equal(res.ok, true);
  assert.deepEqual(res.lead, {
    source: 'web_form',
    sourceRef: 'form-42',
    name: 'Ana',
    email: 'ana@example.com',
    message: 'Need a quote',
    receivedAt: '2026-11-18T01:00:00.000Z',
  });
});

test('an enquiry needs a name and either an email or a phone', () => {
  const noContact = intake.normalizeLead('widget', { name: 'Sam' }, NOW);
  assert.equal(noContact.ok, false);
  assert.ok(noContact.errors.some((e) => e.path === 'email' && e.message.includes('required')));
  const noName = intake.normalizeLead('widget', { phone: '0412 345 678' }, NOW);
  assert.ok(noName.errors.some((e) => e.path === 'name'));
});

test('an unknown source, a bad email and a bad phone are each reported', () => {
  const res = intake.normalizeLead('carrier_pigeon', { name: 'X', email: 'not-an-email', phone: '12' }, NOW);
  assert.equal(res.ok, false);
  const paths = res.errors.map((e) => e.path).sort();
  assert.deepEqual(paths, ['email', 'phone', 'source']);
});

test('a control character in the name is replaced, not kept', () => {
  const res = intake.normalizeLead('web_form', { name: 'Bo\u0007b', phone: '0412345678' }, NOW);
  assert.equal(res.ok, true);
  assert.equal(res.lead.name, 'Bo b');
});

test('the same customer is matched by email regardless of case, and by phone across AU formats', () => {
  const a = intake.normalizeLead('web_form', { name: 'A', email: 'x@y.com' }, NOW).lead;
  const b = intake.normalizeLead('widget', { name: 'A', email: 'X@Y.com' }, NOW).lead;
  assert.equal(intake.dedupeKey(a), intake.dedupeKey(b));

  const p1 = intake.normalizeLead('web_form', { name: 'P', phone: '0412 345 678' }, NOW).lead;
  const p2 = intake.normalizeLead('widget', { name: 'P', phone: '+61 412 345 678' }, NOW).lead;
  assert.equal(p1.phone, '0412345678');
  assert.equal(p2.phone, '0412345678');
  assert.equal(intake.findSameCustomer(p2, [{ phone: p1.phone, id: 'lead-1' }])?.id, 'lead-1');
});

test('no match is returned for a different customer', () => {
  const lead = intake.normalizeLead('web_form', { name: 'New', email: 'new@x.com' }, NOW).lead;
  assert.equal(intake.findSameCustomer(lead, [{ email: 'other@x.com' }]), undefined);
});

test('web form webhook accepts only a correct HMAC over the raw body', () => {
  const def = intake.createWebFormConnector();
  const body = '{"name":"A","email":"a@b.co"}';
  const good = createHmac('sha256', SECRET).update(body).digest('hex');
  assert.equal(def.verifyWebhook(body, good, SECRET), true);
  assert.equal(def.verifyWebhook(body + ' ', good, SECRET), false);
  assert.equal(def.verifyWebhook(body, good, 'wrong-secret-that-is-still-32-chars!!'), false);
  assert.equal(def.verifyWebhook(body, 'abc', SECRET), false);
  assert.equal(def.verifyWebhook(body, good, 'short'), false);
});

test('the web form definition passes the SDK contract check and its manifest validates', () => {
  const def = intake.createWebFormConnector();
  assert.deepEqual(sdk.checkConnectorDefinition(def), []);
  const raw = JSON.parse(fs.readFileSync(new URL('../../server/connectors/manifests/web-form/connector.json', import.meta.url), 'utf8'));
  const checked = manifestMod.validateConnectorManifest(raw);
  assert.ok('manifest' in checked, JSON.stringify(checked));
  assert.equal(checked.manifest.auth, def.auth);
});
