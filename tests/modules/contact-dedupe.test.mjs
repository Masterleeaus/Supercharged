// Contact duplicate detection (node:test). Pure functions only: no database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmail,
  normalizePhone,
  findDuplicateGroups,
} from '../../server/modules/comms/contact-dedupe.ts';

const CO_A = '11111111-1111-4111-8111-111111111111';
const CO_B = '22222222-2222-4222-8222-222222222222';

test('normalizeEmail lowercases and trims, rejects non-emails', () => {
  assert.equal(normalizeEmail('  Jane.Doe@Example.COM \n'), 'jane.doe@example.com');
  assert.equal(normalizeEmail('not-an-email'), undefined);
  assert.equal(normalizeEmail('a b@example.com'), undefined);
  assert.equal(normalizeEmail('   '), undefined);
  assert.equal(normalizeEmail(undefined), undefined);
});

test('normalizePhone strips formatting and keeps a leading plus', () => {
  assert.equal(normalizePhone('+61 412-345-678'), '+61412345678');
  assert.equal(normalizePhone('+1 (415) 555-0100'), '+14155550100');
  assert.equal(normalizePhone('  +61 412 345 678 '), '+61412345678');
});

test('normalizePhone accepts a leading 0 only with a default country code', () => {
  assert.equal(normalizePhone('0412 345 678'), undefined);
  assert.equal(normalizePhone('0412 345 678', { defaultCountryCode: '61' }), '+61412345678');
  assert.equal(normalizePhone('(04) 1234-5678', { defaultCountryCode: '+61' }), '+61412345678');
});

test('normalizePhone rejects values that cannot be E.164', () => {
  assert.equal(normalizePhone('12345'), undefined);
  assert.equal(normalizePhone('+0412345678'), undefined);
  assert.equal(normalizePhone('call me'), undefined);
  assert.equal(normalizePhone('+61 412 abc 678'), undefined);
  assert.equal(normalizePhone(''), undefined);
  assert.equal(normalizePhone(null), undefined);
});

test('email case and whitespace differences group together', () => {
  const groups = findDuplicateGroups(
    [
      { id: 'c1', companyId: CO_A, email: 'Jane@Example.com' },
      { id: 'c2', companyId: CO_A, email: '  jane@example.com ' },
      { id: 'c3', companyId: CO_A, email: 'someone.else@example.com' },
    ],
    { companyId: CO_A },
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ['c1', 'c2']);
  assert.deepEqual(groups[0].keys, [{ kind: 'email', value: 'jane@example.com' }]);
});

test('phone formatting differences group together', () => {
  const groups = findDuplicateGroups(
    [
      { id: 'p1', companyId: CO_A, phone: '+61 412 345 678' },
      { id: 'p2', companyId: CO_A, phone: '+61-412-345-678' },
      { id: 'p3', companyId: CO_A, phone: '(0412) 345678' },
    ],
    { companyId: CO_A, defaultCountryCode: '61' },
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ['p1', 'p2', 'p3']);
  assert.deepEqual(groups[0].keys, [{ kind: 'phone', value: '+61412345678' }]);
});

test('cross-company contacts are never grouped', () => {
  const contacts = [
    { id: 'a1', companyId: CO_A, email: 'shared@example.com', phone: '+61412345678' },
    { id: 'b1', companyId: CO_B, email: 'shared@example.com', phone: '+61412345678' },
    { id: 'b2', companyId: CO_B, email: 'shared@example.com' },
  ];
  assert.deepEqual(findDuplicateGroups(contacts, { companyId: CO_A }), []);

  const groupsB = findDuplicateGroups(contacts, { companyId: CO_B });
  assert.equal(groupsB.length, 1);
  assert.deepEqual(groupsB[0].ids, ['b1', 'b2']);
  assert.ok(!groupsB[0].ids.includes('a1'));
});

test('grouping is transitive across email and phone keys', () => {
  const groups = findDuplicateGroups(
    [
      { id: 'A', companyId: CO_A, email: 'a@example.com', phone: '+61400000001' },
      { id: 'B', companyId: CO_A, email: 'a@example.com', phone: '+61400000002' },
      { id: 'C', companyId: CO_A, email: 'c@example.com', phone: '+61 400 000 002' },
      { id: 'D', companyId: CO_A, email: 'd@example.com', phone: '+61400000009' },
    ],
    { companyId: CO_A },
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ['A', 'B', 'C']);
  assert.deepEqual(groups[0].keys, [
    { kind: 'email', value: 'a@example.com' },
    { kind: 'phone', value: '+61400000002' },
  ]);
});

test('a single contact produces no group', () => {
  assert.deepEqual(
    findDuplicateGroups([{ id: 'solo', companyId: CO_A, email: 'x@example.com', phone: '+61400000001' }], {
      companyId: CO_A,
    }),
    [],
  );
  assert.deepEqual(findDuplicateGroups([], { companyId: CO_A }), []);
});

test('invalid email and phone values are ignored, not grouped on garbage', () => {
  const groups = findDuplicateGroups(
    [
      { id: 'g1', companyId: CO_A, email: 'nope', phone: 'call me' },
      { id: 'g2', companyId: CO_A, email: 'nope', phone: 'call me' },
      { id: 'g3', companyId: CO_A, email: '', phone: '12345' },
      { id: 'g4', companyId: CO_A, email: null, phone: undefined },
      { id: 'g5', companyId: CO_A, email: 'ok@example.com' },
    ],
    { companyId: CO_A },
  );
  assert.deepEqual(groups, []);
});

test('a contact with an invalid email still groups on its valid phone', () => {
  const groups = findDuplicateGroups(
    [
      { id: 'h1', companyId: CO_A, email: 'broken@', phone: '+61400000005' },
      { id: 'h2', companyId: CO_A, email: 'other', phone: '+61 400 000 005' },
    ],
    { companyId: CO_A },
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].ids, ['h1', 'h2']);
  assert.deepEqual(groups[0].keys, [{ kind: 'phone', value: '+61400000005' }]);
});

test('multiple independent groups are returned separately', () => {
  const groups = findDuplicateGroups(
    [
      { id: 'x1', companyId: CO_A, email: 'one@example.com' },
      { id: 'y1', companyId: CO_A, email: 'two@example.com' },
      { id: 'x2', companyId: CO_A, email: 'ONE@example.com' },
      { id: 'y2', companyId: CO_A, email: 'two@example.com ' },
    ],
    { companyId: CO_A },
  );
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.ids), [['x1', 'x2'], ['y1', 'y2']]);
});
