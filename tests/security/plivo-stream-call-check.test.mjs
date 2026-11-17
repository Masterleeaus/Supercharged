// Security regression test: Plivo stream upgrades only proceed for a known call row.
// Uses fake values only. Run: node --test --experimental-transform-types tests/security/plivo-stream-call-check.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

const { isKnownPlivoStreamCall } = await import('../../server/utils/plivo-stream-call-check.ts');

const FAKE_UUID = 'fake-plivo-call-uuid-1';

test('valid call row proceeds', async () => {
  const seen = [];
  const lookup = async (uuid) => {
    seen.push(uuid);
    return { id: 'fake-row-id' };
  };
  assert.equal(await isKnownPlivoStreamCall(FAKE_UUID, lookup), true);
  assert.deepEqual(seen, [FAKE_UUID]);
});

test('unknown callUuid is rejected', async () => {
  const lookup = async () => undefined;
  assert.equal(await isKnownPlivoStreamCall('fake-unknown-uuid', lookup), false);

  const lookupNull = async () => null;
  assert.equal(await isKnownPlivoStreamCall('fake-unknown-uuid', lookupNull), false);
});

test('lookup error is rejected (fails closed)', async () => {
  const lookup = async () => {
    throw new Error('fake database outage');
  };
  assert.equal(await isKnownPlivoStreamCall(FAKE_UUID, lookup), false);
});

test('empty callUuid is rejected without a lookup', async () => {
  let called = false;
  const lookup = async () => {
    called = true;
    return { id: 'fake-row-id' };
  };
  assert.equal(await isKnownPlivoStreamCall('', lookup), false);
  assert.equal(called, false);
});
