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
  | 'not_suppressed';

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

interface Suppression {
  reason: StoredSuppressionReason;
}

interface CompanyState {
  suppressions: Map<string, Suppression>;
  softBounces: Map<string, number>;
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
  const companies = new Map<string, CompanyState>();
  if (options.audit !== undefined && typeof options.clock !== 'function') {
    throw new TypeError('clock_missing');
  }
  const audit = options.audit;
  const clock = options.clock;

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
      state = { suppressions: new Map(), softBounces: new Map() };
      companies.set(id, state);
    }
    return state;
  }

  function existingState(companyId: string): CompanyState | undefined {
    return companies.get(companyId.toLowerCase());
  }

  return {
    suppress(companyId, input) {
      if (!isCompanyId(companyId)) return { ok: false, error: 'invalid_company' };
      if (!input || !isReason(input.reason)) return { ok: false, error: 'invalid_reason' };
      if (!isChannel(input.channel)) return { ok: false, error: 'invalid_channel' };
      const address = normaliseAddress(input.channel, input.address);
      if (address === null) return { ok: false, error: 'invalid_address' };

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
          return { ok: true, suppressed: false, softBounces: count };
        }
      } else {
        stored = input.reason;
      }

      state.suppressions.set(key, { reason: stored });
      state.softBounces.delete(key);
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
      const state = existingState(companyId);
      if (!state) return false;
      return state.suppressions.has(addressKey(input.channel, address));
    },

    reasonFor(companyId, input) {
      if (!isCompanyId(companyId)) throw new TypeError('invalid_company');
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

      const state = existingState(companyId);
      const key = addressKey(input.channel, address);
      const current = state?.suppressions.get(key);
      if (!current) return { ok: false, error: 'not_suppressed' };
      if (!REOPTIN_REASONS.includes(current.reason)) return { ok: false, error: 'permanent' };

      // Recorded before the lift, so a lift is never applied without its audit entry.
      record('unsuppressed', companyId, input.channel as Channel, address, current.reason, input.actorId);
      state!.suppressions.delete(key);
      state!.softBounces.delete(key);
      return { ok: true };
    },
  };
}
