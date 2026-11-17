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

export interface DeadLetter {
  id: string;
  companyId: string;
  connectorId: string;
  eventId: string;
  event: InboundEvent;
  reason: ReasonCode;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export interface CursorStore {
  get(companyId: string, connectorId: string): Promise<string | null>;
  set(companyId: string, connectorId: string, cursor: string): Promise<void>;
}

export interface IdentityStore {
  /** Canonical id linked to a vendor record, or null. */
  canonicalFor(companyId: string, connectorId: string, entity: EntityType, externalId: string): Promise<string | null>;
  link(companyId: string, connectorId: string, entity: EntityType, externalId: string, canonicalId: string): Promise<void>;
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

export interface SyncStores {
  cursors: CursorStore;
  identities: IdentityStore;
  records: RecordStore;
  ledger: LedgerStore;
  deadLetters: DeadLetterStore;
}

const key = (...parts: string[]) => parts.join('\u0000');

export function createMemorySyncStores(): SyncStores {
  const cursors = new Map<string, string>();
  const identities = new Map<string, string>();
  const records = new Map<string, CanonicalRecord & { companyId: string }>();
  const ledger = new Set<string>();
  const dead = new Map<string, DeadLetter>();

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
      async link(c, conn, entity, externalId, canonicalId) {
        identities.set(key(c, conn, entity, externalId), canonicalId);
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
  };
}

/** The view an operator sees: same entry with the event payload passed through the audit redaction rules. */
export function redactedDeadLetter(entry: DeadLetter): Omit<DeadLetter, 'event'> & { event: unknown } {
  const { event, ...rest } = entry;
  return { ...rest, event: redactPayload(event) };
}
