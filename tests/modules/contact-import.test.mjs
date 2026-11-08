// Contact CSV import and export (node:test). Pure functions only: no database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContactCsv, exportContactCsv } from '../../server/modules/comms/contact-import.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const OPTS = { companyId: CO, defaultCountryCode: '61' };
const EXPORT_OPTS = { companyId: CO, actorId: 'user-42', now: '2026-11-04T09:00:00.000Z', guard: () => true, audit: () => {} };

test('valid file: accepts rows and normalises email and phone', () => {
  const text = 'name,email,phone\nJane Doe,Jane@Example.com,+61 400 000 000\nSam,,0412 345 678\n';
  const result = parseContactCsv(text, OPTS);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.accepted, [
    { line: 2, companyId: CO, name: 'Jane Doe', email: 'jane@example.com', phone: '+61400000000' },
    { line: 3, companyId: CO, name: 'Sam', phone: '+61412345678' },
  ]);
});

test('valid file: header order and case do not matter, CRLF and blank lines are tolerated', () => {
  const text = 'Phone,Name,EMAIL\r\n+61400000001,Ann,ann@example.com\r\n\r\n,Bob,bob@example.com\r\n';
  const result = parseContactCsv(text, OPTS);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted.length, 2);
  assert.equal(result.accepted[0].phone, '+61400000001');
  assert.equal(result.accepted[1].name, 'Bob');
  assert.equal(result.accepted[1].line, 4);
});

test('quoted commas and doubled quotes stay inside one field', () => {
  const text = 'name,email\n"Smith, Jane","jane@example.com"\n"Jo ""JJ"" Lee",jj@example.com\n';
  const result = parseContactCsv(text, OPTS);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted[0].name, 'Smith, Jane');
  assert.equal(result.accepted[1].name, 'Jo "JJ" Lee');
});

test('quoted line break inside a name keeps the following row line number correct', () => {
  const text = 'name,email\n"Line one\nLine two",a@example.com\nBen,b@example.com\n';
  const result = parseContactCsv(text, OPTS);
  assert.deepEqual(result.rejected, []);
  assert.equal(result.accepted[0].name, 'Line one\nLine two');
  assert.equal(result.accepted[1].line, 4);
});

test('invalid rows are rejected with the right reason', () => {
  const text = [
    'name,email,phone',
    'No Contact,,',
    'Bad Mail,not-an-email,',
    'Bad Phone,,12345',
    'Bad Both,bad@example.com,abc',
    'Good,good@example.com,',
  ].join('\n');
  const result = parseContactCsv(text, OPTS);
  assert.deepEqual(result.rejected, [
    { line: 2, reason: 'missing_contact' },
    { line: 3, reason: 'invalid_email' },
    { line: 4, reason: 'invalid_phone' },
    { line: 5, reason: 'invalid_phone' },
  ]);
  assert.deepEqual(result.accepted.map((c) => c.name), ['Good']);
});

test('duplicates within the file are rejected, first occurrence wins', () => {
  const text = [
    'name,email,phone',
    'First,dup@example.com,+61400000002',
    'Same email,DUP@example.com,',
    'Same phone,,0400 000 002',
    'Unique,u@example.com,+61400000003',
  ].join('\n');
  const result = parseContactCsv(text, OPTS);
  assert.deepEqual(result.rejected, [
    { line: 3, reason: 'duplicate_in_file' },
    { line: 4, reason: 'duplicate_in_file' },
  ]);
  assert.deepEqual(result.accepted.map((c) => c.name), ['First', 'Unique']);
});

test('row limit rejects rows past maxRows', () => {
  const text = 'name,email\na,a@example.com\nb,b@example.com\nc,c@example.com\nd,d@example.com\n';
  const result = parseContactCsv(text, { companyId: CO, maxRows: 2 });
  assert.deepEqual(result.accepted.map((c) => c.name), ['a', 'b']);
  assert.deepEqual(result.rejected, [
    { line: 4, reason: 'row_limit' },
    { line: 5, reason: 'row_limit' },
  ]);
});

test('non-UUID companyId is refused with invalid_company', () => {
  const result = parseContactCsv('name,email\na,a@example.com\n', { companyId: 'not-a-uuid' });
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected, [{ line: 0, reason: 'invalid_company' }]);
});

test('header without a name column or without email and phone is refused', () => {
  assert.throws(() => parseContactCsv('email\na@example.com\n', OPTS), /name column/);
  assert.throws(() => parseContactCsv('name,address\nA,somewhere\n', OPTS), /email or phone/);
});

test('export writes the fixed header and escapes commas, quotes and line breaks', () => {
  const contacts = [
    { companyId: CO, name: 'Smith, Jane', email: 'jane@example.com', phone: null },
    { companyId: CO, name: 'Jo "JJ" Lee', email: null, phone: '+61400000000' },
    { companyId: CO, name: 'Line\nBreak', email: 'lb@example.com', phone: '' },
  ];
  const csv = exportContactCsv(contacts, EXPORT_OPTS);
  assert.equal(
    csv,
    'name,email,phone\n' +
      '"Smith, Jane",jane@example.com,\n' +
      '"Jo ""JJ"" Lee",,\'+61400000000\n' +
      '"Line\nBreak",lb@example.com,\n',
  );
});

test('export excludes contacts from another company', () => {
  const contacts = [
    { companyId: CO, name: 'Mine', email: 'mine@example.com' },
    { companyId: OTHER, name: 'Theirs', email: 'theirs@example.com' },
  ];
  const csv = exportContactCsv(contacts, EXPORT_OPTS);
  assert.equal(csv, 'name,email,phone\nMine,mine@example.com,\n');
  assert.ok(!csv.includes('Theirs'));
});

test('export prefixes formula-leading cells with a single quote', () => {
  const contacts = [
    { companyId: CO, name: '=HYPERLINK("http://x")', email: '+evil@example.com', phone: '-5' },
    { companyId: CO, name: '@SUM(A1)', email: 'safe@example.com', phone: '' },
    { companyId: CO, name: 'plain', email: 'a=b@example.com', phone: '' },
  ];
  const lines = exportContactCsv(contacts, EXPORT_OPTS).split('\n');
  assert.equal(lines[1], '"\'=HYPERLINK(""http://x"")",\'+evil@example.com,\'-5');
  assert.equal(lines[2], "'@SUM(A1),safe@example.com,");
  assert.equal(lines[3], 'plain,a=b@example.com,');
});
