/**
 * Per-company credential vault (#351). Connector credentials are sealed with the existing SecretBox
 * (server/modules/chatbot/secrets/secret-box.ts): AES-256-GCM, key versions in the stored prefix, and
 * the company and connector bound as associated data, so a row cannot be opened for another company
 * or another connector.
 *
 * Rotation: a row sealed under an older key version still opens while that key is in the keyring.
 * rotate() re-seals it under the current version. Nothing is re-encrypted in bulk.
 *
 * Never logs or returns sealed bytes or plaintext outside load(). Errors are generic.
 */
import type { SecretBox } from '../../modules/chatbot/secrets/secret-box.ts';
import { ConnectorError } from '../sdk/contract.ts';

export type StoredCredentials =
  | { type: 'oauth2'; accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string; tokenType?: string }
  | { type: 'api_key'; apiKey: string };

export interface CredentialRow {
  companyId: string;
  connectorId: string;
  sealed: string;
  keyVersion: string;
  savedAt: number;
}

export interface CredentialStore {
  get(companyId: string, connectorId: string): Promise<CredentialRow | null>;
  put(row: CredentialRow): Promise<void>;
  remove(companyId: string, connectorId: string): Promise<void>;
}

export function createMemoryCredentialStore(): CredentialStore {
  const rows = new Map<string, CredentialRow>();
  const key = (c: string, id: string) => `${c}\u0000${id}`;
  return {
    async get(c, id) {
      const row = rows.get(key(c, id));
      return row ? { ...row } : null;
    },
    async put(row) {
      rows.set(key(row.companyId, row.connectorId), { ...row });
    },
    async remove(c, id) {
      rows.delete(key(c, id));
    },
  };
}

const GENERIC_OPEN_FAILURE = 'stored connector credentials could not be opened';

/** Binds the company and connector into the sealed value. */
export function associatedData(companyId: string, connectorId: string): string {
  return `${companyId}|${connectorId}`;
}

export function validateCredentials(value: unknown): value is StoredCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.type === 'api_key') return typeof v.apiKey === 'string' && v.apiKey.length > 0;
  if (v.type === 'oauth2') {
    return (
      typeof v.accessToken === 'string' &&
      v.accessToken.length > 0 &&
      (v.refreshToken === undefined || typeof v.refreshToken === 'string') &&
      (v.expiresAt === undefined || typeof v.expiresAt === 'number')
    );
  }
  return false;
}

export class CredentialVault {
  constructor(
    private readonly box: SecretBox,
    private readonly store: CredentialStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The key version new seals use, read from a probe seal so the SecretBox interface does not change. */
  currentKeyVersion(): string {
    return this.box.sealString('probe').split(':')[0];
  }

  async save(companyId: string, connectorId: string, credentials: StoredCredentials): Promise<void> {
    requireIds(companyId, connectorId);
    if (!validateCredentials(credentials)) throw new ConnectorError('validation', 'credentials have an invalid shape');
    const sealed = this.box.sealString(JSON.stringify(credentials), associatedData(companyId, connectorId));
    await this.store.put({
      companyId,
      connectorId,
      sealed,
      keyVersion: sealed.split(':')[0],
      savedAt: this.now(),
    });
  }

  /** Returns null when the company has not connected this connector. Fails closed on any open problem. */
  async load(companyId: string, connectorId: string): Promise<StoredCredentials | null> {
    requireIds(companyId, connectorId);
    const row = await this.store.get(companyId, connectorId);
    if (!row) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.box.openString(row.sealed, associatedData(companyId, connectorId)));
    } catch {
      throw new ConnectorError('auth', GENERIC_OPEN_FAILURE);
    }
    if (!validateCredentials(parsed)) throw new ConnectorError('auth', GENERIC_OPEN_FAILURE);
    return parsed;
  }

  async needsRotation(companyId: string, connectorId: string): Promise<boolean> {
    const row = await this.store.get(companyId, connectorId);
    return row !== null && row.keyVersion !== this.currentKeyVersion();
  }

  /** Re-seals the stored credentials under the current key version. */
  async rotate(companyId: string, connectorId: string): Promise<boolean> {
    const credentials = await this.load(companyId, connectorId);
    if (!credentials) return false;
    await this.save(companyId, connectorId, credentials);
    return true;
  }

  async remove(companyId: string, connectorId: string): Promise<void> {
    requireIds(companyId, connectorId);
    await this.store.remove(companyId, connectorId);
  }
}

function requireIds(companyId: string, connectorId: string): void {
  if (typeof companyId !== 'string' || companyId.length === 0 || typeof connectorId !== 'string' || connectorId.length === 0) {
    throw new ConnectorError('validation', 'companyId and connectorId are required');
  }
}
