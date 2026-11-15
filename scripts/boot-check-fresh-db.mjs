/**
 * Boot check against a fresh native PostgreSQL database (issue #124).
 *
 * Steps:
 *   1. Refuse unless BOOT_PG_DISPOSABLE=true and BOOT_PG_URL points at an EMPTY database.
 *   2. Apply the base schema migrations/0000_damp_spectrum.sql (the manifest does not include it).
 *   3. Run scripts/run-safe-migration.mjs, which applies the manifest in its listed order.
 *   4. Start the built server (dist/index.js) and wait for "serving on port" and HTTP 200 on /health.
 *
 * Needs `npm run build` to have produced dist/index.js first.
 * The database URL and secrets are never printed; only the masked host and the outcome are logged.
 *
 * Usage: BOOT_PG_DISPOSABLE=true BOOT_PG_URL=postgres://... node scripts/boot-check-fresh-db.mjs
 * Exit 0 when every step passes, 1 on any failure, 2 on bad setup.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_SCHEMA = resolve(root, 'migrations/0000_damp_spectrum.sql');
const BOOT_TIMEOUT_MS = 120_000;

function mask(url) {
  return url.replace(/\/\/([^:@/]+):[^@]*@/, '//$1:****@');
}

function fail(message, code = 1) {
  console.error(`BOOT CHECK FAILED: ${message}`);
  process.exit(code);
}

async function freePort() {
  return new Promise((ok, err) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', err);
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => ok(port));
    });
  });
}

function run(cmd, args, env, label) {
  return new Promise((ok) => {
    const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => ok({ code, out, label }));
  });
}

async function assertEmpty(client) {
  const { rows } = await client.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
  );
  if (rows[0].n !== 0) fail(`database is not empty (${rows[0].n} tables in public). Use a fresh database.`, 2);
}

async function applyBaseSchema(client) {
  if (!existsSync(BASE_SCHEMA)) fail(`missing ${BASE_SCHEMA}`);
  try {
    await client.query(readFileSync(BASE_SCHEMA, 'utf8'));
  } catch (error) {
    fail(`base schema 0000_damp_spectrum.sql failed: ${error.message}`);
  }
  console.log('OK   base schema applied: 0000_damp_spectrum.sql');
}

async function applyManifest(url) {
  const result = await run(process.execPath, [resolve(root, 'scripts/run-safe-migration.mjs')], { DATABASE_URL: url }, 'migrations');
  const applied = result.out.split('\n').filter((l) => l.includes('Applying:')).length;
  if (result.code !== 0) {
    console.error(result.out.split('\n').slice(-30).join('\n'));
    fail(`manifest migrations exited ${result.code}; ${applied} file(s) reported as applied before the failure`);
  }
  console.log(`OK   manifest migrations applied in order: ${applied} file(s)`);
}

async function bootServer(url) {
  const distEntry = resolve(root, 'dist/index.js');
  if (!existsSync(distEntry)) fail('dist/index.js is missing. Run `npm run build` first.', 2);
  const port = await freePort();
  const child = spawn(process.execPath, [distEntry], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      DATABASE_URL: url,
      // CI-only placeholder for the production JWT_SECRET check. Not a real secret.
      JWT_SECRET: process.env.JWT_SECRET || 'boot-check-placeholder-jwt-secret-not-real',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const started = Date.now();
  let ready = false;
  let healthy = false;
  try {
    while (Date.now() - started < BOOT_TIMEOUT_MS) {
      if (child.exitCode !== null) break;
      if (!ready && /serving on port/.test(log)) ready = true;
      if (ready) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.status === 200) {
            healthy = true;
            break;
          }
        } catch {
          // not accepting connections yet
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    child.kill('SIGTERM');
  }
  if (!ready || !healthy) {
    console.error(log.split('\n').slice(-40).join('\n'));
    fail(`server did not reach ready within ${BOOT_TIMEOUT_MS / 1000}s (ready=${ready}, health=${healthy}, exit=${child.exitCode})`);
  }
  console.log(`OK   server ready on port ${port} and /health returned 200 in ${Math.round((Date.now() - started) / 1000)}s`);
}

async function main() {
  if (process.env.BOOT_PG_DISPOSABLE !== 'true') fail('requires BOOT_PG_DISPOSABLE=true (never run against a persistent database)', 2);
  const url = process.env.BOOT_PG_URL;
  if (!url) fail('BOOT_PG_URL is required', 2);
  console.log(`Boot check target: ${mask(url)}`);

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await assertEmpty(client);
    await applyBaseSchema(client);
  } finally {
    await client.end();
  }
  await applyManifest(url);
  await bootServer(url);
  console.log('PASS boot check on a fresh database');
}

main().catch((error) => fail(error.message));
