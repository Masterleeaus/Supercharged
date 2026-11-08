/**
 * In-memory adapters for the ops ports. Used by tests and by any local wiring that has no database.
 * Same rules as the Drizzle adapters: company-scoped reads, and a row from another company reads as absent.
 */
import type { AttachmentRecord } from "../contracts/index.ts";
import type { AttachmentBlobStore, AttachmentMetaStore } from "./attachments.ts";

export class InMemoryAttachmentMeta implements AttachmentMetaStore {
  private readonly rows = new Map<string, { record: AttachmentRecord; deletedAt: Date | null }>();

  private static key(companyId: string, attachmentId: string): string {
    return `${companyId}:${attachmentId}`;
  }

  async insert(record: AttachmentRecord): Promise<void> {
    const key = InMemoryAttachmentMeta.key(record.companyId, record.id);
    if (this.rows.has(key)) throw new Error("duplicate attachment id");
    this.rows.set(key, { record: { ...record }, deletedAt: null });
  }

  async find(companyId: string, attachmentId: string): Promise<AttachmentRecord | null> {
    const row = this.rows.get(InMemoryAttachmentMeta.key(companyId, attachmentId));
    if (!row || row.deletedAt !== null || row.record.companyId !== companyId) return null;
    return { ...row.record };
  }

  async markDeleted(companyId: string, attachmentId: string, at: Date): Promise<boolean> {
    const row = this.rows.get(InMemoryAttachmentMeta.key(companyId, attachmentId));
    if (!row || row.deletedAt !== null) return false;
    row.deletedAt = at;
    return true;
  }
}

export class InMemoryBlobStore implements AttachmentBlobStore {
  private readonly blobs = new Map<string, Uint8Array>();

  /** Keys seen by write(), in order. Tests use this to check what reached the store. */
  readonly writtenKeys: string[] = [];

  async write(key: string, bytes: Uint8Array): Promise<void> {
    this.blobs.set(key, new Uint8Array(bytes));
    this.writtenKeys.push(key);
  }

  async read(key: string): Promise<Uint8Array | null> {
    const bytes = this.blobs.get(key);
    return bytes ? new Uint8Array(bytes) : null;
  }

  async remove(key: string): Promise<void> {
    this.blobs.delete(key);
  }

  has(key: string): boolean {
    return this.blobs.has(key);
  }
}
