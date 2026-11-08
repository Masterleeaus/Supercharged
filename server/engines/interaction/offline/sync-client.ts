import { EncryptedCommandOutbox } from './command-outbox';

export interface SyncResult {
  synced: number;
  failed: number;
  conflicts: number;
}

export class OfflineSyncClient {
  public constructor(
    private readonly outbox: EncryptedCommandOutbox,
    private readonly endpoint: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async sync(headers: Record<string, string> = {}): Promise<SyncResult> {
    const result: SyncResult = { synced: 0, failed: 0, conflicts: 0 };
    for (const envelope of await this.outbox.pending()) {
      try {
        await this.outbox.markSyncing(envelope.id);
        const command = await this.outbox.decrypt(envelope.id);
        const response = await this.fetcher(this.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(command),
        });
        if (response.status === 409) {
          result.conflicts += 1;
          await this.outbox.markConflict(envelope.id, 'conflict');
          continue;
        }
        if (!response.ok) throw new Error(`Sync failed with HTTP ${response.status}.`);
        await this.outbox.markSynced(envelope.id);
        result.synced += 1;
      } catch (error) {
        result.failed += 1;
        await this.outbox.markFailed(envelope.id, error instanceof Error ? error.message : 'Unknown sync error');
      }
    }
    return result;
  }
}
