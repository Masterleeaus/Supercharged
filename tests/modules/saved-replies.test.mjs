// Saved replies store tests (node:test). Pure in-memory: no database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSavedReplyStore } from '../../server/modules/comms/saved-replies.ts';

const COMPANY_A = '11111111-1111-4111-8111-111111111111';
const COMPANY_B = '22222222-2222-4222-8222-222222222222';

const base = (overrides = {}) => ({
  title: 'Booking confirmed',
  body: 'Thanks for booking. We will see you soon.',
  channel: 'email',
  ...overrides,
});

test('create stores a reply and list returns it for the same company', () => {
  const store = createSavedReplyStore();
  const made = store.create(COMPANY_A, base());
  assert.equal(made.ok, true);
  assert.equal(made.reply.companyId, COMPANY_A);
  assert.equal(made.reply.title, 'Booking confirmed');
  assert.equal(made.reply.channel, 'email');
  assert.deepEqual(made.reply.variables, []);

  const listed = store.list(COMPANY_A);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, made.reply.id);
});

test('list with a channel filter includes channel "any" replies', () => {
  const store = createSavedReplyStore();
  store.create(COMPANY_A, base({ title: 'Email only', channel: 'email' }));
  store.create(COMPANY_A, base({ title: 'SMS only', channel: 'sms' }));
  store.create(COMPANY_A, base({ title: 'Anywhere', channel: 'any' }));

  const emailTitles = store.list(COMPANY_A, { channel: 'email' }).map((r) => r.title).sort();
  assert.deepEqual(emailTitles, ['Anywhere', 'Email only']);

  const smsTitles = store.list(COMPANY_A, { channel: 'sms' }).map((r) => r.title).sort();
  assert.deepEqual(smsTitles, ['Anywhere', 'SMS only']);
});

test('another company cannot update or remove a reply', () => {
  const store = createSavedReplyStore();
  const made = store.create(COMPANY_A, base());
  assert.equal(made.ok, true);

  const upd = store.update(COMPANY_B, made.reply.id, { title: 'Hijacked' });
  assert.deepEqual(upd, { ok: false, reason: 'not_found', message: 'saved reply not found' });

  const rem = store.remove(COMPANY_B, made.reply.id);
  assert.equal(rem.ok, false);
  assert.equal(rem.reason, 'not_found');

  // The owner still sees the untouched reply.
  const [still] = store.list(COMPANY_A);
  assert.equal(still.title, 'Booking confirmed');
  assert.equal(store.list(COMPANY_B).length, 0);
});

test('owner can update and remove its own reply', () => {
  const store = createSavedReplyStore();
  const made = store.create(COMPANY_A, base());
  const upd = store.update(COMPANY_A, made.reply.id, { title: 'Renamed', channel: 'any' });
  assert.equal(upd.ok, true);
  assert.equal(upd.reply.title, 'Renamed');
  assert.equal(upd.reply.channel, 'any');

  assert.deepEqual(store.remove(COMPANY_A, made.reply.id), { ok: true });
  assert.equal(store.list(COMPANY_A).length, 0);
});

test('invalid input is refused with invalid_input and names the field', () => {
  const store = createSavedReplyStore();
  const cases = [
    [base({ title: '' }), 'title'],
    [base({ title: 'x'.repeat(81) }), 'title'],
    [base({ body: '' }), 'body'],
    [base({ body: 'x'.repeat(1601) }), 'body'],
    [base({ channel: 'fax' }), 'channel'],
    [base({ variables: 'name' }), 'variables'],
  ];
  for (const [input, field] of cases) {
    const r = store.create(COMPANY_A, input);
    assert.equal(r.ok, false, `expected refusal for ${field}`);
    assert.equal(r.reason, 'invalid_input');
    assert.match(r.message, new RegExp(field));
  }
  assert.equal(store.list(COMPANY_A).length, 0);
});

test('a non-UUID company id is refused', () => {
  const store = createSavedReplyStore();
  const r = store.create('not-a-uuid', base());
  assert.deepEqual(r, { ok: false, reason: 'invalid_company', message: 'companyId must be a UUID' });
  assert.deepEqual(store.list('not-a-uuid'), []);
});

test('an undeclared {{placeholder}} is refused, a declared one is accepted', () => {
  const store = createSavedReplyStore();
  const refused = store.create(COMPANY_A, base({ body: 'Hi {{first_name}}, see you.' }));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'invalid_input');
  assert.match(refused.message, /first_name/);

  const accepted = store.create(
    COMPANY_A,
    base({ body: 'Hi {{first_name}}, see you.', variables: ['first_name'] }),
  );
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.reply.variables, ['first_name']);
});

test('an unclosed {{ is refused even when no name is declared', () => {
  const store = createSavedReplyStore();
  const r = store.create(COMPANY_A, base({ body: 'Hello {{ there' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_input');
});

test('update re-validates placeholders against the merged variables', () => {
  const store = createSavedReplyStore();
  const made = store.create(COMPANY_A, base({ body: 'Hi {{name}}', variables: ['name'] }));
  const bad = store.update(COMPANY_A, made.reply.id, { body: 'Hi {{city}}' });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'invalid_input');

  const good = store.update(COMPANY_A, made.reply.id, { body: 'Hi {{city}}', variables: ['city'] });
  assert.equal(good.ok, true);
});
