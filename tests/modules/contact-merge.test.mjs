// Contact merge (node:test). Pure functions only: no database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeContacts, effectiveConsent } from '../../server/modules/comms/contact-merge.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const OTHER_CO = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-11-03T10:00:00.000Z';

function contact(overrides = {}) {
  return {
    id: 'c-primary',
    companyId: CO,
    email: 'jane@example.com',
    phone: '+61412345678',
    name: 'Jane Primary',
    tags: ['vip'],
    consent: [{ channel: 'email', granted: true, at: '2026-01-01T00:00:00.000Z', source: 'form' }],
    ...overrides,
  };
}

function dup(overrides = {}) {
  return contact({
    id: 'c-duplicate',
    email: undefined,
    phone: undefined,
    name: 'Jane Duplicate',
    tags: ['lead'],
    consent: [{ channel: 'sms', granted: true, at: '2026-02-01T00:00:00.000Z', source: 'import' }],
    ...overrides,
  });
}

function run(overrides = {}) {
  return mergeContacts({
    companyId: CO,
    primary: contact(),
    duplicate: dup(),
    actorId: 'user-42',
    now: NOW,
    ...overrides,
  });
}

test('tags are the union of both contacts, primary order first, no repeats', () => {
  const result = run({
    primary: contact({ tags: ['vip', 'lead'] }),
    duplicate: dup({ tags: ['lead', 'trial', 'vip'] }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.merged.tags, ['vip', 'lead', 'trial']);
});

test('email and phone fall back to the duplicate only when primary has none', () => {
  const fallback = run({
    primary: contact({ email: null, phone: '' }),
    duplicate: dup({ email: 'dup@example.com', phone: '+61400000000' }),
  });
  assert.equal(fallback.merged.email, 'dup@example.com');
  assert.equal(fallback.merged.phone, '+61400000000');

  const kept = run({
    primary: contact({ email: 'jane@example.com', phone: '+61412345678' }),
    duplicate: dup({ email: 'dup@example.com', phone: '+61400000000' }),
  });
  assert.equal(kept.merged.email, 'jane@example.com');
  assert.equal(kept.merged.phone, '+61412345678');
});

test('name keeps primary value and merged id is the primary id', () => {
  const result = run();
  assert.equal(result.merged.id, 'c-primary');
  assert.equal(result.merged.name, 'Jane Primary');
  assert.equal(result.merged.companyId, CO);
});

test('consent history is kept in full from both contacts', () => {
  const result = run({
    primary: contact({
      consent: [
        { channel: 'email', granted: true, at: '2026-01-01T00:00:00.000Z', source: 'form' },
        { channel: 'email', granted: true, at: '2026-03-01T00:00:00.000Z', source: 'web' },
      ],
    }),
    duplicate: dup({
      consent: [{ channel: 'sms', granted: true, at: '2026-02-01T00:00:00.000Z', source: 'import' }],
    }),
  });
  assert.equal(result.merged.consent.length, 3);
  const sources = result.merged.consent.map((e) => e.source).sort();
  assert.deepEqual(sources, ['form', 'import', 'web']);
});

test('newest grant wins when no opt-out exists in either list', () => {
  const effective = effectiveConsent([
    { channel: 'email', granted: true, at: '2026-01-01T00:00:00.000Z', source: 'form' },
    { channel: 'email', granted: true, at: '2026-04-01T00:00:00.000Z', source: 'web' },
  ]);
  assert.equal(effective.email, true);

  const merged = run({
    primary: contact({
      consent: [{ channel: 'email', granted: true, at: '2026-04-01T00:00:00.000Z', source: 'web' }],
    }),
    duplicate: dup({
      consent: [{ channel: 'email', granted: true, at: '2026-01-01T00:00:00.000Z', source: 'form' }],
    }),
  });
  assert.equal(merged.ok, true);
  assert.equal(effectiveConsent(merged.merged.consent).email, true);
});

test('an opt-out in the duplicate list beats a newer grant on primary', () => {
  const result = run({
    primary: contact({
      consent: [{ channel: 'email', granted: true, at: '2026-05-01T00:00:00.000Z', source: 'web' }],
    }),
    duplicate: dup({
      consent: [{ channel: 'email', granted: false, at: '2026-02-01T00:00:00.000Z', source: 'unsubscribe' }],
    }),
  });
  assert.equal(result.ok, true);
  assert.equal(effectiveConsent(result.merged.consent).email, false);
  // Original entries plus one system opt-out, which keeps the opt-out in force for later readers.
  assert.equal(result.merged.consent.length, 3);
  const system = result.merged.consent[2];
  assert.equal(system.channel, 'email');
  assert.equal(system.granted, false);
  assert.equal(system.source, 'system');
});

test('an opt-out in the primary list beats a newer grant on the duplicate', () => {
  const result = run({
    primary: contact({
      consent: [
        { channel: 'sms', granted: false, at: '2026-01-10T00:00:00.000Z', source: 'reply STOP' },
        { channel: 'email', granted: true, at: '2026-01-01T00:00:00.000Z', source: 'form' },
      ],
    }),
    duplicate: dup({
      consent: [{ channel: 'sms', granted: true, at: '2026-06-01T00:00:00.000Z', source: 'form' }],
    }),
  });
  assert.equal(effectiveConsent(result.merged.consent).sms, false);
  // Other channels are unaffected by the opt-out.
  assert.equal(effectiveConsent(result.merged.consent).email, true);
});

test('cross-company merge is refused', () => {
  assert.deepEqual(run({ duplicate: dup({ companyId: OTHER_CO }) }), {
    ok: false,
    reason: 'cross_company',
  });
  assert.deepEqual(run({ primary: contact({ companyId: OTHER_CO }) }), {
    ok: false,
    reason: 'cross_company',
  });
});

test('merging a contact with itself is refused', () => {
  assert.deepEqual(run({ duplicate: dup({ id: 'c-primary' }) }), {
    ok: false,
    reason: 'same_contact',
  });
});

test('agent actors are refused, and so is an empty actor', () => {
  assert.deepEqual(run({ actorId: 'agent:desk-triage' }), { ok: false, reason: 'human_only' });
  assert.deepEqual(run({ actorId: '' }), { ok: false, reason: 'human_only' });
});

test('invalid company id is refused', () => {
  assert.deepEqual(run({ companyId: 'not-a-uuid' }), { ok: false, reason: 'invalid_company' });
});

test('audit entry records the merge', () => {
  const result = run();
  assert.deepEqual(result.audit, {
    action: 'contacts_merged',
    primaryId: 'c-primary',
    duplicateId: 'c-duplicate',
    actorId: 'user-42',
    at: NOW,
  });
});

test('inputs are not mutated', () => {
  const primary = contact({
    tags: ['vip'],
    email: null,
    consent: [{ channel: 'email', granted: true, at: '2026-01-01T00:00:00.000Z', source: 'form' }],
  });
  const duplicate = dup({
    email: 'dup@example.com',
    consent: [{ channel: 'email', granted: false, at: '2026-02-01T00:00:00.000Z', source: 'unsubscribe' }],
  });
  const snapshot = structuredClone({ primary, duplicate });

  const result = mergeContacts({ companyId: CO, primary, duplicate, actorId: 'user-42', now: NOW });
  assert.equal(result.ok, true);

  assert.deepEqual({ primary, duplicate }, snapshot);

  // Mutating the output must not reach the inputs either.
  result.merged.tags.push('new');
  result.merged.consent[0].granted = false;
  assert.deepEqual({ primary, duplicate }, snapshot);
});
