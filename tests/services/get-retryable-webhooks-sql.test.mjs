// Checks that DatabaseStorage.getRetryableWebhooks excludes dead-lettered rows in SQL.
// Static check on the query source: no database, no network, no server import.
// Run: node --test --experimental-transform-types tests/services/get-retryable-webhooks-sql.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', '..', 'server', 'storage.ts'), 'utf8').replace(/\r\n/g, '\n');

function functionBody(name) {
  const start = source.indexOf(`async ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in server/storage.ts`);
  const end = source.indexOf('\n  }\n', start);
  assert.notEqual(end, -1, `${name} must have a closing brace`);
  return source.slice(start, end);
}

test('getRetryableWebhooks has a SQL dead-letter guard', () => {
  const body = functionBody('getRetryableWebhooks');
  assert.match(
    body,
    /NOT \(\$\{paymentWebhookQueue\.status\} = \$\{'failed'\} AND \$\{paymentWebhookQueue\.attemptCount\} >= \$\{paymentWebhookQueue\.maxAttempts\}\)/,
    'query must exclude status failed rows at or past maxAttempts',
  );
});

test('getRetryableWebhooks keeps the attempt-count bound', () => {
  const body = functionBody('getRetryableWebhooks');
  assert.match(body, /attemptCount\} < \$\{paymentWebhookQueue\.maxAttempts\}/);
});

test('the dead-letter guard sits inside the where(and(...)) of getRetryableWebhooks', () => {
  const body = functionBody('getRetryableWebhooks');
  const whereAt = body.indexOf('.where(and(');
  const guardAt = body.indexOf('NOT (');
  const orderAt = body.indexOf('.orderBy(');
  assert.ok(whereAt !== -1 && guardAt > whereAt && guardAt < orderAt, 'guard must be in the where clause');
});
