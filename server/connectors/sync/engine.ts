/**
 * Sync engine (#352): two-way sync. Inbound: polling and webhook intake, a cursor per company and connector,
 * dedupe on external id and canonical id. Outbound: local changes are staged in an outbox (one pending change
 * per canonical record) and pushed to the vendor with an idempotency key. Per-entity conflict rules apply in
 * both directions. Failed changes, in either direction, go to a dead-letter queue with reason codes, and
 * replay retries them.
 *
 * Guarantees:
 * - No silent loss: a change that cannot be applied or pushed is dead-lettered with a reason code, never dropped.
 * - No duplicates: a vendor event id already in the ledger is a no-op; a vendor record already linked to a
 *   canonical id updates that record instead of creating a second one. Pushes carry the outbox id as an
 *   idempotency key, so a replayed push after a lost response does not create a second vendor record.
 * - Replay is safe: replaying a dead letter applies it at most once. An outbound dead letter superseded by a
 *   newer pending local change is dropped, so an old value never overwrites a newer one.
 * - No echo loop: applying an inbound change never stages an outbound change.
 *
 * Pure apart from the injected stores and clock.
 */
import { ConnectorError, type EntityType } from '../sdk/contract.ts';
import { DEFAULT_CONFLICT_RULES, resolveConflict, resolveOutbound, type ConflictRule } from './conflict.ts';
import {
  type CanonicalRecord,
  type DeadLetter,
  type InboundEvent,
  type OutboundChange,
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

export interface FlushReport {
  pushed: number;
  ignored: number;
  deadLettered: number;
  /** Changes still waiting in the outbox after this flush. */
  pending: number;
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

/** A local write. canonicalId is ours; baseUpdatedAt is the vendor version the edit was made against. */
export interface LocalChange {
  entity: EntityType;
  canonicalId?: string;
  op: 'upsert' | 'delete';
  data: Record<string, unknown>;
  updatedAt: string;
  baseUpdatedAt?: string | null;
}

export type StageResult =
  | { status: 'staged'; canonicalId: string; outboundId: string }
  | { status: 'refused'; reason: 'system_of_record' | 'validation' | 'stale' };

/** What the vendor needs to receive one local change. externalId is null when the record is new to the vendor. */
export interface OutboundPayload {
  idempotencyKey: string;
  entity: EntityType;
  canonicalId: string;
  externalId: string | null;
  op: 'upsert' | 'delete';
  data: Record<string, unknown>;
  updatedAt: string;
}

/** The vendor's answer to a push. Throws ConnectorError on failure. */
export type PushFn = (change: OutboundPayload) => Promise<{ externalId: string; updatedAt: string }>;

export interface SyncEngine {
  /** Polls the vendor from the stored cursor, applies each event, then advances the cursor. */
  pull(companyId: string, connectorId: string, fetchChanges: (cursor: string | null) => Promise<PullPage>): Promise<SyncReport>;
  /** Applies webhook deliveries. Redelivered events are skipped by the ledger. */
  receive(companyId: string, connectorId: string, events: InboundEvent[]): Promise<SyncReport>;
  /** Stages a local write: updates the canonical record and queues one pending push for it. */
  stageLocal(companyId: string, connectorId: string, change: LocalChange): Promise<StageResult>;
  /** Pushes pending local changes, oldest first. Failures are dead-lettered. */
  flush(companyId: string, connectorId: string, push: PushFn): Promise<FlushReport>;
  /** Pending local changes for a connector, oldest first. */
  pendingChanges(companyId: string, connectorId: string): Promise<OutboundChange[]>;
  /**
   * Re-runs one dead letter. Returns 'replayed' when it applied (or was already applied or superseded),
   * 'failed' when it did not. An outbound dead letter needs push; without it the result is 'failed' and nothing changes.
   */
  replay(companyId: string, deadLetterId: string, push?: PushFn): Promise<'replayed' | 'failed' | 'not_found'>;
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

  /** Keeps the newest vendor version seen for a linked record. Older timestamps never move it back. */
  async function advanceRemote(companyId: string, connectorId: string, entity: EntityType, externalId: string, updatedAt: string): Promise<void> {
    const prev = await stores.identities.remoteUpdatedAt(companyId, connectorId, entity, externalId);
    if (prev !== null && Date.parse(prev) >= Date.parse(updatedAt)) return;
    await stores.identities.setRemoteUpdatedAt(companyId, connectorId, entity, externalId, updatedAt);
  }

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
    await advanceRemote(companyId, connectorId, event.entity, event.externalId, event.updatedAt);
    await stores.ledger.mark(companyId, connectorId, event.eventId);
    return outcome;
  }

  /** Pushes one pending change. Returns 'pushed' or 'ignored'. Throws SyncFailure or ConnectorError otherwise. */
  async function pushOne(companyId: string, change: OutboundChange, push: PushFn): Promise<'pushed' | 'ignored'> {
    const { connectorId, entity, canonicalId } = change;
    const externalId = await stores.identities.externalFor(companyId, connectorId, entity, canonicalId);
    if (externalId === null && change.op === 'delete') return 'ignored';
    const remote = externalId === null ? null : await stores.identities.remoteUpdatedAt(companyId, connectorId, entity, externalId);

    const resolution = resolveOutbound(rules[entity], { updatedAt: change.updatedAt, baseUpdatedAt: change.baseUpdatedAt }, remote);
    if (resolution.action === 'manual') throw new SyncFailure('conflict_manual', SAFE_MESSAGE.conflict_manual);
    if (resolution.action === 'ignore') return 'ignored';

    const result = await push({
      idempotencyKey: change.id,
      entity,
      canonicalId,
      externalId,
      op: change.op,
      data: { ...change.data },
      updatedAt: change.updatedAt,
    });
    if (Number.isNaN(Date.parse(result.updatedAt))) throw new SyncFailure('validation', 'vendor updatedAt is not a timestamp');
    if (externalId !== null && result.externalId !== externalId) throw new SyncFailure('validation', 'vendor returned a different record id');
    const owner = await stores.identities.canonicalFor(companyId, connectorId, entity, result.externalId);
    if (owner !== null && owner !== canonicalId) throw new SyncFailure('validation', 'vendor id is already linked to another record');
    if (externalId === null) await stores.identities.link(companyId, connectorId, entity, result.externalId, canonicalId);
    await advanceRemote(companyId, connectorId, entity, result.externalId, result.updatedAt);
    return 'pushed';
  }

  /** Puts a failed change on the dead-letter queue. A change already dead-lettered is counted as another attempt. */
  async function deadLetterOutbound(companyId: string, change: OutboundChange, err: unknown): Promise<void> {
    const reason = reasonFor(err);
    const at = now().toISOString();
    const eventId = `outbound:${change.id}`;
    const existing = await stores.deadLetters.byEvent(companyId, change.connectorId, eventId);
    if (existing) {
      await stores.deadLetters.update({ ...existing, reason, attempts: existing.attempts + 1, updatedAt: at });
      return;
    }
    await stores.deadLetters.add({
      id: newId(),
      companyId,
      connectorId: change.connectorId,
      eventId,
      direction: 'outbound',
      event: { ...change, data: { ...change.data } },
      reason,
      attempts: 1,
      createdAt: at,
      updatedAt: at,
    });
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
        direction: 'inbound',
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

    async stageLocal(companyId, connectorId, change) {
      if (Number.isNaN(Date.parse(change.updatedAt))) return { status: 'refused', reason: 'validation' };
      const rule = rules[change.entity];
      if (rule.strategy === 'system_of_record' && rule.owner === 'remote') return { status: 'refused', reason: 'system_of_record' };

      const canonicalId = change.canonicalId ?? newId();
      const externalId = await stores.identities.externalFor(companyId, connectorId, change.entity, canonicalId);
      const remote = externalId === null ? null : await stores.identities.remoteUpdatedAt(companyId, connectorId, change.entity, externalId);
      // latest_wins: a local edit older than the vendor's current version loses at once and is not written.
      if (rule.strategy === 'latest_wins' && remote !== null && Date.parse(remote) > Date.parse(change.updatedAt)) {
        return { status: 'refused', reason: 'stale' };
      }

      const existing = await stores.records.get(companyId, change.entity, canonicalId);
      const deleted = change.op === 'delete';
      await stores.records.put(companyId, {
        id: canonicalId,
        entity: change.entity,
        updatedAt: change.updatedAt,
        origin: 'local',
        data: deleted ? { ...(existing?.data ?? {}) } : { ...change.data },
        deleted,
      });

      // Coalesce: a second edit before the first push replaces its data, keeps its id and keeps its base version.
      const queued = await stores.outbox.pendingFor(companyId, connectorId, change.entity, canonicalId);
      let next: OutboundChange;
      if (queued) {
        next = { ...queued, op: change.op, data: { ...change.data }, updatedAt: change.updatedAt };
      } else {
        next = {
          id: newId(),
          connectorId,
          entity: change.entity,
          canonicalId,
          op: change.op,
          data: { ...change.data },
          updatedAt: change.updatedAt,
          baseUpdatedAt: change.baseUpdatedAt !== undefined ? change.baseUpdatedAt : remote,
          createdAt: now().toISOString(),
        };
      }
      await stores.outbox.put(companyId, next);
      return { status: 'staged', canonicalId, outboundId: next.id };
    },

    async flush(companyId, connectorId, push) {
      const report: FlushReport = { pushed: 0, ignored: 0, deadLettered: 0, pending: 0 };
      for (const change of await stores.outbox.pending(companyId, connectorId)) {
        try {
          if ((await pushOne(companyId, change, push)) === 'pushed') report.pushed += 1;
          else report.ignored += 1;
        } catch (err) {
          report.deadLettered += 1;
          await deadLetterOutbound(companyId, change, err);
        }
        await stores.outbox.remove(companyId, change.id);
      }
      report.pending = (await stores.outbox.pending(companyId, connectorId)).length;
      return report;
    },

    pendingChanges(companyId, connectorId) {
      return stores.outbox.pending(companyId, connectorId);
    },

    async replay(companyId, deadLetterId, push) {
      const entry = await stores.deadLetters.get(companyId, deadLetterId);
      if (!entry) return 'not_found';
      try {
        if (entry.direction === 'outbound') {
          if (!push) return 'failed';
          const superseded = await stores.outbox.pendingFor(companyId, entry.connectorId, entry.event.entity, entry.event.canonicalId);
          if (!superseded) await pushOne(companyId, entry.event, push);
        } else {
          await applyEvent(companyId, entry.connectorId, entry.event);
        }
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
