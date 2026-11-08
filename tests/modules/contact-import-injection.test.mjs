// CSV formula-injection neutralisation for contact export, plus row-level rejection of invalid emails
// on import (node:test). Pure functions only: no database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseContactCsv, exportContactCsv } from '../../server/modules/comms/contact-import.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const OPTS = { companyId: CO, defaultCountryCode: '61' };
const EXPORT_OPTS = { companyId: CO, actorId: 'user-42', now: '2026-11-04T09:00:00.000Z', guard: () => true, audit: () => {} };

function exportName(name) {
  return exportContactCsv([{ companyId: CO, name, email: '', phone: '' }], EXPORT_OPTS).split('\n')[1];
}

test('each dangerous leading character is neutralised with a single leading quote', () => {
  assert.equal(exportName('=X'), "'=X,,");
  assert.equal(exportName('+X'), "'+X,,");
  assert.equal(exportName('-X'), "'-X,,");
  assert.equal(exportName('@X'), "'@X,,");
});

test('a leading tab is neutralised', () => {
  assert.equal(exportName('\tX'), "'\tX,,");
});

test('a leading carriage return is neutralised and the cell is quoted', () => {
  assert.equal(exportName('\rX'), `"'\rX",,`);
});

test('neutralisation applies to email and phone cells too', () => {
  const csv = exportContactCsv(
    [{ companyId: CO, name: 'Ann', email: '=cmd@example.com', phone: '\t+61400000000' }],
    EXPORT_OPTS,
  );
  assert.equal(csv.split('\n')[1], "Ann,'=cmd@example.com,'\t+61400000000");
});

test('normal values are unchanged', () => {
  const csv = exportContactCsv(
    [
      { companyId: CO, name: 'Jane Doe', email: 'jane@example.com', phone: '' },
      { companyId: CO, name: 'Mid=Dash-At@Name+Plus', email: 'a-b@example.com', phone: '' },
      { companyId: CO, name: 'O\'Brien', email: 'ob@example.com', phone: '' },
    ],
    EXPORT_OPTS,
  );
  assert.equal(
    csv,
    'name,email,phone\n' +
      'Jane Doe,jane@example.com,\n' +
      'Mid=Dash-At@Name+Plus,a-b@example.com,\n' +
      "O'Brien,ob@example.com,\n",
  );
});

test('an invalid email is rejected at row level with invalid_email and does not stop other rows', () => {
  const text = 'name,email\nBroken,not-an-email\nFine,fine@example.com\n';
  const result = parseContactCsv(text, OPTS);
  assert.deepEqual(result.rejected, [{ line: 2, reason: 'invalid_email' }]);
  assert.equal(result.accepted.length, 1);
  assert.equal(result.accepted[0].line, 3);
  assert.equal(result.accepted[0].email, 'fine@example.com');
});
