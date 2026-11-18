/**
 * Storage interfaces for the sync engine (#352), with in-memory implementations for tests and for the
 * engine's contract. A database-backed store implements the same interfaces. Pure: no I/O here.
 */
import type { EntityType } from '../sdk/contract.ts';
import { redactPayload } from '../sdk/audit.ts';

/** One change as the vendor reports it. eventId is unique per connector and identifies a replayed delivery. */
export interface InboundEvent {
  eventId: string;
  entity: EntityType;
  externalId: string;
  /** Our canonical id, when the vendor record carries it (for example in metadata). Used for dedupe. */
  canonicalId?: string;
  op: 'upsert' | 'delete';
  data: Record<string, unknown>;
  /** The vendor's own timestamp for the change. Used by latest_wins. */
  updatedAt: string;
}

/** One local change waiting to be pushed to the vendor. There is at most one pending change per canonical record. */
export interface OutboundChange {
  /** Stable id of the pending change. Also the idempotency key sent to the vendor. */
  id: string;
  connectorId: string;
  entity: EntityType;
  canonicalId: string;
  op: 'upsert' | 'delete';
  data: Record<string, unknown>;
  /** When the local edit was made. Used by latest_wins. */
  updatedAt: string;
  /** The vendor version the local edit was made against. Null when the record was not yet linked. */
  baseUpdatedAt: string | null;
  createdAt: string;
}

export interface CanonicalRecord {
  id: string;
  entity: EntityType;
  updatedAt: string;
  origin: 'local' | 'remote';
  data: Record<string, unknown>;
  deleted: boolean;
}

export const REASON_CODES = [
  'validation',
  'conflict_manual',
  'auth',
  'rate_limited',
  'upstream',
  'unknown',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export type Direction = 'inbound' | 'outbound';

interface DeadLetterBase {
  id: string;
  companyId: string;
  connectorId: string;
  eventId: string;
  reason: ReasonCode;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A failed change. direction says which payload `event` holds. Rows written before outbound sync existed have
 * no direction and are inbound.
 */
export type DeadLetter =
  | (DeadLetterBase & { direction: 'inbound'; event: InboundEvent })
  | (DeadLetterBase & { direction: 'outbound'; event: OutboundChange });

export interface CursorStore {
  get(companyId: string, connectorId: string): Promise<string | null>;
  set(companyId: string, connectorId: string, cursor: string): Promise<void>;
}

export interface IdentityStore {
  /** Canonical id linked to a vendor record, or null. */
  canonicalFor(companyId: string, connectorId: string, entity: EntityType, externalId: string): Promise<string | null>;
  /** Vendor id linked to a canonical record, or null. */
  externalFor(companyId: string, connectorId: string, entity: EntityType, canonicalId: string): Promise<string | null>;
  link(companyId: string, connectorId: string, entity: EntityType, externalId: string, canonicalId: string): Promise<void>;
  /** Newest vendor timestamp seen for a linked record (from a pull, a webhook or a push response), or null. */
  remoteUpdatedAt(companyId: string, connectorId: string, entity: EntityType, externalId: string): Promise<string | null>;
  setRemoteUpdatedAt(companyId: string, connectorId: string, entity: EntityType, externalId: string, updatedAt: string): Promise<void>;
}

export interface RecordStore {
  get(companyId: string, entity: EntityType, id: string): Promise<CanonicalRecord | null>;
  put(companyId: string, record: CanonicalRecord): Promise<void>;
}

/** Records which vendor events were applied, so a replayed delivery is a no-op. */
export interface LedgerStore {
  seen(companyId: string, connectorId: string, eventId: string): Promise<boolean>;
  mark(companyId: string, connectorId: string, eventId: string): Promise<void>;
}

export interface DeadLetterStore {
  add(entry: DeadLetter): Promise<void>;
  byEvent(companyId: string, connectorId: string, eventId: string): Promise<DeadLetter | null>;
  get(companyId: string, id: string): Promise<DeadLetter | null>;
  update(entry: DeadLetter): Promise<void>;
  remove(companyId: string, id: string): Promise<void>;
  list(companyId: string, connectorId?: string): Promise<DeadLetter[]>;
}

/** Pending local changes. A database store needs a unique index on (company, connector, entity, canonical id). */
export interface OutboxStore {
  /** Inserts or replaces the pending change with the same id. */
  put(companyId: string, change: OutboundChange): Promise<void>;
  pendingFor(companyId: string, connectorId: string, entity: EntityType, canonicalId: string): Promise<OutboundChange | null>;
  /** Pending changes for a connector, oldest first. */
  pending(companyId: string, connectorId: string): Promise<OutboundChange[]>;
  remove(companyId: string, id: string): Promise<void>;
}

export interface SyncStores {
  cursors: CursorStore;
  identities: IdentityStore;
  records: RecordStore;
  ledger: LedgerStore;
  deadLetters: DeadLetterStore;
  outbox: OutboxStore;
}

const key = (...parts: string[]) => parts.join('\u0000');

export function createMemorySyncStores(): SyncStores {
  const cursors = new Map<string, string>();
  const identities = new Map<string, string>();
  const remoteVersions = new Map<string, string>();
  const records = new Map<string, CanonicalRecord & { companyId: string }>();
  const ledger = new Set<string>();
  const dead = new Map<string, DeadLetter>();
  const outbox = new Map<string, OutboundChange & { companyId: string; entity: EntityType }>();

  return {
    cursors: {
      async get(c, conn) {
        return cursors.get(key(c, conn)) ?? null;
      },
      async set(c, conn, cursor) {
        cursors.set(key(c, conn), cursor);
      },
    },
    identities: {
      async canonicalFor(c, conn, entity, externalId) {
        return identities.get(key(c, conn, entity, externalId)) ?? null;
      },
      async externalFor(c, conn, entity, canonicalId) {
        const prefix = key(c, conn, entity, '');
        for (const [k, v] of identities) {
          if (k.startsWith(prefix) && v === canonicalId) return k.slice(prefix.length);
        }
        return null;
      },
      async link(c, conn, entity, externalId, canonicalId) {
        identities.set(key(c, conn, entity, externalId), canonicalId);
      },
      async remoteUpdatedAt(c, conn, entity, externalId) {
        return remoteVersions.get(key(c, conn, entity, externalId)) ?? null;
      },
      async setRemoteUpdatedAt(c, conn, entity, externalId, updatedAt) {
        remoteVersions.set(key(c, conn, entity, externalId), updatedAt);
      },
    },
    records: {
      async get(c, entity, id) {
        const row = records.get(key(c, entity, id));
        return row ? { ...row, data: { ...row.data } } : null;
      },
      async put(c, record) {
        records.set(key(c, record.entity, record.id), { ...record, companyId: c, data: { ...record.data } });
      },
    },
    ledger: {
      async seen(c, conn, eventId) {
        return ledger.has(key(c, conn, eventId));
      },
      async mark(c, conn, eventId) {
        ledger.add(key(c, conn, eventId));
      },
    },
    deadLetters: {
      async add(entry) {
        dead.set(key(entry.companyId, entry.id), { ...entry });
      },
      async byEvent(c, conn, eventId) {
        for (const row of dead.values()) {
          if (row.companyId === c && row.connectorId === conn && row.eventId === eventId) return { ...row };
        }
        return null;
      },
      async get(c, id) {
        const row = dead.get(key(c, id));
        return row ? { ...row } : null;
      },
      async update(entry) {
        dead.set(key(entry.companyId, entry.id), { ...entry });
      },
      async remove(c, id) {
        dead.delete(key(c, id));
      },
      async list(c, conn) {
        return [...dead.values()].filter((r) => r.companyId === c && (conn === undefined || r.connectorId === conn)).map((r) => ({ ...r }));
      },
    },
    outbox: {
      async put(c, change) {
        outbox.set(key(c, change.id), { ...change, companyId: c, data: { ...change.data } });
      },
      async pendingFor(c, conn, entity, canonicalId) {
        for (const row of outbox.values()) {
          if (row.companyId === c && row.connectorId === conn && row.entity === entity && row.canonicalId === canonicalId) {
            return { ...row, data: { ...row.data } };
          }
        }
        return null;
      },
      async pending(c, conn) {
        return [...outbox.values()]
          .filter((r) => r.companyId === c && r.connectorId === conn)
          .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
          .map(({ companyId: _c, ...rest }) => ({ ...rest, data: { ...rest.data } }));
      },
      async remove(c, id) {
        outbox.delete(key(c, id));
      },
    },
  };
}

/** The view an operator sees: same entry with the event payload passed through the audit redaction rules. */
export function redactedDeadLetter(entry: DeadLetter): Omit<DeadLetter, 'event'> & { event: unknown } {
  const { event, ...rest } = entry;
  return { ...rest, event: redactPayload(event) } as Omit<DeadLetter, 'event'> & { event: unknown };
}
