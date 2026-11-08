// Resubmit guard: at most one resubmission per source approval.
//
// The DB-backed tests need a scratch Postgres. Set DESK_TEST_DATABASE_URL to a
// database you can create schemas in, for example:
//   DESK_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/scratch node --test --experimental-transform-types tests/modules/approvals-resubmit-guard.test.mjs
// Each run creates its own schema, loads migrations/DRAFT_approvals.sql and
// migrations/DRAFT_approvals_resubmit_guard.sql into it, and drops it at the end.
// The app database is never touched. Without the variable the DB tests are skipped.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';

// approval-service.ts imports '../../services/audit-log', which opens the app DB pool.
// Swap it for a no-op, and resolve the extensionless relative imports the same way
// approvals-revoke.test.mjs does.
const AUDIT_STUB = 'export async function logAuditEvent() {}';
const HOOK = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
let stubs = [];
export function initialize(data) { stubs = data.stubs; }
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.')) {
    const hit = stubs.find(([suffix]) => specifier.endsWith(suffix));
    if (hit) {
      return { url: 'data:text/javascript,' + encodeURIComponent(hit[1]), format: 'module', shortCircuit: true };
    }
    if (!/\\.[cm]?[jt]s$/.test(specifier)) {
      for (const candidate of [specifier + '.ts', specifier + '/index.ts']) {
        const url = new URL(candidate, context.parentURL);
        if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(HOOK), import.meta.url, {
  data: { stubs: [['/services/audit-log', AUDIT_STUB]] },
});

const { ApprovalService } = await import('../../server/modules/approvals/approval-service.ts');

const DB_URL = process.env.DESK_TEST_DATABASE_URL;
const SKIP = DB_URL ? false : 'DESK_TEST_DATABASE_URL not set; see the header of this file';
const MIGRATIONS = new URL('../../migrations/', import.meta.url);
const COMPANY = randomUUID();
const OTHER_COMPANY = randomUUID();

describe('resubmit guard', { skip: SKIP }, () => {
  let pool;
  let service;
  let schema;

  /** Transaction-per-call runner with the same shape as withTenant: BEGIN, fn, COMMIT or ROLLBACK. */
  const runner = {
    async run(companyId, fn) {
      assert.ok(companyId, 'companyId required');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(drizzle(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };

  before(async () => {
    schema = `resubmit_guard_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: DB_URL, max: 1 });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.end();

    pool = new pg.Pool({ connectionString: DB_URL, max: 8, options: `-c search_path=${schema}` });
    await pool.query(readFileSync(new URL('DRAFT_approvals.sql', MIGRATIONS), 'utf8'));
    await pool.query(readFileSync(new URL('DRAFT_approvals_resubmit_guard.sql', MIGRATIONS), 'utf8'));
    service = new ApprovalService({ tenant: runner });
  });

  after(async () => {
    if (pool) await pool.end();
    const admin = new pg.Pool({ connectionString: DB_URL, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  });

  /** Inserts a source row directly. Returns its id. */
  async function seed(status, { companyId = COMPANY } = {}) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO approvals (id, company_id, requested_by, agent_id, action, urgency, params, context, status, decision, expires_at, decided_at)
       VALUES ($1, $2, 'agent-user-7', 'agent-7', 'send_refund', 'normal', $3::jsonb, $4::jsonb, $5, 'route_to_human',
               now() + interval '1 hour', now())`,
      [id, companyId, JSON.stringify({ amount: 40 }), JSON.stringify({ paramsSha256: 'x' }), status]
    );
    return id;
  }

  async function childrenOf(sourceId) {
    const { rows } = await pool.query(
      `SELECT id, status FROM approvals WHERE context ->> 'resubmittedFrom' = $1`,
      [sourceId]
    );
    return rows;
  }

  test('two resubmits of the same rejected source in parallel create exactly one pending approval', async () => {
    const source = await seed('rejected');
    const [a, b] = await Promise.all([
      service.resubmitApproval(COMPANY, source, { amount: 25 }, 'user-a'),
      service.resubmitApproval(COMPANY, source, { amount: 30 }, 'user-b'),
    ]);

    assert.deepEqual([a.kind, b.kind].sort(), ['ok', 'refused']);
    const winner = a.kind === 'ok' ? a : b;
    const loser = a.kind === 'ok' ? b : a;
    assert.equal(winner.approval.status, 'pending');
    assert.equal(loser.status, 'rejected');
    assert.match(loser.error, /already been resubmitted/);

    const children = await childrenOf(source);
    assert.equal(children.length, 1);
    assert.equal(children[0].status, 'pending');
    assert.equal(children[0].id, winner.approval.id);
  });

  test('a second resubmit after the first is refused and creates nothing', async () => {
    const source = await seed('expired');
    const first = await service.resubmitApproval(COMPANY, source, { amount: 10 }, 'user-a');
    assert.equal(first.kind, 'ok');

    const second = await service.resubmitApproval(COMPANY, source, { amount: 11 }, 'user-a');
    assert.equal(second.kind, 'refused');
    assert.equal(second.status, 'expired');
    assert.match(second.error, /already been resubmitted/);
    assert.equal((await childrenOf(source)).length, 1);
  });

  test('a resubmit of an approved source is refused and no row is created', async () => {
    const source = await seed('approved');
    const result = await service.resubmitApproval(COMPANY, source, { amount: 10 }, 'user-a');
    assert.equal(result.kind, 'refused');
    assert.equal(result.status, 'approved');
    assert.match(result.error, /Only rejected or expired/);
    assert.equal((await childrenOf(source)).length, 0);
  });

  test('a resubmit from another company is not found and creates nothing', async () => {
    const source = await seed('rejected');
    const result = await service.resubmitApproval(OTHER_COMPANY, source, { amount: 10 }, 'user-x');
    assert.equal(result.kind, 'not_found');
    assert.equal((await childrenOf(source)).length, 0);
  });

  test('the partial unique index rejects a second row that links to the same source', async () => {
    const source = await seed('rejected');
    const insertChild = () => pool.query(
      `INSERT INTO approvals (id, company_id, action, params, context, status, expires_at)
       VALUES ($1, $2, 'send_refund', '{}'::jsonb, $3::jsonb, 'pending', now() + interval '1 hour')`,
      [randomUUID(), COMPANY, JSON.stringify({ resubmittedFrom: source })]
    );
    await insertChild();
    await assert.rejects(insertChild, (err) => err.code === '23505');
  });
});
