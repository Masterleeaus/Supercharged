import { decryptJson, encryptJson } from './crypto';
import type {
  CognitiveEventEnvelope,
  OfflineCognitiveEvent,
  OfflineCognitiveEventInput,
  StorageAdapter,
} from './types';

export class EncryptedCognitiveEventOutbox {
  public constructor(
    private readonly store: StorageAdapter<CognitiveEventEnvelope>,
    private readonly secret: string,
  ) {}

  async enqueue(input: OfflineCognitiveEventInput): Promise<CognitiveEventEnvelope> {
    if (input.tenantId.trim() === '' || input.deviceId.trim() === '') {
      throw new Error('Tenant and device identifiers are required for cognitive events.');
    }
    if (input.correlationId.trim() === '') throw new Error('Correlation ID is required.');
    if (!Number.isInteger(input.sequence) || input.sequence < 0) throw new Error('Sequence must be a non-negative integer.');

    const event: OfflineCognitiveEvent = {
      ...input,
      eventId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
    };
    const encrypted = await encryptJson(event, this.secret);
    const envelope: CognitiveEventEnvelope = {
      id: event.eventId,
      algorithm: 'AES-256-GCM',
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      correlationId: event.correlationId,
      sequence: event.sequence,
      status: 'pending',
      attempts: 0,
      queuedAt: event.occurredAt,
    };
    await this.store.put(envelope.id, envelope);
    return envelope;
  }

  async pending(): Promise<CognitiveEventEnvelope[]> {
    return (await this.store.all())
      .filter((event) => event.status === 'pending' || event.status === 'failed')
      .sort((left, right) => {
        const correlation = left.correlationId.localeCompare(right.correlationId);
        if (correlation !== 0) return correlation;
        if (left.sequence !== right.sequence) return left.sequence - right.sequence;
        return left.queuedAt.localeCompare(right.queuedAt);
      });
  }

  async decrypt(id: string): Promise<OfflineCognitiveEvent> {
    const envelope = await this.requireEnvelope(id);
    return decryptJson<OfflineCognitiveEvent>(envelope, this.secret);
  }

  async markSyncing(id: string): Promise<void> {
    const envelope = await this.requireEnvelope(id);
    await this.store.put(id, { ...envelope, status: 'syncing', attempts: envelope.attempts + 1 });
  }

  async markSynced(id: string): Promise<void> {
    const envelope = await this.requireEnvelope(id);
    const updated: CognitiveEventEnvelope = { ...envelope, status: 'synced' };
    delete updated.lastError;
    await this.store.put(id, updated);
  }

  async markFailed(id: string, error: string): Promise<void> {
    const envelope = await this.requireEnvelope(id);
    await this.store.put(id, { ...envelope, status: 'failed', lastError: error });
  }

  private async requireEnvelope(id: string): Promise<CognitiveEventEnvelope> {
    const envelope = await this.store.get(id);
    if (envelope === undefined) throw new Error(`Cognitive event '${id}' was not found.`);
    return envelope;
  }
}
