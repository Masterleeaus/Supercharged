import type { StorageAdapter } from './types';

export class MemoryStore<T> implements StorageAdapter<T> {
  private readonly values = new Map<string, T>();

  async put(id: string, value: T): Promise<void> {
    this.values.set(id, structuredClone(value));
  }

  async get(id: string): Promise<T | undefined> {
    const value = this.values.get(id);
    return value === undefined ? undefined : structuredClone(value);
  }

  async all(): Promise<T[]> {
    return Array.from(this.values.values(), (value) => structuredClone(value));
  }

  async delete(id: string): Promise<void> {
    this.values.delete(id);
  }
}
