// Webhook secret files must never be tracked by git (issue #2).
// Dependency-free. Checks the git index, .gitignore, the loaders' env-first order, and that the PR secret scan is wired.
// Run: node --test tests/security/webhook-secret-files.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const SECRET_FILES = ['.appointment-webhook-secret', '.rag-webhook-secret'];

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null; // not a git checkout (for example an extracted ZIP): the index check is skipped
  }
}

test('no webhook secret file is tracked by git', (t) => {
  const tracked = trackedFiles();
  if (tracked === null) return t.skip('not a git checkout');
  // Secret dotfiles only (for example .rag-webhook-secret), not any source file whose name contains the phrase.
  const leaked = tracked.filter((f) => SECRET_FILES.includes(path.basename(f)) || /^\.[\w-]*webhook-secret$/i.test(path.basename(f)));
  assert.deepEqual(leaked, []);
});

test('.gitignore blocks both secret files', () => {
  const lines = read('.gitignore').split('\n').map((l) => l.trim());
  for (const f of SECRET_FILES) assert.ok(lines.includes(f), `${f} is not in .gitignore`);
});

test('appointment and RAG loaders read the environment before any file', () => {
  const appt = read('server/services/appointment-elevenlabs-tool.ts');
  assert.match(appt, /env\.APPOINTMENT_WEBHOOK_SECRET\b[\s\S]{0,80}return env\.APPOINTMENT_WEBHOOK_SECRET/);
  const rag = read('server/services/rag-webhook-secret.ts');
  const envIdx = rag.indexOf('env.RAG_WEBHOOK_SECRET');
  const fileIdx = rag.indexOf('secretPath', envIdx);
  assert.ok(envIdx >= 0 && fileIdx > envIdx, 'RAG loader must check RAG_WEBHOOK_SECRET before the secret file');
  assert.doesNotMatch(rag, /writeFileSync/, 'RAG loader must never write a secret to disk');
  assert.doesNotMatch(rag, /JWT_SECRET/, 'RAG loader must never derive its secret from JWT_SECRET');
});

test('the PR secret scan (gitleaks) is a gating job in pr-checks', () => {
  const wf = read('.github/workflows/pr-checks.yml');
  assert.match(wf, /secret-scan:/);
  assert.match(wf, /gitleaks"? detect[\s\S]*--exit-code 1/);
});
