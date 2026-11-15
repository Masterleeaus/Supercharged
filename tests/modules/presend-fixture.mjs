// Shared test fixture (not a test file). A pre-send gate that consents every recipient on the
// channel they are addressed on, with no quiet hours and an empty suppression list. Used only by
// tests that exercise inbox behaviour other than the gate itself. Gate-specific tests build their own.
import { createPreSendGate } from '../../server/modules/comms/presend-gate.ts';
import { createSuppressionList } from '../../server/modules/comms/suppression.ts';

export function consentingGate({ blocked = [] } = {}) {
  return createPreSendGate({
    suppression: createSuppressionList(),
    async loadContact(_companyId, channel, address) {
      return {
        handles: channel === 'email' ? { email: address } : { phone: address },
        consents: [{ channel, action: 'opt_in', at: '2026-01-01T00:00:00Z', source: 'contact' }],
        timezone: 'Australia/Melbourne',
      };
    },
    async loadQuietHours() {
      return null;
    },
    now: () => new Date('2026-11-02T03:00:00Z'),
    async recordBlocked(record) {
      blocked.push(record);
    },
  });
}
