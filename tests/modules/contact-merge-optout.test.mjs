// Opt-outs survive contact merge (node:test). Pure functions only: no database, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeContacts } from '../../server/modules/comms/contact-merge.ts';
import { checkConsent } from '../../server/modules/comms/consent.ts';

const CO = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-11-03T10:00:00.000Z';

function merge(primaryConsent, duplicateConsent) {
  const result = mergeContacts({
    companyId: CO,
    primary: {
      id: 'c-primary',
      companyId: CO,
      email: 'jane@example.com',
      phone: '+61412345678',
      name: 'Jane',
      tags: [],
      consent: primaryConsent,
    },
    duplicate: {
      id: 'c-duplicate',
      companyId: CO,
      email: 'jane@example.com',
      phone: '+61412345678',
      name: 'Jane',
      tags: [],
      consent: duplicateConsent,
    },
    actorId: 'user-42',
    now: NOW,
  });
  assert.equal(result.ok, true);
  return result.merged;
}

// Convert merged entries (granted flag) into the ConsentEvent shape checkConsent reads.
function asContact(merged) {
  return {
    handles: { email: 'jane@example.com', phone: '+61412345678' },
    consents: merged.consent.map((e) => ({
      channel: e.channel,
      action: e.granted ? 'opt_in' : 'opt_out',
      at: e.at,
      source: e.source,
    })),
  };
}

function consentFor(merged, channel) {
  return checkConsent({ channel, contact: asContact(merged), now: NOW });
}

test('an opt-out in the duplicate blocks that channel on the merged contact', () => {
  const merged = merge(
    [{ channel: 'sms', granted: true, at: '2026-01-01T00:00:00.000Z', source: 'form' }],
    [{ channel: 'sms', granted: false, at: '2026-02-01T00:00:00.000Z', source: 'contact' }],
  );
  assert.deepEqual(consentFor(merged, 'sms'), { allowed: false, reason: 'opted_out' });
});

test('a later contact opt-in on the other contact does not revive an opted-out channel', () => {
  const merged = merge(
    [{ channel: 'email', granted: false, at: '2026-01-01T00:00:00.000Z', source: 'contact' }],
    [{ channel: 'email', granted: true, at: '2026-03-01T00:00:00.000Z', source: 'contact' }],
  );
  assert.deepEqual(consentFor(merged, 'email'), { allowed: false, reason: 'opted_out' });
});

test('a channel-wide opt-out ("all") blocks every channel even if a later opt-in exists', () => {
  const merged = merge(
    [{ channel: 'all', granted: false, at: '2026-01-01T00:00:00.000Z', source: 'contact' }],
    [{ channel: 'whatsapp', granted: true, at: '2026-04-01T00:00:00.000Z', source: 'contact' }],
  );
  assert.deepEqual(consentFor(merged, 'whatsapp'), { allowed: false, reason: 'opted_out' });
  assert.deepEqual(consentFor(merged, 'email'), { allowed: false, reason: 'opted_out' });
});

test('channels without any opt-out keep their opt-in', () => {
  const merged = merge(
    [{ channel: 'email', granted: true, at: '2026-01-01T00:00:00.000Z', source: 'form' }],
    [{ channel: 'sms', granted: false, at: '2026-02-01T00:00:00.000Z', source: 'contact' }],
  );
  assert.deepEqual(consentFor(merged, 'email'), { allowed: true });
  assert.deepEqual(consentFor(merged, 'sms'), { allowed: false, reason: 'opted_out' });
});

test('original history is kept and the opt-out is added as a system entry', () => {
  const primary = [
    { channel: 'sms', granted: true, at: '2026-01-01T00:00:00.000Z', source: 'form' },
  ];
  const duplicate = [
    { channel: 'sms', granted: false, at: '2026-02-01T00:00:00.000Z', source: 'contact' },
  ];
  const merged = merge(primary, duplicate);
  assert.equal(merged.consent.length, 3);
  assert.deepEqual(merged.consent[0], primary[0]);
  assert.deepEqual(merged.consent[1], duplicate[0]);
  assert.equal(merged.consent[2].channel, 'sms');
  assert.equal(merged.consent[2].granted, false);
  assert.equal(merged.consent[2].source, 'system');
});

test('merging with no opt-outs adds no entries', () => {
  const merged = merge(
    [{ channel: 'email', granted: true, at: '2026-01-01T00:00:00.000Z', source: 'form' }],
    [{ channel: 'sms', granted: true, at: '2026-02-01T00:00:00.000Z', source: 'import' }],
  );
  assert.equal(merged.consent.length, 2);
  assert.deepEqual(consentFor(merged, 'sms'), { allowed: true });
});
