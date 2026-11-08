import type { StorageAdapter, WizardDraft } from './types';

export class WizardDraftStore {
  public constructor(private readonly store: StorageAdapter<WizardDraft>) {}

  async save(draft: WizardDraft): Promise<void> {
    const now = new Date().toISOString();
    await this.store.put(draft.id, { ...draft, updatedAt: now });
  }

  async load(id: string): Promise<WizardDraft | undefined> {
    return this.store.get(id);
  }

  async pending(): Promise<WizardDraft[]> {
    return (await this.store.all()).filter((draft) => draft.syncStatus !== 'synced');
  }

  async remove(id: string): Promise<void> {
    await this.store.delete(id);
  }
}
