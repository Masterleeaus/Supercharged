/**
 * Per-company connector state the admin view reads (#353): paused flag, last success, last error and error
 * count. The memory store is for tests; a database store implements the same interface. Pure.
 */
export interface ConnectorState {
  paused: boolean;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  errorCount: number;
}

export const EMPTY_STATE: ConnectorState = { paused: false, lastSuccessAt: null, lastErrorCode: null, errorCount: 0 };

export interface ConnectorStateStore {
  get(companyId: string, connectorId: string): Promise<ConnectorState>;
  update(companyId: string, connectorId: string, change: (current: ConnectorState) => ConnectorState): Promise<ConnectorState>;
  clear(companyId: string, connectorId: string): Promise<void>;
}

export function createMemoryStateStore(): ConnectorStateStore {
  const rows = new Map<string, ConnectorState>();
  const key = (c: string, id: string) => `${c}\u0000${id}`;
  return {
    async get(c, id) {
      return { ...(rows.get(key(c, id)) ?? EMPTY_STATE) };
    },
    async update(c, id, change) {
      const next = change({ ...(rows.get(key(c, id)) ?? EMPTY_STATE) });
      rows.set(key(c, id), next);
      return { ...next };
    },
    async clear(c, id) {
      rows.delete(key(c, id));
    },
  };
}
