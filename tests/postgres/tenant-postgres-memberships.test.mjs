import test from 'node:test';
import assert from 'node:assert/strict';
import { A, B, enabled, fixture } from './tenant-postgres-support.mjs';

const U1 = 'user-multi-company';
const U2 = 'user-company-a-only';

test('PostgreSQL memberships: one user can belong to two companies, and company scope stays separate', { skip: !enabled }, async () => {
  const f = fixture();
  try {
    await f.pool.query('DELETE FROM user_company_memberships');
    await f.pool.query('DELETE FROM users');
    await f.pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [U1, U2]);
    await f.pool.query(
      'INSERT INTO user_company_memberships (user_id, company_id) VALUES ($1, $2), ($1, $3), ($4, $2)',
      [U1, A, B, U2],
    );

    const u1 = await f.pool.query('SELECT company_id FROM user_company_memberships WHERE user_id = $1 ORDER BY company_id', [U1]);
    assert.deepEqual(u1.rows.map((r) => r.company_id).sort(), [A, B].sort());

    const membersOfA = await f.pool.query('SELECT user_id FROM user_company_memberships WHERE company_id = $1 ORDER BY user_id', [A]);
    assert.deepEqual(membersOfA.rows.map((r) => r.user_id), [U1, U2].sort());
    const membersOfB = await f.pool.query('SELECT user_id FROM user_company_memberships WHERE company_id = $1', [B]);
    assert.deepEqual(membersOfB.rows.map((r) => r.user_id), [U1]);
  } finally {
    await f.close();
  }
});

test('PostgreSQL memberships: a duplicate user and company pair is rejected', { skip: !enabled }, async () => {
  const f = fixture();
  try {
    await f.pool.query('DELETE FROM user_company_memberships');
    await f.pool.query('DELETE FROM users');
    await f.pool.query('INSERT INTO users (id) VALUES ($1)', [U1]);
    await f.pool.query('INSERT INTO user_company_memberships (user_id, company_id) VALUES ($1, $2)', [U1, A]);
    await assert.rejects(
      f.pool.query('INSERT INTO user_company_memberships (user_id, company_id) VALUES ($1, $2)', [U1, A]),
      (error) => error.code === '23505',
    );
  } finally {
    await f.close();
  }
});

test('PostgreSQL memberships: deleting a user removes only that user\'s memberships', { skip: !enabled }, async () => {
  const f = fixture();
  try {
    await f.pool.query('DELETE FROM user_company_memberships');
    await f.pool.query('DELETE FROM users');
    await f.pool.query('INSERT INTO users (id) VALUES ($1), ($2)', [U1, U2]);
    await f.pool.query('INSERT INTO user_company_memberships (user_id, company_id) VALUES ($1, $2), ($3, $2)', [U1, A, U2]);
    await f.pool.query('DELETE FROM users WHERE id = $1', [U1]);
    const left = await f.pool.query('SELECT user_id FROM user_company_memberships WHERE company_id = $1', [A]);
    assert.deepEqual(left.rows.map((r) => r.user_id), [U2]);
  } finally {
    await f.close();
  }
});
