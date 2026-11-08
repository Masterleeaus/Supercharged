// Processed-event store for webhook idempotency.
// claim() must be atomic: it returns false when the key already exists.
// A database implementation needs a unique index on eventKey (not created here).

import type { GatewayId } from './contract.ts';

export interface ProcessedEventRecord {
  companyId: string;
  gateway: GatewayId;
  processedAtMs: number;
}

export interface ProcessedEventStore {
  // Resolves true when the key was newly recorded, false when it was already present.
  claim(eventKey: string, record: ProcessedEventRecord): Promise<boolean>;
  // Removes a claim after a failed handler so a provider retry can be processed.
  release(eventKey: string): Promise<void>;
}

export function createMemoryProcessedEventStore(): ProcessedEventStore & { size(): number } {
  const records = new Map<string, ProcessedEventRecord>();
  return {
    async claim(eventKey, record) {
      if (records.has(eventKey)) return false;
      records.set(eventKey, { ...record });
      return true;
    },
    async release(eventKey) {
      records.delete(eventKey);
    },
    size() {
      return records.size;
    },
  };
}
