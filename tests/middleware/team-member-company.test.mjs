import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Register the @shared/* alias and extensionless resolver before loading TS sources.
await import('../engines/loader-hook.mjs');

// server/db.ts throws at import without DATABASE_URL. The pool does not connect
// until a query runs, and every query in these tests is replaced below.
process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:1/test';

const { db } = await import('../../server/db.ts');
const { lookupParentCompanyId } = await import('../../server/middleware/team-member-company.ts');
const { PgDialect } = await import('drizzle-orm/pg-core');

// No executor is injected into lookupParentCompanyId. The smallest seam is the
// exported drizzle `db` instance: its `select` method is replaced for the
// duration of each test and restored afterwards.
const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const PARENT_ID = 'parent-user-id-123';

const dialect = new PgDialect();

function withFakeSelect(behaviour, fn) {
  const original = db.select;
  const calls = [];
  db.select = (fields) => {
    const call = { fields, from: null, where: null, limit: null };
    calls.push(call);
    const builder = {
      from(table) { call.from = table; return builder; },
      where(cond) { call.where = cond; return builder; },
      limit(n) {
        call.limit = n;
        return behaviour(call);
      },
    };
    return builder;
  };
  return Promise.resolve()
    .then(() => fn(calls))
    .finally(() => { db.select = original; });
}

test('parent with a UUID company id returns that id', async () => {
  await withFakeSelect(() => Promise.resolve([{ companyId: UUID_A }]), async () => {
    assert.equal(await lookupParentCompanyId(PARENT_ID), UUID_A);
  });
});

test('parent with a non-UUID company id returns undefined (fail closed)', async () => {
  for (const bad of ['not-a-uuid', '', '11111111-2222-4333-8444-55555555555', 42, null, { id: UUID_A }]) {
    await withFakeSelect(() => Promise.resolve([{ companyId: bad }]), async () => {
      assert.equal(await lookupParentCompanyId(PARENT_ID), undefined, `value ${JSON.stringify(bad)}`);
    });
  }
});

test('parent with no company returns undefined', async () => {
  await withFakeSelect(() => Promise.resolve([{ companyId: null }]), async () => {
    assert.equal(await lookupParentCompanyId(PARENT_ID), undefined);
  });
  await withFakeSelect(() => Promise.resolve([{}]), async () => {
    assert.equal(await lookupParentCompanyId(PARENT_ID), undefined);
  });
  await withFakeSelect(() => Promise.resolve([]), async () => {
    assert.equal(await lookupParentCompanyId(PARENT_ID), undefined);
  });
});

test('query error returns undefined and does not throw', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    await withFakeSelect(() => Promise.reject(new Error('connection refused')), async () => {
      assert.equal(await lookupParentCompanyId(PARENT_ID), undefined);
    });
  } finally {
    console.error = originalError;
  }
});

test('lookup asks only for the parent row by the parent id', async () => {
  await withFakeSelect(() => Promise.resolve([{ companyId: UUID_A }]), async (calls) => {
    await lookupParentCompanyId(PARENT_ID);
    assert.equal(calls.length, 1, 'exactly one select');
    const call = calls[0];

    // Only the companyId column is selected.
    assert.deepEqual(Object.keys(call.fields), ['companyId']);
    assert.equal(call.limit, 1);

    const { sql, params } = dialect.sqlToQuery(call.where);
    assert.match(sql, /"users"\."id"/);
    assert.deepEqual(params, [PARENT_ID], 'the only parameter is the parent id');
    assert.ok(!params.includes(UUID_B));
    assert.ok(!sql.includes(PARENT_ID), 'the id is bound as a parameter, not inlined');
  });
});

test('static: hybrid-auth team branch takes companyId only from lookupParentCompanyId', () => {
  const src = readFileSync(new URL('../../server/middleware/hybrid-auth.ts', import.meta.url), 'utf8');

  // Slice out the user team branch of each handler: from validateUserTeamSession
  // up to the admin team branch.
  const starts = [...src.matchAll(/const teamMember = await validateUserTeamSession\(token\);/g)].map((m) => m.index);
  assert.equal(starts.length, 2, 'two team-member branches (authenticateHybrid and optionalHybridAuth)');

  for (const start of starts) {
    const adminStart = src.indexOf('await validateAdminTeamSession(token)', start);
    assert.ok(adminStart > start, 'admin branch follows the user branch');
    const branch = src.slice(start, adminStart);

    // Exactly one assignment of parentCompanyId, and it comes from the lookup.
    const assigns = [...branch.matchAll(/\bparentCompanyId\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
    assert.deepEqual(assigns, ['await lookupParentCompanyId(teamMember.userId.toString())']);

    // Every companyId property in the branch is the parentCompanyId variable.
    const props = [...branch.matchAll(/\bcompanyId\s*[:=]\s*([^,\n}]+)/g)].map((m) => m[1].trim());
    assert.ok(props.length >= 1, 'branch sets companyId');
    for (const p of props) assert.equal(p, 'parentCompanyId', `companyId source "${p}"`);

    // No other source of company id in the branch (claims, request, params, body, headers).
    assert.doesNotMatch(branch, /companyIdFromClaims|decoded\.companyId|req\.body|req\.query|req\.params|req\.headers/);
  }
});
