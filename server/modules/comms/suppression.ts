// Company-scoped suppression list: bounces, complaints, invalid addresses and unsubscribes.
// In memory and pure: no database, no network, no clock. Each company gets its own state,
// so one company's list is never read by another.

import { createHash } from 'node:crypto';
import { CHANNELS, type Channel } from './consent.ts';

export const SUPPRESSION_REASONS = [
  'bounce_hard',
  'bounce_soft',
  'complaint',
  'invalid_address',
  'unsubscribed',
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

// Reasons stored on an active suppression. 'soft_bounce_count' is what a third soft bounce
// records; it is not a reason a caller passes to suppress().
export type StoredSuppressionReason =
  | 'bounce_hard'
  | 'complaint'
  | 'invalid_address'
  | 'unsubscribed'
  | 'soft_bounce_count';

export const SOFT_BOUNCE_THRESHOLD = 3;

// Reasons a human may lift. Everything else is permanent.
const REOPTIN_REASONS: readonly StoredSuppressionReason[] = ['soft_bounce_count', 'unsubscribed'];

export type SuppressionErrorCode =
  | 'invalid_company'
  | 'invalid_reason'
  | 'invalid_channel'
  | 'invalid_address'
  | 'permanent'
  | 'not_suppressed'
  | 'not_loaded';

export interface AddressInput {
  address: string;
  channel: Channel | string;
  /** Who made the change, e.g. a staff id or 'system' for inbound STOP handling. Defaults to 'system'. */
  actorId?: string;
}

/** Append-only audit record for a change to the suppression set. The address itself is not stored, only a hash. */
export interface SuppressionAuditEntry {
  action: 'comms.suppression_changed';
  companyId: string;
  change: 'suppressed' | 'unsuppressed';
  channel: Channel;
  addressHash: string;
  reason: StoredSuppressionReason;
  actorId: string;
  /** ISO 8601 time from the injected clock. */
  at: string;
}

export interface SuppressionListOptions {
  /**
   * Audit sink for changes to the suppression set. Optional so existing wiring keeps working;
   * when absent, changes are applied but not recorded. Callers that need the record must pass one.
   */
  audit?: (entry: SuppressionAuditEntry) => void;
  /** Required with `audit`. Returns the ISO 8601 time for the audit entry. */
  clock?: () => string;
}

export interface SuppressInput extends AddressInput {
  reason: SuppressionReason | string;
}

export type SuppressResult =
  | { ok: true; suppressed: true; reason: StoredSuppressionReason }
  | { ok: true; suppressed: false; softBounces: number }
  | { ok: false; error: SuppressionErrorCode };

export type UnsuppressResult = { ok: true } | { ok: false; error: SuppressionErrorCode };

export interface SuppressionList {
  suppress(companyId: string, input: SuppressInput): SuppressResult;
  isSuppressed(companyId: string, input: AddressInput): boolean;
  // Stored reason for an active suppression, or null when the address is not suppressed.
  // Throws a TypeError for a non-UUID company, so a caller can never read null as "clean" by mistake.
  reasonFor(companyId: string, input: AddressInput): StoredSuppressionReason | null;
  unsuppress(companyId: string, input: AddressInput): UnsuppressResult;
}

/** One change to the suppression set, written to durable storage. The address is already normalised. */
export type SuppressionWrite =
  | { op: 'suppressed'; companyId: string; channel: Channel; address: string; reason: StoredSuppressionReason }
  | { op: 'soft_bounce'; companyId: string; channel: Channel; address: string; count: number }
  | { op: 'unsuppressed'; companyId: string; channel: Channel; address: string };

/** Rows read back for one company when its state is loaded. */
export interface SuppressionRows {
  suppressions: Array<{ channel: Channel; address: string; reason: StoredSuppressionReason }>;
  softBounces: Array<{ channel: Channel; address: string; count: number }>;
}

/** Durable backing store. Implementations must scope every call to the company id they are given. */
export interface SuppressionPersistence {
  load(companyId: string): Promise<SuppressionRows>;
  write(change: SuppressionWrite): Promise<void>;
}

/**
 * Same synchronous interface as SuppressionList, backed by PostgreSQL. A company is unknown
 * until warm() has loaded its rows, and every check for an unknown company fails closed.
 * Writes are applied to memory at once and queued to the database in order; flush() resolves
 * only after the queued writes have been committed, and rejects if any of them failed.
 */
export interface DurableSuppressionList extends SuppressionList {
  /** Loads (or refreshes) one company from storage. Call before any check or change for that company. */
  warm(companyId: string): Promise<void>;
  /** Resolves when every change made so far has reached storage. Rejects if any write failed. */
  flush(): Promise<void>;
}

export interface DurableSuppressionListOptions extends SuppressionListOptions {
  persistence: SuppressionPersistence;
}

interface Suppression {
  reason: StoredSuppressionReason;
}

interface CompanyState {
  suppressions: Map<string, Suppression>;
  softBounces: Map<string, number>;
  // Only the durable list sets this to false before warm(). The in-memory list is always loaded.
  loaded: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const PHONE_RE = /^\+?\d{7,15}$/;

// Channels that reach a phone number: their addresses are normalised as phone numbers.
const PHONE_CHANNELS: readonly string[] = ['sms', 'whatsapp', 'phone'];

function isCompanyId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isReason(value: unknown): value is SuppressionReason {
  return typeof value === 'string' && (SUPPRESSION_REASONS as readonly string[]).includes(value);
}

function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

/**
 * Normalise an address for its channel. Email is lowercased and trimmed; phone channels keep
 * digits and a single leading plus. Returns null when the result is not usable.
 */
export function normaliseAddress(channel: string, address: unknown): string | null {
  if (typeof address !== 'string') return null;
  if (PHONE_CHANNELS.includes(channel)) {
    const trimmed = address.trim();
    const leadingPlus = trimmed.startsWith('+') ? '+' : '';
    const digits = trimmed.replace(/\D/g, '');
    const candidate = leadingPlus + digits;
    return PHONE_RE.test(candidate) ? candidate : null;
  }
  const lowered = address.trim().toLowerCase();
  if (channel === 'email') {
    return EMAIL_RE.test(lowered) ? lowered : null;
  }
  // Handle-style channels (telegram, messenger, instagram): trimmed and lowercased, non-empty.
  return lowered.length > 0 ? lowered : null;
}

function addressKey(channel: string, address: string): string {
  return JSON.stringify([channel, address]);
}

function addressHash(channel: string, address: string): string {
  return createHash('sha256').update(addressKey(channel, address)).digest('hex');
}

export function createSuppressionList(options: SuppressionListOptions = {}): SuppressionList {
  return buildSuppressionList(options, null).list;
}

/**
 * Suppression list whose state is durable in PostgreSQL (or any SuppressionPersistence).
 * Same methods as createSuppressionList. Call warm(companyId) before checking or changing a company.
 */
export function createDurableSuppressionList(options: DurableSuppressionListOptions): DurableSuppressionList {
  const persistence = options?.persistence;
  if (!persistence || typeof persistence.load !== 'function' || typeof persistence.write !== 'function') {
    throw new TypeError('persistence_required');
  }
  const built = buildSuppressionList(options, persistence);
  return built.durable!;
}

function buildSuppressionList(
  options: SuppressionListOptions,
  persistence: SuppressionPersistence | null,
): { list: SuppressionList; durable: DurableSuppressionList | null } {
  const companies = new Map<string, CompanyState>();
  if (options.audit !== undefined && typeof options.clock !== 'function') {
    throw new TypeError('clock_missing');
  }
  const audit = options.audit;
  const clock = options.clock;

  // Durable writes run one after another in the order the changes were made.
  // A failed write is kept: flush() keeps rejecting, so no caller can read success for a lost write.
  let writeQueue: Promise<void> = Promise.resolve();
  let writeFailed = false;
  function persist(change: SuppressionWrite): void {
    if (!persistence) return;
    writeQueue = writeQueue
      .then(() => persistence.write(change))
      .catch(() => {
        // The error text can carry the address, so it is not kept or logged.
        writeFailed = true;
      });
  }

  // Unknown (not warmed) companies fail closed in the durable list. The in-memory list is always loaded.
  function isLoaded(companyId: string): boolean {
    if (!persistence) return true;
    return companies.get(companyId.toLowerCase())?.loaded === true;
  }

  function record(
    change: SuppressionAuditEntry['change'],
    companyId: string,
    channel: Channel,
    address: string,
    reason: StoredSuppressionReason,
    actorId: string | undefined,
  ): void {
    if (!audit || !clock) return;
    audit({
      action: 'comms.suppression_changed',
      companyId: companyId.toLowerCase(),
      change,
      channel,
      addressHash: addressHash(channel, address),
      reason,
      actorId: typeof actorId === 'string' && actorId.length > 0 ? actorId : 'system',
      at: clock(),
    });
  }

  function stateFor(companyId: string): CompanyState {
    const id = companyId.toLowerCase();
    let state = companies.get(id);
    if (!state) {
      state = { suppressions: new Map(), softBounces: new Map(), loaded: true };
      companies.set(id, state);
    }
    return state;
  }

  function existingState(companyId: string): CompanyState | undefined {
    return companies.get(companyId.toLowerCase());
  }

  const list: SuppressionList = {
    suppress(companyId, input) {
      if (!isCompanyId(companyId)) return { ok: false, error: 'invalid_company' };
      if (!input || !isReason(input.reason)) return { ok: false, error: 'invalid_reason' };
      if (!isChannel(input.channel)) return { ok: false, error: 'invalid_channel' };
      const address = normaliseAddress(input.channel, input.address);
      if (address === null) return { ok: false, error: 'invalid_address' };
      if (!isLoaded(companyId)) return { ok: false, error: 'not_loaded' };

      const state = stateFor(companyId);
      const key = addressKey(input.channel, address);

      // Already suppressed: keep the existing record so a permanent reason is never weakened.
      const current = state.suppressions.get(key);
      if (current) return { ok: true, suppressed: true, reason: current.reason };

      let stored: StoredSuppressionReason | null = null;
      if (input.reason === 'bounce_soft') {
        const count = (state.softBounces.get(key) ?? 0) + 1;
        if (count >= SOFT_BOUNCE_THRESHOLD) {
          stored = 'soft_bounce_count';
        } else {
          state.softBounces.set(key, count);
          persist({ op: 'soft_bounce', companyId: companyId.toLowerCase(), channel: input.channel, address, count });
          return { ok: true, suppressed: false, softBounces: count };
        }
      } else {
        stored = input.reason;
      }

      state.suppressions.set(key, { reason: stored });
      state.softBounces.delete(key);
      persist({ op: 'suppressed', companyId: companyId.toLowerCase(), channel: input.channel, address, reason: stored });
      // The suppression is applied before the audit call, so a failing sink never lets an opt-out through.
      // A throw here still reaches the caller; a retry sees the address as already suppressed.
      record('suppressed', companyId, input.channel as Channel, address, stored, input.actorId);
      return { ok: true, suppressed: true, reason: stored };
    },

    isSuppressed(companyId, input) {
      // Fail closed: anything that cannot be checked is treated as suppressed.
      if (!isCompanyId(companyId) || !input || !isChannel(input.channel)) return true;
      const address = normaliseAddress(input.channel, input.address);
      if (address === null) return true;
      // Not warmed yet (durable list): the stored state is unknown, so the address is treated as suppressed.
      if (!isLoaded(companyId)) return true;
      const state = existingState(companyId);
      if (!state) return false;
      return state.suppressions.has(addressKey(input.channel, address));
    },

    reasonFor(companyId, input) {
      if (!isCompanyId(companyId)) throw new TypeError('invalid_company');
      // Null would read as "not suppressed", so an unknown company throws instead.
      if (!isLoaded(companyId)) throw new TypeError('not_loaded');
      if (!input || !isChannel(input.channel)) return null;
      const address = normaliseAddress(input.channel, input.address);
      if (address === null) return null;
      const state = existingState(companyId);
      return state?.suppressions.get(addressKey(input.channel, address))?.reason ?? null;
    },

    unsuppress(companyId, input) {
      if (!isCompanyId(companyId)) return { ok: false, error: 'invalid_company' };
      if (!input || !isChannel(input.channel)) return { ok: false, error: 'invalid_channel' };
      const address = normaliseAddress(input.channel, input.address);
      if (address === null) return { ok: false, error: 'invalid_address' };
      if (!isLoaded(companyId)) return { ok: false, error: 'not_loaded' };

      const state = existingState(companyId);
      const key = addressKey(input.channel, address);
      const current = state?.suppressions.get(key);
      if (!current) return { ok: false, error: 'not_suppressed' };
      if (!REOPTIN_REASONS.includes(current.reason)) return { ok: false, error: 'permanent' };

      // Recorded before the lift, so a lift is never applied without its audit entry.
      record('unsuppressed', companyId, input.channel as Channel, address, current.reason, input.actorId);
      state!.suppressions.delete(key);
      state!.softBounces.delete(key);
      persist({ op: 'unsuppressed', companyId: companyId.toLowerCase(), channel: input.channel, address });
      return { ok: true };
    },
  };

  if (!persistence) return { list, durable: null };

  const durable: DurableSuppressionList = {
    ...list,

    async warm(companyId) {
      if (!isCompanyId(companyId)) throw new TypeError('invalid_company');
      const key = companyId.toLowerCase();
      // Let this process's queued writes land first, so the read below includes its own changes.
      // A failed write is not thrown here: the address stays blocked, and flush() still reports it.
      await writeQueue;
      const rows = await persistence.load(key);

      // Merge, never remove: rows read from storage add to what is held in memory. A row removed
      // by another process is kept until restart, which errs on the side of blocking a send.
      let state = companies.get(key);
      if (!state) {
        state = { suppressions: new Map(), softBounces: new Map(), loaded: false };
        companies.set(key, state);
      }
      for (const row of rows.suppressions) {
        const mapKey = addressKey(row.channel, row.address);
        if (!state.suppressions.has(mapKey)) state.suppressions.set(mapKey, { reason: row.reason });
      }
      for (const row of rows.softBounces) {
        const mapKey = addressKey(row.channel, row.address);
        state.softBounces.set(mapKey, Math.max(row.count, state.softBounces.get(mapKey) ?? 0));
      }
      state.loaded = true;
    },

    async flush() {
      await writeQueue;
      // Sticky: once any write has failed, the flush keeps rejecting. The message carries no address.
      if (writeFailed) throw new Error('suppression_write_failed');
    },
  };
  return { list: durable, durable };
}
