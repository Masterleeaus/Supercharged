// Production composition of the pre-send gate. Built by server/routes/core/verified-marketing-routes.ts
// for the inbox. Its limits are deliberate and fail closed:
//   - The suppression list is in memory (see docs/records/COMMS-FLAGS-GO-LIVE-REVIEW.md). It is lost on restart.
//   - There is no durable inbox consent store yet, so loadContact returns null and every inbox send
//     is refused as 'no_consent' until one is wired.
//   - Quiet hours come from the company settings store, read in the recipient's timezone by the gate.
//   - Each block is written to the comms audit log as comms.send_blocked, with its reason.
import { buildCommsAuditEvent } from './comms-audit-events.ts';
import { createCommsAuditSink, type AuditWriter } from './audit-sink.ts';
import { createPreSendGate, type BlockedSendRecord, type PreSendGate } from './presend-gate.ts';
import { createSuppressionList } from './suppression.ts';
import { getDefaultCompanySettingsStore, type CompanySettingsStore } from '../settings/company-settings.ts';

export interface ProductionPreSendGateOptions {
  /** Durable audit writer, e.g. logAuditEvent from services/audit-log. Required. */
  write: AuditWriter;
  settings?: CompanySettingsStore;
  now?: () => Date;
}

export function createProductionPreSendGate(options: ProductionPreSendGateOptions): PreSendGate {
  if (!options || typeof options.write !== 'function') throw new TypeError('pre-send gate: audit writer required');
  const sink = createCommsAuditSink({ write: options.write });
  const settings = options.settings ?? getDefaultCompanySettingsStore();
  const now = options.now ?? (() => new Date());

  return createPreSendGate({
    suppression: createSuppressionList(),
    // No durable inbox consent store exists yet. Null means no consent record, so the send is refused.
    async loadContact() {
      return null;
    },
    async loadQuietHours(companyId) {
      const stored = await settings.getQuietHours(companyId);
      return stored.ok && stored.settings
        ? { startHour: stored.settings.startHour, endHour: stored.settings.endHour }
        : null;
    },
    now,
    async recordBlocked(record: BlockedSendRecord) {
      const built = buildCommsAuditEvent('comms.send_blocked', {
        companyId: record.companyId,
        actorId: record.actorId,
        at: record.at,
        target: record.messageId
          ? { type: 'message', id: record.messageId }
          : { type: 'send', id: record.threadId ?? 'none' },
        detail: { channel: record.channel, surface: record.surface, reason: record.reason },
      });
      await sink.forCompanyDurable(built.companyId)({
        action: built.type,
        companyId: built.companyId,
        actorId: built.actorId,
        at: built.at,
        target: built.target,
        detail: built.detail,
      });
    },
  });
}
