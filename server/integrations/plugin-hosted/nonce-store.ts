/**
 * Single-use nonce store for the replay check. A nonce is recorded until its signature window
 * closes; a second claim before that time is refused. The default is in-memory and per process.
 * A multi-instance deployment needs a shared implementation of the same interface.
 */
export interface NonceStore {
  /** Returns true when the nonce is new (and records it until expiresAtMs), false when it was already seen. */
  claim(nonce: string, expiresAtMs: number, nowMs: number): boolean | Promise<boolean>;
}

export function createMemoryNonceStore(options: { sweepEveryMs?: number } = {}): NonceStore {
  const sweepEveryMs = options.sweepEveryMs ?? 60_000;
  const expiries = new Map<string, number>();
  let nextSweepAt = 0;

  return {
    claim(nonce, expiresAtMs, nowMs) {
      if (nowMs >= nextSweepAt) {
        for (const [seen, expiry] of expiries) {
          if (expiry <= nowMs) expiries.delete(seen);
        }
        nextSweepAt = nowMs + sweepEveryMs;
      }
      const existing = expiries.get(nonce);
      if (existing !== undefined && existing > nowMs) return false;
      expiries.set(nonce, expiresAtMs);
      return true;
    },
  };
}
