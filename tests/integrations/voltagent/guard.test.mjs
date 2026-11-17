import assert from 'node:assert/strict';
import test from 'node:test';
import { assertNoVoltOpsKeys } from '../../../server/integrations/voltagent/guard.ts';

test('passes when both VoltOps keys are unset', () => {
  assert.doesNotThrow(() => assertNoVoltOpsKeys({}));
});

test('throws when VOLTAGENT_PUBLIC_KEY is set', () => {
  assert.throws(
    () => assertNoVoltOpsKeys({ VOLTAGENT_PUBLIC_KEY: 'pk_test' }),
    /VOLTAGENT_PUBLIC_KEY/,
  );
});

test('throws when VOLTAGENT_SECRET_KEY is set', () => {
  assert.throws(
    () => assertNoVoltOpsKeys({ VOLTAGENT_SECRET_KEY: 'sk_test' }),
    /VOLTAGENT_SECRET_KEY/,
  );
});

test('an empty string does not count as set', () => {
  assert.doesNotThrow(() => assertNoVoltOpsKeys({ VOLTAGENT_PUBLIC_KEY: '', VOLTAGENT_SECRET_KEY: '' }));
});
