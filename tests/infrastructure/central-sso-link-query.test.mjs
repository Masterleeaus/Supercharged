// Issue #197: fixture tests for the Central link lookup tenant boundary.
// A fake pool records SQL. No database, no Central values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeskCentralLinkQuery } from '../../server/infrastructure/central-sso/link-query.ts';
import { createDeskCentralAccountResolver } from '../../server/infrastructure/central-sso/account-resolver.ts';

const COMPANY_A = '00000000-0000-4000-8000-00000000000a';
const ISSUER = 'https://central.example.test/oidc';
const NOW = Date.parse('2026-11-15T10:00:00Z');

function fakePool({ rows = [], failOn = null } = {}) {
  const log = [];
  let released = 0;
  const client = {
    async query(text, values) {
      log.push({ text, values });
      if (failOn && text.includes(failOn)) throw new Error('db down: secret detail');
      if (text.includes('app_central_desk_resolve_link')) return { rows };
      return { rows: [] };
    },
    release() { released += 1; },
  };
  let connects = 0;
  return {
    pool: { async connect() { connects += 1; return client; } },
    log,
    connects: () => connects,
    released: () => released,
  };
}

test('the link lookup refuses a pool that cannot connect', () => {
  assert.throws(() => createDeskCentralLinkQuery({}), TypeError);
  assert.throws(() => createDeskCentralLinkQuery(undefined), TypeError);
});

test('invalid company ids return no rows and never touch the pool', async () => {
  const f = fakePool({ rows: [{ user_id: 'u' }] });
  const lookup = createDeskCentralLinkQuery(f.pool);
  for (const bad of ['', 'not-a-uuid', null, undefined, 12, ['x']]) {
    assert.deepEqual(await lookup(ISSUER, 'sub-1', bad), []);
  }
  assert.equal(f.connects(), 0);
});

test('a non-string or control-character subject returns no rows and never touches the pool', async () => {
  const f = fakePool({ rows: [{ user_id: 'u' }] });
  const lookup = createDeskCentralLinkQuery(f.pool);
  assert.deepEqual(await lookup(ISSUER, 42, COMPANY_A), []);
  assert.deepEqual(await lookup(ISSUER, 'a\u0000b', COMPANY_A), []);
  assert.deepEqual(await lookup(ISSUER, 's'.repeat(257), COMPANY_A), []);
  assert.deepEqual(await lookup(ISSUER, '', COMPANY_A), []);
  assert.equal(f.connects(), 0);
});

test('an over-long issuer returns no rows and never touches the pool', async () => {
  const f = fakePool({ rows: [{ user_id: 'u' }] });
  const lookup = createDeskCentralLinkQuery(f.pool);
  assert.deepEqual(await lookup('i'.repeat(257), 'sub-1', COMPANY_A), []);
  assert.equal(f.connects(), 0);
});

test('a valid lookup runs inside the tenant transaction with the company bound as a parameter', async () => {
  const f = fakePool({ rows: [{ user_id: 'u1', company_id: COMPANY_A, role: 'admin', revision: 3, is_active: true }] });
  const lookup = createDeskCentralLinkQuery(f.pool);
  const rows = await lookup(ISSUER, 'sub-1', COMPANY_A);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].company_id, COMPANY_A);

  const texts = f.log.map((e) => e.text);
  assert.equal(texts[0], 'BEGIN');
  assert.match(texts[1], /^SET LOCAL ROLE "desk_app"$/);
  assert.match(texts[2], /set_config/);
  assert.deepEqual(f.log[2].values, ['app.company_id', COMPANY_A]);
  const call = f.log.find((e) => e.text.includes('app_central_desk_resolve_link'));
  assert.deepEqual(call.values, [ISSUER, 'sub-1', COMPANY_A]);
  assert.equal(texts.at(-1), 'COMMIT');
  assert.equal(f.released(), 1);
});

test('subject and issuer values are bound, never interpolated into SQL', async () => {
  const f = fakePool({ rows: [] });
  const lookup = createDeskCentralLinkQuery(f.pool);
  // No whitespace, so the subject passes the shape check and reaches the bound parameter.
  const evil = "x';DROP-TABLE-users--";
  await lookup(ISSUER, evil, COMPANY_A);
  const call = f.log.find((e) => e.text.includes('app_central_desk_resolve_link'));
  assert.ok(call, 'lookup should reach the database for a well-shaped subject');
  assert.equal(call.text.includes('DROP'), false);
  assert.equal(call.values[1], evil);
});

test('a database error returns no rows and rolls back instead of leaking the error', async () => {
  const f = fakePool({ failOn: 'app_central_desk_resolve_link' });
  const lookup = createDeskCentralLinkQuery(f.pool);
  assert.deepEqual(await lookup(ISSUER, 'sub-1', COMPANY_A), []);
  assert.equal(f.log.some((e) => e.text === 'ROLLBACK'), true);
  assert.equal(f.log.some((e) => e.text === 'COMMIT'), false);
  assert.equal(f.released(), 1);
});

test('a link row for another company is refused by the account resolver built on this lookup', async () => {
  // Composition check: even if a link row names another company, the resolver must return null.
  const otherCompany = '00000000-0000-4000-8000-00000000000b';
  const f = fakePool({ rows: [{ user_id: 'u1', company_id: otherCompany, role: 'admin', revision: 1, is_active: true }] });
  const resolve = createDeskCentralAccountResolver({
    authoriseCentral: async () => true,
    queryLink: createDeskCentralLinkQuery(f.pool),
    resolveCompanyBinding: async (companyId) => companyId,
    clock: () => NOW,
  });
  const account = await resolve({
    issuer: ISSUER,
    subject: 'sub-1',
    companyId: COMPANY_A,
    audience: 'supercharged',
    authority: 'central-verified',
    verifiedAt: new Date(NOW).toISOString(),
  });
  assert.equal(account, null);
});

test('a matching single active link row resolves to that company only', async () => {
  const f = fakePool({ rows: [{ user_id: 'u1', company_id: COMPANY_A, role: 'admin', revision: 2, is_active: true }] });
  const resolve = createDeskCentralAccountResolver({
    authoriseCentral: async () => true,
    queryLink: createDeskCentralLinkQuery(f.pool),
    resolveCompanyBinding: async (companyId) => companyId,
    clock: () => NOW,
  });
  const account = await resolve({
    issuer: ISSUER,
    subject: 'sub-1',
    companyId: COMPANY_A,
    audience: 'supercharged',
    authority: 'central-verified',
    verifiedAt: new Date(NOW).toISOString(),
  });
  assert.deepEqual(account, { userId: 'u1', companyId: COMPANY_A, role: 'admin', revision: 2 });
});
