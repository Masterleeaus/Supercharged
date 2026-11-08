/**
 * Ported from mcp-gateway-work tests/services/redaction.test.ts (MIT,
 * Copyright (c) 2026 Aureo Bueno). Jest assertions converted to node:test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSensitiveKey,
  redactArguments,
  redactString,
  redactToolResult,
} from '../../server/services/redaction.ts';

test('redactString redacts OpenAI-style keys', () => {
  const { text, hits } = redactString('key sk-abcdef0123456789ABCD here');
  assert.equal(text, 'key *** here');
  assert.equal(hits['openai_key'], 1);
});

test('redactString redacts GitHub tokens', () => {
  const { text } = redactString('ghp_abcdefghijklmnopqrstuvwx');
  assert.equal(text, '***');
});

test('redactString redacts CPF', () => {
  const { text } = redactString('cpf 123.456.789-00 fim');
  assert.equal(text, 'cpf *** fim');
});

test('redactString redacts credit card numbers', () => {
  const { text } = redactString('card 4111 1111 1111 1111 ok');
  assert.equal(text, 'card *** ok');
});

test('redactString redacts the bearer token but keeps the scheme', () => {
  const { text } = redactString('Authorization: Bearer abc123XYZ');
  assert.equal(text, 'Authorization: Bearer ***');
});

test('redactString redacts the value of a secret assignment but keeps the key', () => {
  const { text } = redactString('api_key=supersecretvalue');
  assert.equal(text, 'api_key=***');
});

test('redactString leaves clean text untouched', () => {
  const { text, hits } = redactString('nothing sensitive here');
  assert.equal(text, 'nothing sensitive here');
  assert.deepEqual(hits, {});
});

test('redactString uses a custom replacement', () => {
  assert.equal(redactString('sk-abcdef0123456789ABCD', '[X]').text, '[X]');
});

test('redactToolResult recursively redacts strings in nested structures', () => {
  const input = {
    content: [{ type: 'text', text: 'cpf 123.456.789-00' }],
    structuredContent: { token: 'sk-abcdef0123456789ABCD' },
  };

  const { result, summary } = redactToolResult(input);

  assert.ok(!JSON.stringify(result).includes('123.456.789-00'));
  assert.ok(!JSON.stringify(result).includes('sk-abcdef0123456789ABCD'));
  assert.equal(result.structuredContent.token, '***');
  assert.equal(summary.total, 2);
});

test('redactToolResult keeps non-string values unchanged', () => {
  const { result, summary } = redactToolResult({ count: 3, ok: true, nested: null });
  assert.deepEqual(result, { count: 3, ok: true, nested: null });
  assert.equal(summary.total, 0);
});

test('redactToolResult is a no-op when disabled', () => {
  const input = { text: 'cpf 123.456.789-00' };
  const { result, summary } = redactToolResult(input, { enabled: false });
  assert.equal(result.text, 'cpf 123.456.789-00');
  assert.equal(summary.total, 0);
});

test('isSensitiveKey matches secret-looking key names in any casing or separator style', () => {
  for (const key of [
    'password', 'db_password', 'githubToken', 'access_token', 'x-api-key',
    'apiKey', 'Authorization', 'client_secret', 'private_key', 'Cookie',
  ]) {
    assert.equal(isSensitiveKey(key), true, key);
  }
});

test('isSensitiveKey does not match ordinary keys that merely contain a similar word', () => {
  for (const key of ['max_tokens', 'token_type', 'secret_name', 'path', 'text', 'query']) {
    assert.equal(isSensitiveKey(key), false, key);
  }
});

test('redactArguments masks values stored under sensitive keys, even when the value looks harmless', () => {
  const { result, summary } = redactArguments({
    name: 'github__create_issue',
    arguments: { title: 'bug', password: 'hunter2', db: { apiKey: 'abc', port: 5432 }, retries: 3 },
  });

  assert.equal(result.arguments.title, 'bug');
  assert.equal(result.arguments.password, '***');
  assert.equal(result.arguments.db.apiKey, '***');
  assert.equal(result.arguments.db.port, 5432);
  assert.equal(result.arguments.retries, 3);
  assert.equal(summary.hits['sensitive_key'], 2);
});

test('redactArguments also applies the value patterns to every string', () => {
  const { result } = redactArguments({ text: 'my key is sk-abcdef0123456789ABCD' });
  assert.equal(result.text, 'my key is ***');
});

test('redactArguments is a no-op when disabled', () => {
  const input = { password: 'hunter2' };
  assert.deepEqual(redactArguments(input, { enabled: false }).result, input);
});

test('redactArguments does not mutate the original arguments forwarded upstream', () => {
  const input = { password: 'hunter2' };
  redactArguments(input);
  assert.equal(input.password, 'hunter2');
});

test('redactArguments passes undefined through unchanged', () => {
  assert.equal(redactArguments(undefined).result, undefined);
});

test('redactArguments keeps Date values intact', () => {
  const when = new Date('2026-11-02T00:00:00.000Z');
  const { result } = redactArguments({ at: when });
  assert.ok(result.at instanceof Date);
  assert.equal(result.at.getTime(), when.getTime());
});

test('redactToolResult does not mask response fields by key name, so pagination tokens keep working', () => {
  const { result } = redactToolResult({ structuredContent: { nextPageToken: 'cursor-42' } });
  assert.equal(result.structuredContent.nextPageToken, 'cursor-42');
});

test('redaction is idempotent, so a redacted value hashes the same on re-redaction', () => {
  const once = redactArguments({ note: 'sk-abcdef0123456789ABCD', password: 'hunter2' }).result;
  const twice = redactArguments(once).result;
  assert.deepEqual(twice, once);
});
