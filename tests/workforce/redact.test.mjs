/**
 * Tests for server/workforce/runtime/redact.ts. Pure function, no network, no database.
 * Run: node --test --experimental-transform-types tests/workforce/redact.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactForAudit } from '../../server/workforce/runtime/redact.ts';

test('a secret-named key is redacted, other keys are kept', () => {
  const out = redactForAudit({
    password: 'hunter2',
    api_key: 'abc',
    nested: { Authorization: 'Basic abc123', name: 'Ada' },
  });
  assert.equal(out.password, '[redacted]');
  assert.equal(out.api_key, '[redacted]');
  assert.equal(out.nested.Authorization, '[redacted]');
  assert.equal(out.nested.name, 'Ada');
});

test('a bearer token nested inside a string is redacted', () => {
  const out = redactForAudit({ log: { line: 'sent with Bearer abc.def-123 to upstream' } });
  assert.equal(out.log.line, 'sent with Bearer [redacted] to upstream');
});

test('a card-like digit run is masked, keeping the last four digits', () => {
  const out = redactForAudit({ note: 'card 4111111111111111 on file' });
  assert.equal(out.note, 'card ************1111 on file');
});

test('an email is masked but its domain is kept', () => {
  const out = redactForAudit({ to: 'alice@example.com' });
  assert.equal(out.to, 'a****@example.com');
});

test('a cycle does not hang and is replaced with [truncated]', () => {
  const node = { name: 'loop' };
  node.self = node;
  node.list = [node];
  const out = redactForAudit(node);
  assert.equal(out.name, 'loop');
  assert.equal(out.self, '[truncated]');
  assert.equal(out.list[0], '[truncated]');
});

test('the input object is unchanged after the call', () => {
  const input = {
    password: 'hunter2',
    text: 'Bearer abc.def-123 and alice@example.com',
    card: '4111111111111111',
    list: [{ token: 'x' }],
  };
  const before = structuredClone(input);
  redactForAudit(input);
  assert.deepStrictEqual(input, before);
});

test('numbers and booleans pass through unchanged', () => {
  const input = { count: 42, ratio: 1.5, on: true, off: false, none: null };
  const out = redactForAudit(input);
  assert.deepStrictEqual(out, { count: 42, ratio: 1.5, on: true, off: false, none: null });
});

test('values nested deeper than 10 levels are replaced with [truncated]', () => {
  const root = {};
  let cur = root;
  for (let i = 0; i < 12; i += 1) {
    cur.c = {};
    cur = cur.c;
  }
  let node = redactForAudit(root);
  for (let i = 0; i < 10; i += 1) node = node.c;
  assert.equal(node.c, '[truncated]');
});
