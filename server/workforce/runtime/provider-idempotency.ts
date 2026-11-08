/**
 * Idempotency for provider calls. Desk sends a key to the provider on every provider-facing tool call, and also
 * dedupes on its own intent key before sending. Both keys derive from the same inputs as idempotencyKey().
 *
 * - providerIdempotencyKey(): the Desk intent key from idempotency.ts, domain-separated with a sha256 so a
 *   provider key can never equal a key used by another store. Same inputs give the same key; changing companyId,
 *   runId, callIndex, toolId or params changes it.
 * - createProviderSendGuard(): an in-memory guard. claim() returns true the first time an intent key is seen and
 *   false for every repeat, so a second send of the same intent is refused.
 *
 * Pure: no timers, no database, no network.
 */

import { createHash } from 'node:crypto';
import { idempotencyKey } from './idempotency.ts';

export interface ProviderIdempotencyKeyInput {
  companyId: string;
  runId: string;
  callIndex: number;
  toolId: string;
  params: unknown;
}

const PROVIDER_DOMAIN = 'desk.provider-idempotency.v1\n';

export function providerIdempotencyKey(input: ProviderIdempotencyKeyInput): string {
  const intentKey = idempotencyKey({
    companyId: input.companyId,
    runId: input.runId,
    callIndex: input.callIndex,
    tool: input.toolId,
    params: input.params,
  });
  return createHash('sha256').update(PROVIDER_DOMAIN + intentKey, 'utf8').digest('hex');
}

export interface ProviderSendGuard {
  /** true when this is the first send for the intent key; false when it has already been sent. */
  claim(intentKey: string): boolean;
  has(intentKey: string): boolean;
}

export function createProviderSendGuard(): ProviderSendGuard {
  const sent = new Set<string>();

  return {
    claim(intentKey) {
      if (typeof intentKey !== 'string' || intentKey.length === 0) {
        throw new TypeError('intentKey must be a non-empty string');
      }
      if (sent.has(intentKey)) return false;
      sent.add(intentKey);
      return true;
    },
    has(intentKey) {
      return sent.has(intentKey);
    },
  };
}
