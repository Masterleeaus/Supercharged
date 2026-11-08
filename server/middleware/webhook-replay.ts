/**
 * Webhook replay protection.
 *
 * Pure, dependency-free guard. A provider webhook is accepted only when it
 * carries an event id and timestamp, the timestamp is inside the window
 * around the injected clock, and the (provider, eventId) pair has not been
 * accepted before (within that key's retention).
 *
 * No timers: expired entries are swept on each check using the injected now().
 * Storage is an in-memory Map bounded by maxEntries. When full, the guard
 * either evicts the oldest entry (onFull: 'evict', the default) or refuses the
 * new event (onFull: 'refuse', fail closed).
 */

export type ReplayRefusalReason =
  | "missing_provider"
  | "missing_event_id"
  | "missing_timestamp"
  | "timestamp_out_of_window"
  | "replay"
  | "capacity";

export type ReplayCheckResult =
  | { accepted: true }
  | { accepted: false; reason: ReplayRefusalReason };

export interface ReplayCheckInput {
  provider: string;
  eventId: string | null | undefined;
  timestampMs: number | null | undefined;
}

export interface ReplayGuardOptions {
  /** Injected clock, in epoch milliseconds. */
  now: () => number;
  /** Half-width of the acceptance window, in milliseconds. */
  windowMs: number;
  /** Upper bound on stored (provider, eventId) entries. */
  maxEntries: number;
  /**
   * How long an accepted key is remembered, per provider, in milliseconds.
   * Merged over DEFAULT_RETENTION_MS_BY_PROVIDER. A provider with no entry is
   * remembered for windowMs.
   */
  retentionMsByProvider?: Readonly<Record<string, number>>;
  /**
   * What to do when maxEntries is reached after expired entries are swept.
   * 'evict' drops the oldest key (default). 'refuse' refuses the new event.
   */
  onFull?: "evict" | "refuse";
}

export interface ReplayGuard {
  check(input: ReplayCheckInput): ReplayCheckResult;
  /**
   * Forgets an accepted event. Call it when processing failed, so the provider's retry is accepted
   * and the event is not lost. Forgetting an unknown event is a no-op.
   */
  forget(input: { provider: string; eventId: string }): void;
  size(): number;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Providers whose signature carries no timestamp (Plivo V2 signs the URL, the
 * form body and a nonce only). A captured, correctly signed request stays valid
 * for as long as the key is forgotten, so its key is kept for at least 24 hours.
 */
export const DEFAULT_RETENTION_MS_BY_PROVIDER: Readonly<Record<string, number>> = {
  plivo: ONE_DAY_MS,
};

interface SeenEntry {
  acceptedAt: number;
  retentionMs: number;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function createReplayGuard(options: ReplayGuardOptions): ReplayGuard {
  const { now, windowMs, maxEntries } = options;
  const onFull = options.onFull ?? "evict";
  const retentionByProvider: Record<string, number> = {
    ...DEFAULT_RETENTION_MS_BY_PROVIDER,
    ...(options.retentionMsByProvider ?? {}),
  };

  if (typeof now !== "function") {
    throw new TypeError("createReplayGuard: now must be a function");
  }
  if (!isPositiveFiniteNumber(windowMs)) {
    throw new RangeError("createReplayGuard: windowMs must be a positive finite number");
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError("createReplayGuard: maxEntries must be a positive integer");
  }
  if (onFull !== "evict" && onFull !== "refuse") {
    throw new RangeError("createReplayGuard: onFull must be 'evict' or 'refuse'");
  }
  for (const [provider, retention] of Object.entries(retentionByProvider)) {
    if (!isPositiveFiniteNumber(retention)) {
      throw new RangeError(`createReplayGuard: retention for ${provider} must be a positive finite number`);
    }
  }

  // Key -> accepted time and retention. Map preserves insertion order.
  const seen = new Map<string, SeenEntry>();

  function keyFor(provider: string, eventId: string): string {
    // NUL cannot appear in a provider name, so the separator is unambiguous.
    return `${provider}\u0000${eventId}`;
  }

  function retentionFor(provider: string): number {
    return retentionByProvider[provider] ?? windowMs;
  }

  function sweep(current: number): void {
    for (const [key, entry] of seen) {
      if (current - entry.acceptedAt > entry.retentionMs) {
        seen.delete(key);
      }
    }
  }

  function check(input: ReplayCheckInput): ReplayCheckResult {
    const { provider, eventId, timestampMs } = input;

    if (typeof provider !== "string" || provider.length === 0) {
      return { accepted: false, reason: "missing_provider" };
    }
    if (typeof eventId !== "string" || eventId.length === 0) {
      return { accepted: false, reason: "missing_event_id" };
    }
    if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) {
      return { accepted: false, reason: "missing_timestamp" };
    }

    const current = now();
    sweep(current);

    if (Math.abs(current - timestampMs) > windowMs) {
      return { accepted: false, reason: "timestamp_out_of_window" };
    }

    const key = keyFor(provider, eventId);
    if (seen.has(key)) {
      return { accepted: false, reason: "replay" };
    }

    if (seen.size >= maxEntries) {
      if (onFull === "refuse") {
        return { accepted: false, reason: "capacity" };
      }
      const oldest = seen.keys().next().value;
      if (oldest !== undefined) {
        seen.delete(oldest);
      }
    }
    seen.set(key, { acceptedAt: current, retentionMs: retentionFor(provider) });
    return { accepted: true };
  }

  function forget(input: { provider: string; eventId: string }): void {
    if (typeof input.provider !== "string" || typeof input.eventId !== "string") return;
    seen.delete(keyFor(input.provider, input.eventId));
  }

  return {
    check,
    forget,
    size: () => seen.size,
  };
}
