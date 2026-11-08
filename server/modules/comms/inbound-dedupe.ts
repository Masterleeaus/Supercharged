// Inbound provider message de-duplication for one company. No SQL, no network.
// The caller injects a store whose insert enforces a unique key on (companyId, provider, providerMessageId).
// A unique-conflict error from that store means the message was already recorded: it is a 'duplicate', not a failure.
// Any other store error is rethrown so the caller's retry path handles it.

export type InboundDedupeOutcome = 'new' | 'duplicate';

export interface InboundMessageKey {
  companyId: string;
  provider: string;
  providerMessageId: string;
}

export interface InboundDedupeStore {
  /**
   * Records the key. Resolves when it is new. Rejects with a unique-conflict error
   * (see isUniqueConflict) when the key already exists.
   */
  insert(key: InboundMessageKey): Promise<void>;
}

export const INBOUND_PROVIDER_MAX = 32;
export const INBOUND_MESSAGE_ID_MAX = 256;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_RE = /^[a-z0-9_-]+$/;

/** True when the error is a unique-key conflict from the store (Postgres 23505, or a tagged error). */
export function isUniqueConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; name?: unknown };
  return e.code === '23505' || e.name === 'UniqueConflictError';
}

/**
 * Records an inbound provider message id for a company and provider.
 * Returns 'new' on first sight and 'duplicate' on a repeat (including a store unique-conflict).
 * Throws TypeError when companyId, provider or providerMessageId is missing or malformed,
 * before the store is touched. Fails closed: an unknown tenant is never guessed.
 */
export async function recordInboundMessage(
  store: InboundDedupeStore,
  input: { companyId: unknown; provider: unknown; providerMessageId: unknown },
): Promise<InboundDedupeOutcome> {
  const { companyId, provider, providerMessageId } = input;

  if (typeof companyId !== 'string' || !UUID_RE.test(companyId)) {
    throw new TypeError('invalid_company');
  }
  if (
    typeof provider !== 'string' ||
    provider.length === 0 ||
    provider.length > INBOUND_PROVIDER_MAX ||
    !PROVIDER_RE.test(provider)
  ) {
    throw new TypeError('invalid_provider');
  }
  if (
    typeof providerMessageId !== 'string' ||
    providerMessageId.trim().length === 0 ||
    providerMessageId.length > INBOUND_MESSAGE_ID_MAX
  ) {
    throw new TypeError('invalid_message_id');
  }

  try {
    await store.insert({ companyId, provider, providerMessageId });
    return 'new';
  } catch (err) {
    if (isUniqueConflict(err)) return 'duplicate';
    throw err;
  }
}
