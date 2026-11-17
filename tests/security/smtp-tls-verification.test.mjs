// Security regression test: SMTP certificates are always verified. Fake values only.
// Run: node --test --experimental-transform-types tests/security/smtp-tls-verification.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { register } from 'node:module';

console.log = () => {};
console.info = () => {};
console.warn = () => {};

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

const { smtpTlsOptions } = await import('../../server/services/smtp-tls-options.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function listTs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(p));
    else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(p);
  }
  return out;
}

test('verification stays on by default', () => {
  const prev = process.env.SMTP_ALLOW_SELF_SIGNED;
  delete process.env.SMTP_ALLOW_SELF_SIGNED;
  try {
    assert.deepEqual(smtpTlsOptions(), { rejectUnauthorized: true });
  } finally {
    if (prev !== undefined) process.env.SMTP_ALLOW_SELF_SIGNED = prev;
  }
});

test('legacy SMTP_ALLOW_SELF_SIGNED=true no longer disables verification', () => {
  const prev = process.env.SMTP_ALLOW_SELF_SIGNED;
  process.env.SMTP_ALLOW_SELF_SIGNED = 'true';
  try {
    assert.deepEqual(smtpTlsOptions(), { rejectUnauthorized: true });
  } finally {
    if (prev === undefined) delete process.env.SMTP_ALLOW_SELF_SIGNED;
    else process.env.SMTP_ALLOW_SELF_SIGNED = prev;
  }
});

test('no server file disables certificate verification', () => {
  const offenders = listTs(path.join(ROOT, 'server')).filter((f) =>
    /rejectUnauthorized\s*:\s*false/.test(fs.readFileSync(f, 'utf-8')),
  );
  assert.deepEqual(offenders.map((f) => path.relative(ROOT, f)), []);
});

test('every SMTP call site uses smtpTlsOptions', () => {
  const emailSrc = fs.readFileSync(path.join(ROOT, 'server/services/email-service.ts'), 'utf-8');
  const routeSrc = fs.readFileSync(path.join(ROOT, 'server/routes/admin/smtp-routes.ts'), 'utf-8');
  const calls = (emailSrc.match(/tls:\s*smtpTlsOptions\(\)/g) || []).length;
  assert.equal(calls, 3, 'email-service has three transports');
  assert.match(routeSrc, /tls:\s*smtpTlsOptions\(\)/);
  assert.doesNotMatch(emailSrc + routeSrc, /SMTP_ALLOW_SELF_SIGNED\s*===\s*'true'/);
});
