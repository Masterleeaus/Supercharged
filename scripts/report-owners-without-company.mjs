#!/usr/bin/env node
/**
 * Pre-release report: owner accounts with no company.
 *
 * Lists every user that owns at least one team (teams.user_id -> users.id)
 * whose users.company_id is NULL. Team members of those owners are refused by
 * the company check until the owner is assigned a company, so run this before
 * release.
 *
 * READ-ONLY: this script issues a single SELECT statement. It performs no
 * INSERT, UPDATE, DELETE, or DDL, and it does not modify any data.
 *
 * Usage:
 *   DATABASE_URL=... node scripts/report-owners-without-company.mjs
 *
 * The connection string is read from the DATABASE_URL environment variable only.
 * It is never printed. Output is limited to each owner's id and email.
 *
 * Exit codes:
 *   0  no owner accounts without a company
 *   2  one or more owner accounts without a company were found
 *   1  DATABASE_URL is unset, or the query failed
 */

import pg from "pg";

const { Client } = pg;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is not set. Set it in the environment and run again.");
  process.exit(1);
}

const QUERY = `
  SELECT DISTINCT u.id, u.email
  FROM users u
  JOIN teams t ON t.user_id = u.id
  WHERE u.company_id IS NULL
  ORDER BY u.id
`;

const client = new Client({ connectionString: databaseUrl });

let exitCode = 0;
try {
  await client.connect();
  const result = await client.query(QUERY);
  for (const row of result.rows) {
    console.log(`${row.id}\t${row.email}`);
  }
  console.log(`Owner accounts without a company: ${result.rows.length}`);
  exitCode = result.rows.length === 0 ? 0 : 2;
} catch (error) {
  // Print only the message, never the connection string or full object.
  console.error(`Query failed: ${error?.message ?? "unknown error"}`);
  exitCode = 1;
} finally {
  await client.end().catch(() => {});
}

process.exit(exitCode);
