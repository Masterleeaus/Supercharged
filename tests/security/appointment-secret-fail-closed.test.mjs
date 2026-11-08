// Security regression test: the appointment webhook secret fails closed in production.
// Uses fake values only. Run: node --test --experimental-transform-types tests/security/appointment-secret-fail-closed.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

// Keep stdout clean for the test runner IPC.
console.log = () => {};
console.info = () => {};
console.warn = () => {};

// The service imports ../utils/domain without an extension, which Node's ESM loader rejects.
// This hook resolves extensionless relative imports to .ts (same approach as tests/modules/chatbot-mount.test.mjs).
const RESOLVE_HOOK = `
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\\.[cm]?[jt]s$/.test(specifier)) {
    for (const candidate of [specifier + '.ts', specifier + '/index.ts']) {
      const url = new URL(candidate, context.parentURL);
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
`;
register('data:text/javascript,' + encodeURIComponent(RESOLVE_HOOK), import.meta.url);

const { resolveAppointmentWebhookSecret, DEV_ONLY_APPOINTMENT_WEBHOOK_SECRET } =
  await import('../../server/services/appointment-elevenlabs-tool.ts');

const FAKE_ENV_SECRET = 'fake-env-secret-for-tests';
const FAKE_FILE_SECRET = 'fake-file-secret-for-tests';
const missingPath = path.join(os.tmpdir(), `appt-secret-missing-${process.pid}-${Date.now()}`);

test('production with no env var and no file throws instead of generating a secret', () => {
  assert.equal(fs.existsSync(missingPath), false);
  assert.throws(
    () => resolveAppointmentWebhookSecret({ NODE_ENV: 'production' }, missingPath),
    /not configured/,
  );
});

test('unset NODE_ENV with no env var and no file also fails closed', () => {
  assert.throws(() => resolveAppointmentWebhookSecret({}, missingPath), /not configured/);
});

test('production uses APPOINTMENT_WEBHOOK_SECRET when set', () => {
  const s = resolveAppointmentWebhookSecret(
    { NODE_ENV: 'production', APPOINTMENT_WEBHOOK_SECRET: FAKE_ENV_SECRET },
    missingPath,
  );
  assert.equal(s, FAKE_ENV_SECRET);
});

test('production uses the secret file when the env var is absent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appt-secret-'));
  const file = path.join(dir, 'secret');
  try {
    fs.writeFileSync(file, `${FAKE_FILE_SECRET}\n`);
    assert.equal(resolveAppointmentWebhookSecret({ NODE_ENV: 'production' }, file), FAKE_FILE_SECRET);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dev-only value is returned only for explicit development or test', () => {
  assert.equal(
    resolveAppointmentWebhookSecret({ NODE_ENV: 'development' }, missingPath),
    DEV_ONLY_APPOINTMENT_WEBHOOK_SECRET,
  );
  assert.equal(
    resolveAppointmentWebhookSecret({ NODE_ENV: 'test' }, missingPath),
    DEV_ONLY_APPOINTMENT_WEBHOOK_SECRET,
  );
  assert.match(DEV_ONLY_APPOINTMENT_WEBHOOK_SECRET, /^DEV-ONLY/);
});

test('no random secret is generated: two resolutions in dev return the same value', () => {
  const a = resolveAppointmentWebhookSecret({ NODE_ENV: 'development' }, missingPath);
  const b = resolveAppointmentWebhookSecret({ NODE_ENV: 'development' }, missingPath);
  assert.equal(a, b);
});
