/**
 * Serialises async work per key inside this process. Used so two requests for the same cart or
 * checkout cannot interleave their read-check-write steps. A Drizzle deployment should use row locks
 * (SELECT ... FOR UPDATE) instead, and the lock is then only a second guard.
 */
export type KeyedLock = <T>(key: string, work: () => Promise<T>) => Promise<T>;

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<void>>();

  return async function run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    tails.set(key, tail);

    await previous;
    try {
      return await work();
    } finally {
      release();
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    }
  };
}

/**
 * No-op lock for a database deployment. The storage transaction and its row locks carry the guarantee
 * there, so the in-process keyed lock is not used (integration fix 3).
 */
export const passThroughLock: KeyedLock = <T>(_key: string, work: () => Promise<T>): Promise<T> => work();
