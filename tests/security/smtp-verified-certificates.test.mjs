import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import tls from 'node:tls';
import { smtpTlsOptions } from '../../server/services/smtp-tls.ts';

test('SMTP certificate verification remains mandatory, including the retired bypass flag', () => {
  const original = process.env.SMTP_ALLOW_SELF_SIGNED;
  try {
    for (const value of [undefined, 'true', 'false', '1', 'TRUE']) {
      if (value === undefined) delete process.env.SMTP_ALLOW_SELF_SIGNED;
      else process.env.SMTP_ALLOW_SELF_SIGNED = value;
      assert.deepEqual(smtpTlsOptions(), { rejectUnauthorized: true }, String(value));
    }
  } finally {
    if (original === undefined) delete process.env.SMTP_ALLOW_SELF_SIGNED;
    else process.env.SMTP_ALLOW_SELF_SIGNED = original;
  }
});

test('production and admin SMTP transports consume the single verified TLS helper', () => {
  const email = readFileSync(new URL('../../server/services/email-service.ts', import.meta.url), 'utf8');
  const admin = readFileSync(new URL('../../server/routes/admin/smtp-routes.ts', import.meta.url), 'utf8');
  assert.match(email, /export \{ smtpTlsOptions \} from '\.\/smtp-tls';/);
  assert.match(email, /import \{ smtpTlsOptions \} from '\.\/smtp-tls';/);
  assert.equal((email.match(/tls: smtpTlsOptions\(\)/g) || []).length, 3);
  assert.match(admin, /tls: smtpTlsOptions\(\)/);
  assert.doesNotMatch(email, /SMTP_ALLOW_SELF_SIGNED|rejectUnauthorized:\s*false/);
  assert.doesNotMatch(admin, /rejectUnauthorized:\s*false/);
});

test('a self-signed SMTP TLS certificate is rejected unless its CA is explicitly trusted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'titan-smtp-tls-'));
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  let server;
  try {
    execFileSync('openssl', [
      'req', '-x509', '-nodes', '-newkey', 'rsa:2048',
      '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'
    ], { stdio: 'ignore', timeout: 15000 });

    server = tls.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (socket) => {
      socket.end('220 ready\r\n');
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const connect = (ca) => new Promise((resolve) => {
      const socket = tls.connect({
        host: '127.0.0.1',
        port: server.address().port,
        servername: 'localhost',
        ...smtpTlsOptions(),
        ...(ca ? { ca } : {}),
      }, () => { socket.end(); resolve({ authorized: socket.authorized }); });
      socket.once('error', (error) => { socket.destroy(); resolve({ error: error.code }); });
      socket.setTimeout(5000, () => { socket.destroy(); resolve({ error: 'TIMEOUT' }); });
    });

    const rejected = await connect();
    assert.match(String(rejected.error), /SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
    const explicitlyTrusted = await connect(readFileSync(cert));
    assert.deepEqual(explicitlyTrusted, { authorized: true });
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
