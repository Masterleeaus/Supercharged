/**
 * Sync engine (#352): polling and webhook intake, a cursor per company and connector, dedupe on external
 * id and canonical id, per-entity conflict rules, a dead-letter queue with reason codes, replay, and
 * idempotent handling of replayed deliveries.
 *
 * Guarantees:
 * - No silent loss: an event that cannot be applied is dead-lettered with a reason code, never dropped.
 * - No duplicates: a vendor event id already in the ledger is a no-op; a vendor record already linked to a
 *   canonical id updates that record instead of creating a second one.
 * - Replay is safe: replaying a dead letter applies it at most once.
 *
 * Pure apart from the injected stores and clock.
 */
import { ConnectorError, type EntityType } from '../sdk/contract.ts';
import { DEFAULT_CONFLICT_RULES, resolveConflict, type ConflictRule } from './conflict.ts';
import {
  type CanonicalRecord,
  type DeadLetter,
  type InboundEvent,
  type ReasonCode,
  type SyncStores,
} from './stores.ts';

export class SyncFailure extends Error {
  readonly reason: ReasonCode;
  constructor(reason: ReasonCode, message: string) {
    super(message);
    this.name = 'SyncFailure';
    this.reason = reason;
  }
}

export interface SyncReport {
  applied: number;
  duplicate: number;
  ignored: number;
  deadLettered: number;
  cursor: string | null;
}

export interface SyncEngineOptions {
  stores: SyncStores;
  rules?: Partial<Record<EntityType, ConflictRule>>;
  now?: () => Date;
  newId?: () => string;
}

export interface PullPage {
  events: InboundEvent[];
  nextCursor: string | null;
}

export interface SyncEngine {
  /** Polls the vendor from the stored cursor, applies each event, then advances the cursor. */
  pull(companyId: string, connectorId: string, fetchChanges: (cursor: string | null) => Promise<PullPage>): Promise<SyncReport>;
  /** Applies webhook deliveries. Redelivered events are skipped by the ledger. */
  receive(companyId: string, connectorId: string, events: InboundEvent[]): Promise<SyncReport>;
  /** Re-runs one dead letter. Returns 'replayed' when it applied (or was already applied), 'failed' when it did not. */
  replay(companyId: string, deadLetterId: string): Promise<'replayed' | 'failed' | 'not_found'>;
  deadLetters(companyId: string, connectorId?: string): Promise<DeadLetter[]>;
}

const REASON_FOR_ERROR: Record<string, ReasonCode> = {
  auth: 'auth',
  rate_limited: 'rate_limited',
  upstream: 'upstream',
  timeout: 'upstream',
  validation: 'validation',
};

function reasonFor(err: unknown): ReasonCode {
  if (err instanceof SyncFailure) return err.reason;
  if (err instanceof ConnectorError) return REASON_FOR_ERROR[err.code] ?? 'unknown';
  return 'unknown';
}

/** Safe, fixed message per reason. Vendor and storage messages are never stored on a dead letter. */
const SAFE_MESSAGE: Record<ReasonCode, string> = {
  validation: 'The change did not match the expected shape',
  conflict_manual: 'Both copies changed and need a manual decision',
  auth: 'The connector credentials were refused',
  rate_limited: 'The vendor rate limit was reached',
  upstream: 'The vendor was unavailable',
  unknown: 'The change could not be applied',
};

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { stores } = options;
  const rules: Record<EntityType, ConflictRule> = { ...DEFAULT_CONFLICT_RULES, ...(options.rules as Record<EntityType, ConflictRule>) };
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => globalThis.crypto.randomUUID());

  /** Applies one event. Returns 'applied', 'duplicate' or 'ignored'. Throws SyncFailure or ConnectorError otherwise. */
  async function applyEvent(companyId: string, connectorId: string, event: InboundEvent): Promise<'applied' | 'duplicate' | 'ignored'> {
    if (await stores.ledger.seen(companyId, connectorId, event.eventId)) return 'duplicate';
    if (Number.isNaN(Date.parse(event.updatedAt))) throw new SyncFailure('validation', 'updatedAt is not a timestamp');

    let canonicalId = await stores.identities.canonicalFor(companyId, connectorId, event.entity, event.externalId);
    const linked = canonicalId !== null;
    if (!canonicalId && event.canonicalId) {
      const known = await stores.records.get(companyId, event.entity, event.canonicalId);
      if (known) canonicalId = known.id;
    }
    if (canonicalId && !linked) {
      await stores.identities.link(companyId, connectorId, event.entity, event.externalId, canonicalId);
    }

    let outcome: 'applied' | 'ignored' = 'applied';
    if (!canonicalId) {
      if (event.op === 'delete') {
        await stores.ledger.mark(companyId, connectorId, event.eventId);
        return 'ignored';
      }
      canonicalId = event.canonicalId ?? newId();
      await stores.records.put(companyId, {
        id: canonicalId,
        entity: event.entity,
        updatedAt: event.updatedAt,
        origin: 'remote',
        data: event.data,
        deleted: false,
      });
      await stores.identities.link(companyId, connectorId, event.entity, event.externalId, canonicalId);
    } else {
      const local = await stores.records.get(companyId, event.entity, canonicalId);
      if (!local) throw new SyncFailure('unknown', 'linked record is missing');
      const resolution = resolveConflict(rules[event.entity], { updatedAt: local.updatedAt, data: local.data }, { updatedAt: event.updatedAt, data: event.data });
      if (resolution.action === 'manual') throw new SyncFailure('conflict_manual', SAFE_MESSAGE.conflict_manual);
      if (resolution.action === 'ignore') {
        outcome = 'ignored';
      } else {
        const next: CanonicalRecord = event.op === 'delete'
          ? { ...local, deleted: true, updatedAt: event.updatedAt }
          : { ...local, deleted: false, updatedAt: event.updatedAt, data: event.data };
        await stores.records.put(companyId, next);
      }
    }
    await stores.ledger.mark(companyId, connectorId, event.eventId);
    return outcome;
  }

  /** Runs one event; a failure goes to the dead-letter queue unless an open dead letter already holds it. */
  async function process(companyId: string, connectorId: string, event: InboundEvent, report: SyncReport): Promise<void> {
    try {
      const result = await applyEvent(companyId, connectorId, event);
      if (result === 'applied') report.applied += 1;
      else if (result === 'duplicate') report.duplicate += 1;
      else report.ignored += 1;
    } catch (err) {
      const reason = reasonFor(err);
      report.deadLettered += 1;
      const existing = await stores.deadLetters.byEvent(companyId, connectorId, event.eventId);
      const at = now().toISOString();
      if (existing) {
        await stores.deadLetters.update({ ...existing, reason, attempts: existing.attempts + 1, updatedAt: at });
        return;
      }
      await stores.deadLetters.add({
        id: newId(),
        companyId,
        connectorId,
        eventId: event.eventId,
        event: { ...event, data: { ...event.data } },
        reason,
        attempts: 1,
        createdAt: at,
        updatedAt: at,
      });
    }
  }

  const emptyReport = (cursor: string | null): SyncReport => ({ applied: 0, duplicate: 0, ignored: 0, deadLettered: 0, cursor });

  return {
    async pull(companyId, connectorId, fetchChanges) {
      const from = await stores.cursors.get(companyId, connectorId);
      const page = await fetchChanges(from);
      const report = emptyReport(from);
      for (const event of page.events) await process(companyId, connectorId, event, report);
      if (page.nextCursor !== null && page.nextCursor !== from) {
        await stores.cursors.set(companyId, connectorId, page.nextCursor);
        report.cursor = page.nextCursor;
      }
      return report;
    },

    async receive(companyId, connectorId, events) {
      const report = emptyReport(await stores.cursors.get(companyId, connectorId));
      for (const event of events) await process(companyId, connectorId, event, report);
      return report;
    },

    async replay(companyId, deadLetterId) {
      const entry = await stores.deadLetters.get(companyId, deadLetterId);
      if (!entry) return 'not_found';
      try {
        await applyEvent(companyId, entry.connectorId, entry.event);
        await stores.deadLetters.remove(companyId, deadLetterId);
        return 'replayed';
      } catch (err) {
        await stores.deadLetters.update({
          ...entry,
          reason: reasonFor(err),
          attempts: entry.attempts + 1,
          updatedAt: now().toISOString(),
        });
        return 'failed';
      }
    },

    deadLetters(companyId, connectorId) {
      return stores.deadLetters.list(companyId, connectorId);
    },
  };
}
