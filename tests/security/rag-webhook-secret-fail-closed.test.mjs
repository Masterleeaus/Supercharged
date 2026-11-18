// Security regression test: the RAG webhook secret is loaded from config and fails closed in production.
// Uses fake values only. Run: node --test --experimental-transform-types tests/security/rag-webhook-secret-fail-closed.test.mjs
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

// Same extensionless-import resolver used by appointment-secret-fail-closed.test.mjs.
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

const { resolveRAGWebhookSecret, DEV_ONLY_RAG_WEBHOOK_SECRET, validateRAGWebhookToken } =
  await import("../../server/services/rag-webhook-secret.ts");

const FAKE_ENV_SECRET = 'fake-rag-env-secret-for-tests';
const FAKE_FILE_SECRET = 'fake-rag-file-secret-for-tests';
const missingPath = path.join(os.tmpdir(), `rag-secret-missing-${process.pid}-${Date.now()}`);

function withSecretFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-secret-'));
  const file = path.join(dir, '.rag-webhook-secret');
  fs.writeFileSync(file, content, { mode: 0o600 });
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('production with no env var and no file throws instead of deriving or generating a secret', () => {
  assert.throws(() => resolveRAGWebhookSecret({ NODE_ENV: 'production' }, missingPath), /RAG webhook secret is not configured/);
});

test('unset NODE_ENV with no env var and no file also fails closed', () => {
  assert.throws(() => resolveRAGWebhookSecret({}, missingPath), /not configured/);
});

test('JWT_SECRET is never used to derive the RAG webhook secret', () => {
  assert.throws(
    () => resolveRAGWebhookSecret({ NODE_ENV: 'production', JWT_SECRET: 'fake-jwt-for-tests' }, missingPath),
    /not configured/,
  );
});

test('RAG_WEBHOOK_SECRET env var wins over the secret file', () => {
  withSecretFile(FAKE_FILE_SECRET, (file) => {
    assert.equal(resolveRAGWebhookSecret({ NODE_ENV: 'production', RAG_WEBHOOK_SECRET: FAKE_ENV_SECRET }, file), FAKE_ENV_SECRET);
  });
});

test('production uses the secret file (read only) when the env var is absent', () => {
  withSecretFile(`${FAKE_FILE_SECRET}\n`, (file) => {
    assert.equal(resolveRAGWebhookSecret({ NODE_ENV: 'production' }, file), FAKE_FILE_SECRET);
  });
});

test('dev-only value is returned only for explicit development or test', () => {
  assert.equal(resolveRAGWebhookSecret({ NODE_ENV: 'development' }, missingPath), DEV_ONLY_RAG_WEBHOOK_SECRET);
  assert.equal(resolveRAGWebhookSecret({ NODE_ENV: 'test' }, missingPath), DEV_ONLY_RAG_WEBHOOK_SECRET);
  assert.match(DEV_ONLY_RAG_WEBHOOK_SECRET, /^DEV-ONLY-INSECURE/);
});

test('resolution never writes a secret file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rag-secret-nowrite-'));
  const file = path.join(dir, '.rag-webhook-secret');
  try {
    resolveRAGWebhookSecret({ NODE_ENV: 'development' }, file);
    assert.equal(existsSync(file), false, 'no file may be created by resolution');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('token validation rejects a missing, forged or wrong-length token and accepts the configured one', () => {
  const saved = process.env.RAG_WEBHOOK_SECRET;
  process.env.RAG_WEBHOOK_SECRET = FAKE_ENV_SECRET;
  try {
    assert.equal(validateRAGWebhookToken(undefined), false);
    assert.equal(validateRAGWebhookToken(''), false);
    assert.equal(validateRAGWebhookToken('forged-token-for-tests-xxxxxxxxxxxxxx'), false);
    assert.equal(validateRAGWebhookToken('short'), false);
    assert.equal(validateRAGWebhookToken(FAKE_ENV_SECRET), true);
  } finally {
    if (saved === undefined) delete process.env.RAG_WEBHOOK_SECRET;
    else process.env.RAG_WEBHOOK_SECRET = saved;
  }
});
