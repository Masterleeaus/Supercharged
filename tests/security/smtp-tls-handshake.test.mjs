// SMTP handshake behaviour with the real TLS stack (issue #472, item 2). Uses a throwaway self-signed
// certificate generated at test time in a temp directory. No network beyond 127.0.0.1, no real credentials.
// Run: node --test --experimental-transform-types tests/security/smtp-tls-handshake.test.mjs
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-tls-handshake-'));
const keyPath = path.join(dir, 'key.pem');
const certPath = path.join(dir, 'cert.pem');
execFileSync(
  'openssl',
  ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
  { stdio: 'ignore' },
);
const certPem = fs.readFileSync(certPath, 'utf-8');

const server = tls.createServer({ key: fs.readFileSync(keyPath), cert: certPem }, (sock) => sock.end());
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();

after(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function handshake(options) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: '127.0.0.1', port, servername: 'localhost', ...options }, () => {
      sock.end();
      resolve({ ok: true });
    });
    sock.on('error', (err) => resolve({ ok: false, code: err.code }));
  });
}

const UNTRUSTED_CODES = ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'];

test('SMTP TLS rejects a self-signed relay with default settings', async () => {
  const prev = process.env.SMTP_ALLOW_SELF_SIGNED;
  delete process.env.SMTP_ALLOW_SELF_SIGNED;
  try {
    const result = await handshake(smtpTlsOptions());
    assert.equal(result.ok, false);
    assert.ok(UNTRUSTED_CODES.includes(result.code), `unexpected error code: ${result.code}`);
  } finally {
    if (prev !== undefined) process.env.SMTP_ALLOW_SELF_SIGNED = prev;
  }
});

test('legacy SMTP_ALLOW_SELF_SIGNED=true does not let a self-signed relay through', async () => {
  const prev = process.env.SMTP_ALLOW_SELF_SIGNED;
  process.env.SMTP_ALLOW_SELF_SIGNED = 'true';
  try {
    const result = await handshake(smtpTlsOptions());
    assert.equal(result.ok, false);
  } finally {
    if (prev === undefined) delete process.env.SMTP_ALLOW_SELF_SIGNED;
    else process.env.SMTP_ALLOW_SELF_SIGNED = prev;
  }
});

test('a relay whose CA is explicitly trusted still connects with verification on', async () => {
  const result = await handshake({ ...smtpTlsOptions(), ca: [certPem] });
  assert.equal(result.ok, true, `trusted relay failed: ${result.code}`);
});
