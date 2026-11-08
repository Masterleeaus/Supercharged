import { decryptJson, encryptJson } from './crypto';
import type { OfflineCommand, OfflineCommandInput, OutboxEnvelope, StorageAdapter } from './types';

export class EncryptedCommandOutbox {
  public constructor(
    private readonly store: StorageAdapter<OutboxEnvelope>,
    private readonly secret: string,
  ) {}

  async enqueue(input: OfflineCommandInput): Promise<OutboxEnvelope> {
    if (input.capability.trim() === '') throw new Error('Command capability is required.');
    if (input.metadata.tenant_id === '' || input.metadata.device_id === '') {
      throw new Error('Tenant and device identifiers are required for offline commands.');
    }

    const command: OfflineCommand = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    const encrypted = await encryptJson(command, this.secret);
    const envelope: OutboxEnvelope = {
      id: command.id,
      algorithm: 'AES-256-GCM',
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      status: 'pending',
      attempts: 0,
      queuedAt: command.createdAt,
    };
    await this.store.put(envelope.id, envelope);
    return envelope;
  }

  async pending(): Promise<OutboxEnvelope[]> {
    return (await this.store.all())
      .filter((item) => item.status === 'pending' || item.status === 'failed')
      .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt));
  }

  async decrypt(id: string): Promise<OfflineCommand> {
    const envelope = await this.requireEnvelope(id);
    return decryptJson<OfflineCommand>(envelope, this.secret);
  }

  async markSyncing(id: string): Promise<void> {
    const envelope = await this.requireEnvelope(id);
    await this.store.put(id, { ...envelope, status: 'syncing', attempts: envelope.attempts + 1 });
  }

  async markSynced(id: string): Promise<void> {
    const envelope = await this.requireEnvelope(id);
    const updated: OutboxEnvelope = {
      ...envelope,
      status: 'synced',
      syncedAt: new Date().toISOString(),
    };
    delete updated.lastError;
    await this.store.put(id, updated);
  }

  async markFailed(id: string, error: string): Promise<void> {
    const envelope = await this.requireEnvelope(id);
    await this.store.put(id, { ...envelope, status: 'failed', lastError: error });
  }

  async markConflict(id: string, error = 'conflict'): Promise<void> {
    const envelope = await this.requireEnvelope(id);
    await this.store.put(id, { ...envelope, status: 'conflict', lastError: error });
  }

  async remove(id: string): Promise<void> {
    await this.store.delete(id);
  }

  private async requireEnvelope(id: string): Promise<OutboxEnvelope> {
    const envelope = await this.store.get(id);
    if (envelope === undefined) throw new Error(`Outbox command '${id}' was not found.`);
    return envelope;
  }
}
