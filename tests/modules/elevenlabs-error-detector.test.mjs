import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectConcurrencyError,
  isRecoverableError,
  isConcurrencyLimitError,
  formatErrorForLog,
} from '../../server/engines/elevenlabs-migration/error-detector.ts';

test('detects HTTP 429 from an Error with statusCode', () => {
  const err = Object.assign(new Error('boom'), { statusCode: 429 });
  const r = detectConcurrencyError(err);
  assert.equal(r.isConcurrencyError, true);
  assert.equal(r.statusCode, 429);
  assert.equal(isConcurrencyLimitError(err), true);
  assert.equal(isRecoverableError(err), true);
});

test('reads status and details.responseBody from an Error', () => {
  const err = Object.assign(new Error('x'), { status: 503, details: { responseBody: 'raw body' } });
  const r = detectConcurrencyError(err);
  assert.equal(r.statusCode, 503);
  assert.equal(r.rawError, 'raw body');
});

test('matches concurrency wording in a plain string', () => {
  const r = detectConcurrencyError('Too many requests, please slow down');
  assert.equal(r.isConcurrencyError, true);
  assert.match(r.message, /Concurrency limit detected/);
});

test('plain object: detail.message wins over message', () => {
  const r = detectConcurrencyError({ message: 'generic', detail: { message: 'rate limit hit' } });
  assert.equal(r.isConcurrencyError, true);
  assert.equal(r.message.includes('rate limit hit'), true);
});

test('auth errors are not recoverable even if status is 429-like wording', () => {
  assert.equal(isRecoverableError({ message: 'Unauthorized', status: 401 }), false);
  assert.equal(isRecoverableError({ message: 'invalid api key' }), false);
});

test('unrelated errors are not concurrency errors', () => {
  const r = detectConcurrencyError(new Error('disk full'));
  assert.equal(r.isConcurrencyError, false);
  assert.equal(detectConcurrencyError(null).isConcurrencyError, false);
  assert.equal(detectConcurrencyError(undefined).isConcurrencyError, false);
});

test('formatErrorForLog handles string, Error with details, and objects', () => {
  assert.equal(formatErrorForLog('plain'), 'plain');
  const err = Object.assign(new Error('bad'), { details: { a: 1 } });
  assert.equal(formatErrorForLog(err), 'bad | Details: {"a":1}');
  assert.equal(formatErrorForLog(new Error('just')), 'just');
  assert.equal(formatErrorForLog(42), '42');
});
