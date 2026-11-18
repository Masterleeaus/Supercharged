import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionCompany } from '../../server/infrastructure/database/session-company.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

test('exactly one membership resolves to that company', () => {
  assert.equal(resolveSessionCompany([A]), A);
});

test('no membership fails closed', () => {
  assert.equal(resolveSessionCompany([]), null);
  assert.equal(resolveSessionCompany([undefined, null]), null);
});

test('two distinct memberships are ambiguous and fail closed', () => {
  assert.equal(resolveSessionCompany([A, B]), null);
  assert.equal(resolveSessionCompany([B, A, A]), null);
});

test('the same company listed twice, in any letter case, still resolves once', () => {
  assert.equal(resolveSessionCompany([A, A.toUpperCase()]), A);
});

test('malformed ids are ignored and cannot widen the company set', () => {
  assert.equal(resolveSessionCompany([A, 'not-a-uuid']), A);
  assert.equal(resolveSessionCompany([A, B, 'x']), null);
  assert.equal(resolveSessionCompany(['', 42, {}]), null);
});

test('accepts any iterable, such as a generator from pg rows', () => {
  const rows = [{ company_id: A }, { company_id: B }];
  assert.equal(resolveSessionCompany(rows.slice(0, 1).map((r) => r.company_id).values()), A);
  assert.equal(resolveSessionCompany(rows.map((r) => r.company_id).values()), null);
});
