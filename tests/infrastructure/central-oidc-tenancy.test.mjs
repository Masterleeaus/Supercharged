// Issue #195: the company comes only from a server-verified Central selection, and a user with
// two memberships sees only the company that selection names. Central's handoff that produces
// the selection is not in this repository yet, so these tests pass the existing
// VerifiedDeskCentralSelection shape directly into the existing account resolver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeskCentralAccountResolver } from '../../server/infrastructure/central-sso/account-resolver.ts';
import { isVerifiedDeskCentralSelection } from '../../server/infrastructure/central-sso/selection-contract.ts';
import { ORIGIN, COMPANY_A, COMPANY_B } from './central-oidc-fixtures.mjs';

const NOW = Date.parse('2026-11-15T10:00:00Z');
const clock = () => NOW;
const SUBJECT = 'user-subject-1';
const issuer = `${ORIGIN}/oidc`;

function selectionFor(companyId) {
  return {
    issuer,
    subject: SUBJECT,
    companyId,
    audience: 'supercharged',
    authority: 'central-verified',
    verifiedAt: new Date(NOW).toISOString(),
  };
}

// One Central identity with two memberships (two companies), each its own local link row.
function linkTable(rows) {
  return async (iss, subject, companyId) =>
    rows.filter((r) => r.issuer === iss && r.subject === subject && r.company_id === companyId)
      .map(({ issuer: _i, subject: _s, ...row }) => row);
}

const rows = [
  { issuer, subject: SUBJECT, company_id: COMPANY_A, user_id: 'local-user-a', role: 'owner', revision: 1, is_active: true },
  { issuer, subject: SUBJECT, company_id: COMPANY_B, user_id: 'local-user-b', role: 'member', revision: 2, is_active: true },
];

function resolverFor(table, { authorised = true, bindings = { [COMPANY_A]: COMPANY_A, [COMPANY_B]: COMPANY_B } } = {}) {
  const calls = [];
  const resolve = createDeskCentralAccountResolver({
    authoriseCentral: async () => authorised,
    queryLink: async (...args) => { calls.push(args); return table(...args); },
    resolveCompanyBinding: async (companyId) => bindings[companyId] ?? null,
    clock,
  });
  return { resolve, calls };
}

test('the selection fixture is a valid verified selection', () => {
  assert.equal(isVerifiedDeskCentralSelection(selectionFor(COMPANY_A), NOW), true);
});

test('a user with two memberships gets only the company the verified selection names', async () => {
  const { resolve, calls } = resolverFor(linkTable(rows));
  const a = await resolve(selectionFor(COMPANY_A));
  const b = await resolve(selectionFor(COMPANY_B));
  assert.deepEqual(a, { userId: 'local-user-a', companyId: COMPANY_A, role: 'owner', revision: 1 });
  assert.deepEqual(b, { userId: 'local-user-b', companyId: COMPANY_B, role: 'member', revision: 2 });
  assert.deepEqual(calls.map((c) => c[2]), [COMPANY_A, COMPANY_B], 'every lookup is scoped by the verified company');
});

test('a verified company with no membership is refused', async () => {
  const outsider = '00000000-0000-4000-8000-0000000000cc';
  const { resolve } = resolverFor(linkTable(rows), { bindings: { [outsider]: outsider } });
  assert.equal(await resolve(selectionFor(outsider)), null);
});

test('a revoked membership loses access', async () => {
  const revoked = rows.map((r) => (r.company_id === COMPANY_B ? { ...r, is_active: false } : r));
  const { resolve } = resolverFor(linkTable(revoked));
  assert.equal(await resolve(selectionFor(COMPANY_B)), null);
  assert.notEqual(await resolve(selectionFor(COMPANY_A)), null, 'other company stays available');
});

test('a Central access denial blocks the company even with an active link', async () => {
  const { resolve } = resolverFor(linkTable(rows), { authorised: false });
  assert.equal(await resolve(selectionFor(COMPANY_A)), null);
});

test('a link row that names another company is refused', async () => {
  const mismatched = async () => [{ user_id: 'local-user-b', company_id: COMPANY_B, role: 'member', revision: 2, is_active: true }];
  const { resolve } = resolverFor(mismatched);
  assert.equal(await resolve(selectionFor(COMPANY_A)), null);
});
