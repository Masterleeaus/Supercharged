import type { StorageAdapter } from './types';

export class IndexedDbStore<T> implements StorageAdapter<T> {
  private readonly database: Promise<IDBDatabase>;

  public constructor(
    databaseName = 'titan-zero-interaction',
    private readonly storeName = 'records',
    version = 1,
  ) {
    this.database = this.open(databaseName, version);
  }

  async put(id: string, value: T): Promise<void> {
    await this.request('readwrite', (store) => store.put(value, id));
  }

  async get(id: string): Promise<T | undefined> {
    return this.request<T | undefined>('readonly', (store) => store.get(id));
  }

  async all(): Promise<T[]> {
    return this.request<T[]>('readonly', (store) => store.getAll());
  }

  async delete(id: string): Promise<void> {
    await this.request('readwrite', (store) => store.delete(id));
  }

  private open(databaseName: string, version: number): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, version);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(this.storeName)) database.createObjectStore(this.storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
    });
  }

  private async request<R = void>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<R> {
    const database = await this.database;
    return new Promise<R>((resolve, reject) => {
      const transaction = database.transaction(this.storeName, mode);
      const request = operation(transaction.objectStore(this.storeName));
      request.onsuccess = () => resolve(request.result as R);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB operation failed.'));
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    });
  }
}
