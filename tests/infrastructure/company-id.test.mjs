/**
 * assertCompanyId and isCompanyId: a missing or malformed company id must be
 * rejected before any tenant work runs.
 *
 *   node --test tests/infrastructure/company-id.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCompanyId,
  isCompanyId,
  TenantContextError,
} from '../../server/infrastructure/database/tenant-context.ts';

const VALID = '6f1c2a3e-9b7d-4e8f-a1b2-c3d4e5f60718';

test('a well-formed UUID is returned unchanged', () => {
  assert.equal(assertCompanyId(VALID), VALID);
  assert.equal(assertCompanyId(VALID.toUpperCase()), VALID.toUpperCase());
  assert.equal(isCompanyId(VALID), true);
});

test('a missing value is rejected with TenantContextError', () => {
  for (const value of [undefined, null, '', '   ']) {
    assert.equal(isCompanyId(value), false, `isCompanyId(${JSON.stringify(value)})`);
    assert.throws(() => assertCompanyId(value), TenantContextError, `value ${JSON.stringify(value)}`);
  }
});

test('a malformed value is rejected with TenantContextError', () => {
  const malformed = [
    0,
    123,
    true,
    {},
    [VALID],
    'not-a-uuid',
    '6f1c2a3e9b7d4e8fa1b2c3d4e5f60718', // no hyphens
    `x${VALID}`, // prefix
    `${VALID}0`, // one extra character
    ` ${VALID}`, // leading space
    `${VALID}\n`, // trailing newline
    '6f1c2a3e-9b7d-4e8f-a1b2-c3d4e5f6071', // one character short
    '6f1c2a3e-9b7d-4e8f-a1b2-c3d4e5f6071g', // non-hex character
    `${VALID}'; DROP TABLE users; --`,
  ];
  for (const value of malformed) {
    assert.equal(isCompanyId(value), false, `isCompanyId(${JSON.stringify(value)})`);
    assert.throws(() => assertCompanyId(value), TenantContextError, `value ${JSON.stringify(value)}`);
  }
});

test('the rejection message names the UUID requirement', () => {
  assert.throws(() => assertCompanyId(undefined), /companyId must be a UUID/);
});
