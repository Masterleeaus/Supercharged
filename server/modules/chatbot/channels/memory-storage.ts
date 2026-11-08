/**
 * In-memory ChannelAccountStorage. For tests and local wiring only. Rows are keyed by company as well as account,
 * so a lookup under another company finds nothing.
 */
import type { ChannelKind } from "../contracts/index.ts";
import type { StoredSealed } from "../secrets/sealed-form.ts";
import type { ChannelAccountStorage } from "./credentials.ts";

export function createMemoryChannelAccountStorage(): ChannelAccountStorage & { size(): number } {
  const rows = new Map<string, StoredSealed>();
  const key = (companyId: string, kind: ChannelKind, accountId: string) => `${companyId}\u0000${kind}\u0000${accountId}`;

  return {
    async findSealed(companyId, kind, accountId) {
      return rows.get(key(companyId, kind, accountId)) ?? null;
    },
    async saveSealed(companyId, kind, accountId, sealed) {
      rows.set(key(companyId, kind, accountId), sealed);
    },
    size() {
      return rows.size;
    },
  };
}
