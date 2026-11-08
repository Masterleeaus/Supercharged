import test from 'node:test';
import assert from 'node:assert/strict';
import { withTenant, TenantContextError } from '../../server/infrastructure/database/tenant-context.ts';
import { requireCompanyScope, getCompanyScope, CompanyScopeError } from '../../server/middleware/company-scope.ts';

const COMPANY = '6f1c2a3e-9b7d-4e8f-a1b2-c3d4e5f60718';
const OTHER = '0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d';

/** Fake pg pool. Records every query per connection and every release call. */
function fakePool({ failOn = null } = {}) {
  const queries = [];
  const releases = [];
  let connects = 0;
  let clientId = 0;
  const pool = {
    async connect() {
      connects += 1;
      const id = ++clientId;
      return {
        async query(text, values) {
          queries.push({ client: id, text, values });
          if (failOn && failOn(text)) throw new Error(`fake failure on: ${text}`);
          return { rows: [] };
        },
        release(err) {
          releases.push({ client: id, err });
        },
      };
    },
  };
  return {
    pool,
    queries,
    releases,
    get connects() {
      return connects;
    },
  };
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('withTenant runs BEGIN, SET LOCAL ROLE, set_config, fn, COMMIT in that order', async () => {
  const fp = fakePool();
  const result = await withTenant(fp.pool, COMPANY, async (client) => {
    await client.query('SELECT 1');
    return 'done';
  });

  assert.equal(result, 'done');
  const texts = fp.queries.map((q) => q.text);
  assert.deepEqual(texts, [
    'BEGIN',
    'SET LOCAL ROLE "desk_app"',
    'SELECT set_config($1, $2, true)',
    'SELECT 1',
    'COMMIT',
  ]);
  // Every statement ran on the same pinned connection.
  assert.equal(new Set(fp.queries.map((q) => q.client)).size, 1);
  assert.equal(fp.releases.length, 1);
  assert.equal(fp.releases[0].err, undefined);
});

test('company id is passed as a bind parameter, never interpolated into SQL', async () => {
  const fp = fakePool();
  await withTenant(fp.pool, COMPANY, async () => null);

  const setConfig = fp.queries.find((q) => q.text.includes('set_config'));
  assert.ok(setConfig, 'set_config query was issued');
  assert.equal(setConfig.text, 'SELECT set_config($1, $2, true)');
  assert.deepEqual(setConfig.values, ['app.company_id', COMPANY]);
  assert.equal(setConfig.text.includes(COMPANY), false);
  // Transaction-local: the third argument is literally true.
  assert.match(setConfig.text, /, true\)$/);
});

test('custom app role is accepted and quoted; invalid role is rejected before connecting', async () => {
  const ok = fakePool();
  await withTenant(ok.pool, COMPANY, async () => null, { appRole: 'desk_runtime' });
  assert.equal(ok.queries[1].text, 'SET LOCAL ROLE "desk_runtime"');

  const bad = fakePool();
  await assert.rejects(
    withTenant(bad.pool, COMPANY, async () => null, { appRole: 'desk_app"; DROP TABLE users; --' }),
    TenantContextError,
  );
  assert.equal(bad.connects, 0);
  assert.equal(bad.queries.length, 0);
});

test('empty, missing and malformed company ids are rejected before any connection or query', async () => {
  const invalid = [
    '',
    '   ',
    null,
    undefined,
    123,
    {},
    ['6f1c2a3e-9b7d-4e8f-a1b2-c3d4e5f60718'],
    'not-a-uuid',
    '6f1c2a3e9b7d4e8fa1b2c3d4e5f60718', // no hyphens
    ' 6f1c2a3e-9b7d-4e8f-a1b2-c3d4e5f60718', // leading space
    "6f1c2a3e-9b7d-4e8f-a1b2-c3d4e5f60718'; DROP TABLE users; --",
  ];

  for (const value of invalid) {
    const fp = fakePool();
    await assert.rejects(
      withTenant(fp.pool, value, async () => 'should not run'),
      TenantContextError,
      `expected rejection for ${JSON.stringify(value)}`,
    );
    assert.equal(fp.connects, 0, `no connection for ${JSON.stringify(value)}`);
    assert.equal(fp.queries.length, 0, `no query for ${JSON.stringify(value)}`);
  }
});

test('fn is not called when the company id is invalid', async () => {
  const fp = fakePool();
  let called = false;
  await assert.rejects(
    withTenant(fp.pool, '', async () => {
      called = true;
    }),
    TenantContextError,
  );
  assert.equal(called, false);
});

test('a thrown error inside fn triggers ROLLBACK, no COMMIT, and rethrows the same error', async () => {
  const fp = fakePool();
  const boom = new Error('boom');
  await assert.rejects(
    withTenant(fp.pool, COMPANY, async (client) => {
      await client.query('INSERT INTO t VALUES (1)');
      throw boom;
    }),
    (err) => err === boom,
  );

  const texts = fp.queries.map((q) => q.text);
  assert.ok(texts.includes('ROLLBACK'), 'ROLLBACK issued');
  assert.equal(texts.includes('COMMIT'), false, 'no COMMIT after failure');
  assert.equal(texts.at(-1), 'ROLLBACK');
  // Clean rollback returns the connection to the pool.
  assert.equal(fp.releases.length, 1);
  assert.equal(fp.releases[0].err, undefined);
});

test('a failing query inside the transaction rolls back and releases the connection', async () => {
  const fp = fakePool({ failOn: (text) => text === 'SELECT broken' });
  await assert.rejects(
    withTenant(fp.pool, COMPANY, async (client) => {
      await client.query('SELECT broken');
    }),
    /fake failure/,
  );
  assert.equal(fp.queries.at(-1).text, 'ROLLBACK');
  assert.equal(fp.releases.length, 1);
});

test('when ROLLBACK itself fails, the original error is kept and the connection is destroyed', async () => {
  const fp = fakePool({ failOn: (text) => text === 'ROLLBACK' });
  const boom = new Error('original');
  await assert.rejects(
    withTenant(fp.pool, COMPANY, async () => {
      throw boom;
    }),
    (err) => err === boom,
  );
  assert.equal(fp.releases.length, 1);
  assert.ok(fp.releases[0].err instanceof Error, 'connection released with an error so pg destroys it');
});

test('middleware rejects a request with no company id on req.user with 403 and does not call next', () => {
  const mw = requireCompanyScope();
  const req = { user: { id: 'u1', role: 'user' } };
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => {
    nextCalled = true;
  });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('middleware ignores company ids sent in body, query and params', () => {
  const mw = requireCompanyScope();
  const req = {
    user: { id: 'u1', role: 'user' },
    body: { company_id: COMPANY },
    query: { company_id: COMPANY },
    params: { company_id: COMPANY },
    headers: { 'x-company-id': COMPANY },
  };
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => {
    nextCalled = true;
  });
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
});

test('middleware rejects an invalid company id on req.user', () => {
  const mw = requireCompanyScope();
  for (const value of ['', 'nope', null, 42]) {
    const res = fakeRes();
    let nextCalled = false;
    mw({ user: { companyId: value } }, res, () => {
      nextCalled = true;
    });
    assert.equal(res.statusCode, 403, `403 for ${JSON.stringify(value)}`);
    assert.equal(nextCalled, false);
  }
});

test('middleware passes through with the company id from req.user, ignoring conflicting body values', () => {
  const mw = requireCompanyScope();
  const req = {
    user: { id: 'u1', companyId: COMPANY },
    body: { company_id: OTHER },
    params: { company_id: OTHER },
  };
  const res = fakeRes();
  let nextCalled = false;
  mw(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
  assert.equal(getCompanyScope(req), COMPANY);
});

test('getCompanyScope throws when req.user has no valid company id, even if body carries one', () => {
  assert.throws(
    () => getCompanyScope({ user: { id: 'u1' }, body: { company_id: COMPANY } }),
    CompanyScopeError,
  );
  assert.throws(() => getCompanyScope({ body: { company_id: COMPANY } }), CompanyScopeError);
});
